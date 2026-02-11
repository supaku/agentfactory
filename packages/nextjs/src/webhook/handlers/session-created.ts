/**
 * Handle agent session 'create' events — new session initiated.
 */

import { NextResponse } from 'next/server'
import type { LinearWebhookPayload, AgentWorkType } from '@supaku/agentfactory-linear'
import {
  TERMINAL_STATUSES,
  validateWorkTypeForStatus,
  WORK_TYPE_ALLOWED_STATUSES,
  STATUS_WORK_TYPE_MAP,
  getValidWorkTypesForStatus,
} from '@supaku/agentfactory-linear'
import {
  generateIdempotencyKey,
  isWebhookProcessed,
  storeSessionState,
  getSessionState,
  updateSessionStatus,
  dispatchWork,
  type QueuedWork,
} from '@supaku/agentfactory-server'
import type { ResolvedWebhookConfig } from '../../types.js'
import {
  emitActivity,
  determineWorkType,
  getAppUrl,
  getPriority,
  WORK_TYPE_MESSAGES,
} from '../utils.js'
import type { createLogger } from '@supaku/agentfactory-server'

export async function handleSessionCreated(
  config: ResolvedWebhookConfig,
  payload: LinearWebhookPayload,
  rawPayload: Record<string, unknown>,
  log: ReturnType<typeof createLogger>
): Promise<NextResponse | null> {
  const agentSession = rawPayload.agentSession as Record<string, unknown>

  log.debug('AgentSessionEvent payload structure', {
    payloadKeys: Object.keys(rawPayload),
    agentSessionKeys: agentSession ? Object.keys(agentSession) : [],
    hasAgentSession: !!agentSession,
  })

  if (!agentSession) {
    log.error('AgentSessionEvent missing agentSession field', {
      payloadKeys: Object.keys(rawPayload),
    })
    return NextResponse.json(
      { error: 'Missing agentSession in webhook payload', success: false },
      { status: 400 }
    )
  }

  const sessionId = agentSession.id as string
  const issue = agentSession.issue as Record<string, unknown> | undefined
  const issueId = (agentSession.issueId as string) || issue?.id as string
  const webhookId = rawPayload.webhookId as string
  const agentId = agentSession.agentId as string | undefined

  if (!sessionId || !issueId) {
    log.error('Missing sessionId or issueId in webhook payload', {
      sessionId,
      issueId,
      agentSessionKeys: Object.keys(agentSession),
    })
    return NextResponse.json(
      { error: 'Invalid payload structure', success: false },
      { status: 400 }
    )
  }

  const sessionLog = log.child({ sessionId, issueId })

  const promptContext = rawPayload.promptContext as string | undefined
  const user = rawPayload.user as Record<string, unknown> | undefined
  const comment = rawPayload.comment as Record<string, unknown> | undefined

  const isMention = !!comment
  const initiationType = isMention ? 'mention' : 'delegation'

  sessionLog.info('Agent session created', {
    initiationType,
    isMention,
    hasPromptContext: !!promptContext,
    promptContextLength: promptContext?.length,
    userName: user?.name,
  })

  // Idempotency check
  const idempotencyKey = generateIdempotencyKey(webhookId, sessionId)

  if (await isWebhookProcessed(idempotencyKey)) {
    sessionLog.info('Duplicate webhook ignored', { idempotencyKey })
    return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_webhook' })
  }

  const existingSession = await getSessionState(sessionId)
  if (existingSession) {
    sessionLog.info('Session already exists', { status: existingSession.status })
    return NextResponse.json({ success: true, skipped: true, reason: 'session_already_exists' })
  }

  const issueIdentifier = (issue?.identifier as string) || issueId.slice(0, 8)

  // Determine work type
  let workType: AgentWorkType = 'development'
  let currentStatus: string | undefined
  let projectName: string | undefined
  let workTypeSource: 'mention' | 'status' = 'status'

  // Fetch current issue status
  try {
    const linearClient = await config.linearClient.getClient(payload.organizationId)
    const issueDetails = await linearClient.getIssue(issueId)
    const currentState = await issueDetails.state
    currentStatus = currentState?.name
    sessionLog.debug('Fetched current issue status', { currentStatus })

    // Extract project name for routing
    const project = await issueDetails.project
    projectName = project?.name
  } catch (err) {
    sessionLog.warn('Failed to fetch issue status', { error: err })
  }

  // Phase 1: Mention-based routing
  if (isMention && promptContext && config.detectWorkTypeFromPrompt) {
    // For mentions: unconstrained detection (pass all work types)
    const allWorkTypes: AgentWorkType[] = [
      'coordination', 'backlog-creation', 'research', 'qa', 'inflight',
      'acceptance', 'refinement', 'development', 'qa-coordination', 'acceptance-coordination',
    ]
    const mentionWorkType = config.detectWorkTypeFromPrompt(promptContext, allWorkTypes)
    if (mentionWorkType) {
      workType = mentionWorkType
      workTypeSource = 'mention'
      sessionLog.info('Detected work type from mention prompt', {
        workType,
        currentStatus,
        promptPreview: promptContext.substring(0, 50),
      })
    }
  }

  // For non-mentions or when mention detection failed: constrained detection
  if (workTypeSource === 'status' && promptContext && currentStatus && config.detectWorkTypeFromPrompt) {
    const validWorkTypes = getValidWorkTypesForStatus(currentStatus)
    const constrainedWorkType = config.detectWorkTypeFromPrompt(promptContext, validWorkTypes)

    if (constrainedWorkType) {
      workType = constrainedWorkType
      workTypeSource = 'mention'
      sessionLog.info('Detected work type from promptContext (constrained)', {
        workType,
        currentStatus,
        validWorkTypes,
      })
    }
  }

  // Phase 2: Fall back to status-based routing
  if (workTypeSource === 'status') {
    workType = determineWorkType(currentStatus)
    sessionLog.info('Detected work type from issue status', {
      currentStatus,
      workType,
    })
  }

  // Phase 2.5: Auto-detect parent issues for coordination
  if (workType === 'development' && workTypeSource === 'status') {
    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      const isParent = await linearClient.isParentIssue(issueId)
      if (isParent) {
        workType = 'coordination'
        sessionLog.info('Parent issue detected, switching to coordination work type', {
          issueIdentifier,
        })
      }
    } catch (err) {
      sessionLog.warn('Failed to check if issue is parent', { error: err })
    }
  }

  // Check terminal state
  if (currentStatus && TERMINAL_STATUSES.includes(currentStatus as typeof TERMINAL_STATUSES[number])) {
    sessionLog.info('Issue in terminal state, acknowledging mention', { currentStatus })

    try {
      const linearClient = await config.linearClient.getClient(payload.organizationId)
      await emitActivity(
        linearClient,
        sessionId,
        'response',
        `This issue is in **${currentStatus}** status and has been completed. No further agent work is needed.\n\n` +
        `If you need additional help, please create a new issue or reopen this one by moving it back to an active status.`
      )
    } catch (err) {
      sessionLog.error('Failed to emit terminal state response', { error: err })
    }

    return NextResponse.json({ success: true, skipped: true, reason: 'terminal_state', currentStatus })
  }

  // Validate work type for status
  if (currentStatus) {
    const validation = validateWorkTypeForStatus(workType, currentStatus)
    if (!validation.valid) {
      sessionLog.warn('Work type validation failed', { workType, currentStatus, error: validation.error })

      try {
        const linearClient = await config.linearClient.getClient(payload.organizationId)
        const allowedStatuses = WORK_TYPE_ALLOWED_STATUSES[workType]
        const expectedWorkType = STATUS_WORK_TYPE_MAP[currentStatus]

        await emitActivity(
          linearClient,
          sessionId,
          'error',
          `Cannot perform ${workType} work on this issue.\n\n` +
          `**Current status:** ${currentStatus}\n` +
          `**${workType} requires status:** ${allowedStatuses.join(' or ')}\n\n` +
          (expectedWorkType
            ? `For issues in ${currentStatus} status, use ${expectedWorkType} commands instead.`
            : `This issue's status (${currentStatus}) is not handled by the agent.`)
        )
      } catch (err) {
        sessionLog.error('Failed to emit validation error activity', { error: err })
      }

      return NextResponse.json({
        success: false,
        error: 'work_type_invalid_for_status',
        message: validation.error,
      })
    }
  }

  const priority = getPriority(config, workType)

  await storeSessionState(sessionId, {
    issueId,
    issueIdentifier,
    claudeSessionId: null,
    worktreePath: '',
    status: 'pending',
    queuedAt: Date.now(),
    promptContext: promptContext,
    priority,
    organizationId: payload.organizationId,
    workType,
    agentId,
    projectName,
  })

  // Queue work
  const work: QueuedWork = {
    sessionId,
    issueId,
    issueIdentifier,
    priority,
    queuedAt: Date.now(),
    workType,
    prompt: config.generatePrompt(issueIdentifier, workType, promptContext),
    projectName,
  }

  const result = await dispatchWork(work)

  if (result.dispatched || result.parked) {
    sessionLog.info('Work dispatched', {
      sessionId,
      issueIdentifier,
      workType,
      dispatched: result.dispatched,
      parked: result.parked,
      replaced: result.replaced,
    })
  } else {
    sessionLog.error('Failed to dispatch work')
    await updateSessionStatus(sessionId, 'failed')
  }

  // Update session with externalUrl and acknowledge
  try {
    const linearClient = await config.linearClient.getClient(payload.organizationId)
    const appUrl = getAppUrl(config)

    await linearClient.updateAgentSession({
      sessionId,
      externalUrls: [
        {
          label: 'Agent Dashboard',
          url: `${appUrl}/sessions/${sessionId}`,
        },
      ],
    })

    const activityText = WORK_TYPE_MESSAGES[workType]
    await emitActivity(linearClient, sessionId, 'thought', activityText)
    sessionLog.debug('Session updated and activity emitted')
  } catch (err) {
    sessionLog.error('Failed to update session or create comment', { error: err })
  }

  return null // Continue processing
}
