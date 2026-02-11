/**
 * Handle agent session 'prompted' events — follow-up messages or stop/continue signals.
 */

import { NextResponse } from 'next/server'
import type { LinearWebhookPayload, AgentWorkType } from '@supaku/agentfactory-linear'
import {
  getSessionState,
  updateSessionStatus,
  storeSessionState,
  releaseClaim,
  removeWorkerSession,
  dispatchWork,
  type QueuedWork,
  storePendingPrompt,
  generateIdempotencyKey,
  isWebhookProcessed,
} from '@supaku/agentfactory-server'
import type { ResolvedWebhookConfig } from '../../types.js'
import { handleStopSignal, emitActivity } from '../utils.js'
import type { createLogger } from '@supaku/agentfactory-server'

export async function handleSessionPrompted(
  config: ResolvedWebhookConfig,
  payload: LinearWebhookPayload,
  rawPayload: Record<string, unknown>,
  log: ReturnType<typeof createLogger>
): Promise<NextResponse | null> {
  const agentSession = rawPayload.agentSession as Record<string, unknown>

  if (!agentSession) {
    log.warn('AgentSessionEvent prompted missing agentSession field')
    return NextResponse.json({ success: true, skipped: true, reason: 'missing_agent_session' })
  }

  const sessionId = agentSession.id as string
  const issue = agentSession.issue as Record<string, unknown> | undefined
  const issueId = (agentSession.issueId as string) || issue?.id as string
  const promptText = (rawPayload.promptContext as string) || ''
  const webhookId = rawPayload.webhookId as string
  const user = rawPayload.user as Record<string, unknown> | undefined
  const agentActivity = rawPayload.agentActivity as Record<string, unknown> | undefined
  const comment = rawPayload.comment as Record<string, unknown> | undefined
  const commentBody = (comment?.body as string) || ''

  const promptLog = log.child({ sessionId, issueId })

  // Check for stop/continue signals
  const activitySignal = agentActivity?.signal as string | undefined
  const isStopSignal = activitySignal === 'stop'
  const isContinueSignal = activitySignal === 'continue'

  promptLog.info('Agent session prompted', {
    hasPromptContext: !!promptText,
    promptContextLength: promptText?.length,
    userName: user?.name,
    hasAgentActivity: !!agentActivity,
    activitySignal,
    isStopSignal,
    isContinueSignal,
    hasComment: !!comment,
    commentBodyLength: commentBody?.length,
  })

  // Handle stop signal
  if (isStopSignal) {
    promptLog.info('Stop signal received via prompted webhook')
    await handleStopSignal(config, sessionId, issueId, payload.organizationId)
    return NextResponse.json({ success: true, action: 'stopped', sessionId })
  }

  // Handle continue signal
  if (isContinueSignal) {
    promptLog.info('Continue signal received via prompted webhook')

    const existingSession = await getSessionState(sessionId)
    const workType: AgentWorkType = existingSession?.workType || 'inflight'
    let resumePrompt = promptText || commentBody || ''

    const issueIdentifier =
      existingSession?.issueIdentifier ||
      (issue?.identifier as string) ||
      issueId.slice(0, 8)

    promptLog.info('Session state for continue', {
      hasExistingSession: !!existingSession,
      sessionStatus: existingSession?.status,
      workType,
    })

    if (!resumePrompt.trim()) {
      resumePrompt = config.generatePrompt(issueIdentifier, workType)
    }

    // Reset session status if in terminal state
    if (existingSession && ['completed', 'failed', 'stopped'].includes(existingSession.status)) {
      await releaseClaim(sessionId)
      if (existingSession.workerId) {
        await removeWorkerSession(existingSession.workerId, sessionId)
      }
      await updateSessionStatus(sessionId, 'pending')
    }

    // Update organizationId if missing
    if (existingSession && !existingSession.organizationId && payload.organizationId) {
      await storeSessionState(sessionId, {
        ...existingSession,
        organizationId: payload.organizationId,
        status: 'pending',
      })
    }

    // Queue work to resume
    const work: QueuedWork = {
      sessionId,
      issueId,
      issueIdentifier,
      priority: 2,
      queuedAt: Date.now(),
      prompt: resumePrompt,
      claudeSessionId: existingSession?.claudeSessionId || undefined,
      workType,
    }

    await dispatchWork(work)

    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      await emitActivity(
        linearClient,
        sessionId,
        'thought',
        'Session resume requested. Waiting for an available worker...'
      )
    } catch (err) {
      promptLog.error('Failed to emit continue acknowledgment activity', { error: err })
    }

    return NextResponse.json({ success: true, action: 'continue_queued', sessionId })
  }

  // Generate idempotency key for prompted events
  const idempotencyKey = generateIdempotencyKey(
    webhookId,
    `${sessionId}:prompt:${payload.createdAt}`
  )

  if (await isWebhookProcessed(idempotencyKey)) {
    promptLog.info('Duplicate prompted webhook ignored', { idempotencyKey })
    return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_prompt' })
  }

  const existingSession = await getSessionState(sessionId)
  const issueIdentifier =
    existingSession?.issueIdentifier ||
    (issue?.identifier as string) ||
    issueId.slice(0, 8)

  // Determine effective prompt with cascading fallbacks
  let effectivePrompt = promptText.trim()

  if (!effectivePrompt && commentBody.trim()) {
    effectivePrompt = commentBody.trim()
    promptLog.info('Using comment body as prompt fallback')
  }

  if (!effectivePrompt) {
    if (existingSession) {
      effectivePrompt = config.generatePrompt(
        issueIdentifier,
        existingSession.workType || 'inflight'
      )
      promptLog.info('Generated continue prompt for empty prompt')
    } else {
      promptLog.warn('Empty prompt with no existing session, skipping')
      return NextResponse.json({ success: true, skipped: true, reason: 'empty_prompt_no_session' })
    }
  }

  // If session is running, store as pending prompt
  if (existingSession?.status === 'running' || existingSession?.status === 'claimed') {
    const userInfo = user ? {
      id: user.id as string | undefined,
      name: user.name as string | undefined,
    } : undefined

    const pendingPrompt = await storePendingPrompt(
      sessionId,
      issueId,
      effectivePrompt,
      userInfo
    )

    if (pendingPrompt) {
      promptLog.info('Pending prompt stored for running session', {
        promptId: pendingPrompt.id,
        sessionId,
        issueIdentifier,
        workerId: existingSession.workerId,
      })
    } else {
      promptLog.error('Failed to store pending prompt')
    }
  } else {
    // Session not running — queue as work
    promptLog.info('Queuing follow-up for non-running session', {
      sessionStatus: existingSession?.status,
    })

    if (existingSession && ['completed', 'failed', 'stopped'].includes(existingSession.status)) {
      await releaseClaim(sessionId)
      if (existingSession.workerId) {
        await removeWorkerSession(existingSession.workerId, sessionId)
      }
      await updateSessionStatus(sessionId, 'pending')
    }

    if (existingSession && !existingSession.organizationId && payload.organizationId) {
      await storeSessionState(sessionId, {
        ...existingSession,
        organizationId: payload.organizationId,
        status: 'pending',
      })
    }

    const work: QueuedWork = {
      sessionId,
      issueId,
      issueIdentifier,
      priority: 2,
      queuedAt: Date.now(),
      prompt: effectivePrompt,
      claudeSessionId: existingSession?.claudeSessionId || undefined,
      workType: existingSession?.workType || 'inflight',
    }

    const dispatchResult = await dispatchWork(work)

    if (dispatchResult.dispatched || dispatchResult.parked) {
      promptLog.info('Follow-up prompt dispatched', {
        sessionId,
        issueIdentifier,
        dispatched: dispatchResult.dispatched,
        parked: dispatchResult.parked,
      })
    } else {
      promptLog.error('Failed to dispatch follow-up prompt')
    }
  }

  // Acknowledge prompt receipt
  try {
    const linearClient = await config.linearClient.getClient(payload.organizationId)
    const truncatedPrompt =
      effectivePrompt.length > 100
        ? `${effectivePrompt.substring(0, 100)}...`
        : effectivePrompt

    await emitActivity(
      linearClient,
      sessionId,
      'thought',
      `Follow-up received: "${truncatedPrompt}" - Processing...`
    )
  } catch (err) {
    promptLog.error('Failed to emit prompt acknowledgment activity', { error: err })
  }

  return null // Continue processing
}
