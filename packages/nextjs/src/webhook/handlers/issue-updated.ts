/**
 * Handle Issue update events — status transition triggers.
 *
 * Handles:
 * - Finished → auto-QA trigger
 * - Icebox → Backlog → auto-development trigger
 * - Finished → Delivered → auto-acceptance trigger
 */

import { NextResponse } from 'next/server'
import type { LinearWebhookPayload, AgentWorkType } from '@supaku/agentfactory-linear'
import {
  checkIssueDeploymentStatus,
  formatFailedDeployments,
} from '@supaku/agentfactory'
import {
  generateIdempotencyKey,
  isWebhookProcessed,
  storeSessionState,
  getSessionStateByIssue,
  dispatchWork,
  type QueuedWork,
  wasAgentWorked,
  didJustFailQA,
  getQAAttemptCount,
  recordQAAttempt,
  clearQAFailed,
  didJustQueueDevelopment,
  markDevelopmentQueued,
  didJustQueueAcceptance,
  markAcceptanceQueued,
} from '@supaku/agentfactory-server'
import type { WebhookConfig } from '../../types'
import {
  emitActivity,
  resolveStateName,
  isProjectAllowed,
  hasExcludedLabel,
  getAppUrl,
} from '../utils'
import type { createLogger } from '@supaku/agentfactory-server'

export async function handleIssueUpdated(
  config: WebhookConfig,
  payload: LinearWebhookPayload,
  log: ReturnType<typeof createLogger>
): Promise<NextResponse | null> {
  const { data, updatedFrom, actor } = payload as unknown as {
    data: Record<string, unknown>
    updatedFrom?: Record<string, unknown>
    actor?: Record<string, unknown>
  }

  const issueId = data.id as string
  const issueIdentifier = data.identifier as string
  const currentStateName = (data.state as Record<string, unknown> | undefined)?.name as string | undefined
  const webhookId = (payload as unknown as Record<string, unknown>).webhookId as string

  const issueLog = log.child({ issueId, issueIdentifier })

  const autoTrigger = config.autoTrigger

  // === Handle Finished transition (auto-QA) ===
  if (currentStateName === 'Finished' && updatedFrom?.stateId) {
    issueLog.info('Issue transitioned to Finished', {
      previousStateId: updatedFrom.stateId,
      currentState: currentStateName,
      actorName: actor?.name,
    })

    // Skip QA for sub-issues
    let isChild = !!(data.parent)
    if (!isChild) {
      try {
        const checkClient = await config.linearClient.getClient(payload.organizationId)
        isChild = await checkClient.isChildIssue(issueId)
      } catch (err) {
        issueLog.warn('Failed to check if issue is a child', { error: err })
      }
    }

    if (isChild) {
      issueLog.info('Sub-issue detected, skipping individual QA trigger')
      return NextResponse.json({ success: true, skipped: true, reason: 'sub_issue_skipped' })
    }

    if (!autoTrigger?.enableAutoQA) {
      issueLog.debug('Auto-QA disabled, skipping QA trigger')
      return NextResponse.json({ success: true, skipped: true, reason: 'auto_qa_disabled' })
    }

    const projectName = (data.project as Record<string, unknown> | undefined)?.name as string | undefined
    if (!isProjectAllowed(projectName, autoTrigger.autoQAProjects)) {
      issueLog.debug('Project not in auto-QA list, skipping', { projectName })
      return NextResponse.json({ success: true, skipped: true, reason: 'project_not_allowed' })
    }

    const labels = data.labels as Array<{ name: string }> | undefined
    if (hasExcludedLabel(labels, autoTrigger.autoQAExcludeLabels)) {
      issueLog.debug('Issue has excluded label, skipping QA trigger')
      return NextResponse.json({ success: true, skipped: true, reason: 'excluded_label' })
    }

    if (autoTrigger.autoQARequireAgentWorked) {
      const workRecord = await wasAgentWorked(issueId)
      if (!workRecord) {
        issueLog.debug('Issue not worked by agent, skipping QA trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'not_agent_worked' })
      }
    }

    const justFailed = await didJustFailQA(issueId)
    if (justFailed) {
      issueLog.info('Issue in QA cooldown period, skipping')
      return NextResponse.json({ success: true, skipped: true, reason: 'qa_cooldown' })
    }

    const attemptCount = await getQAAttemptCount(issueId)
    if (attemptCount >= 3) {
      issueLog.warn('QA attempt limit reached', { attemptCount })
      try {
        const linearClient = await config.linearClient.getClient(payload.organizationId)
        await linearClient.createComment(
          issueId,
          `## QA Limit Reached\n\nThis issue has failed automated QA ${attemptCount} times. Manual review is required.\n\nPlease review the previous QA failures and address the underlying issues before requesting another automated QA pass.`
        )
      } catch (err) {
        issueLog.error('Failed to post QA limit comment', { error: err })
      }
      return NextResponse.json({ success: true, skipped: true, reason: 'qa_limit_reached' })
    }

    const idempotencyKey = generateIdempotencyKey(webhookId, `qa:${issueId}:${Date.now()}`)
    if (await isWebhookProcessed(idempotencyKey)) {
      issueLog.info('Duplicate QA trigger ignored', { idempotencyKey })
      return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_qa_trigger' })
    }

    // Check deployment status before QA
    try {
      const deploymentResult = await checkIssueDeploymentStatus(issueIdentifier)

      if (deploymentResult?.anyFailed) {
        issueLog.info('Deployment failed, blocking QA', {
          commitSha: deploymentResult.commitSha,
        })

        const linearClient = await config.linearClient.getClient(payload.organizationId)
        await linearClient.createComment(
          issueId,
          `## QA Blocked: Deployment Failed\n\n` +
          `Cannot proceed with QA until Vercel deployment succeeds.\n\n` +
          formatFailedDeployments(deploymentResult) +
          `\n\n**PR:** ${deploymentResult.pr.url}\n` +
          `**Commit:** \`${deploymentResult.commitSha.slice(0, 7)}\`\n\n` +
          `Please fix the deployment issues and move the issue back to Finished to retry QA.`
        )

        return NextResponse.json({ success: true, skipped: true, reason: 'deployment_failed' })
      }
    } catch (err) {
      issueLog.warn('Deployment check failed, proceeding with QA', { error: err })
    }

    await clearQAFailed(issueId)

    const linearClient = await config.linearClient.getClient(payload.organizationId)

    // Detect parent issues → qa-coordination
    let qaWorkType: AgentWorkType = 'qa'
    let qaPrompt = `QA ${issueIdentifier}`
    try {
      const isParent = await linearClient.isParentIssue(issueId)
      if (isParent) {
        qaWorkType = 'qa-coordination'
        qaPrompt = config.generatePrompt(issueIdentifier, 'qa-coordination')
        issueLog.info('Parent issue detected, using qa-coordination work type')
      }
    } catch (err) {
      issueLog.warn('Failed to detect parent issue for QA routing', { error: err })
    }

    // Create Linear AgentSession for QA
    let qaSessionId: string
    try {
      const appUrl = getAppUrl(config)
      const sessionResult = await linearClient.createAgentSessionOnIssue({
        issueId,
        externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/pending` }],
      })

      if (!sessionResult.success || !sessionResult.sessionId) {
        issueLog.error('Failed to create Linear AgentSession for QA', { sessionResult })
        return NextResponse.json({ success: false, error: 'Failed to create agent session for QA' })
      }

      qaSessionId = sessionResult.sessionId
      issueLog.info('Linear AgentSession created for QA', { sessionId: qaSessionId })
    } catch (err) {
      issueLog.error('Error creating Linear AgentSession for QA', { error: err })
      return NextResponse.json({ success: false, error: 'Error creating agent session for QA' })
    }

    await recordQAAttempt(issueId, qaSessionId)

    await storeSessionState(qaSessionId, {
      issueId,
      issueIdentifier,
      claudeSessionId: null,
      worktreePath: '',
      status: 'pending',
      queuedAt: Date.now(),
      promptContext: qaPrompt,
      priority: 2,
      organizationId: payload.organizationId,
      workType: qaWorkType,
    })

    const qaWork: QueuedWork = {
      sessionId: qaSessionId,
      issueId,
      issueIdentifier,
      priority: 2,
      queuedAt: Date.now(),
      prompt: qaPrompt,
      workType: qaWorkType,
    }

    const qaResult = await dispatchWork(qaWork)

    if (qaResult.dispatched || qaResult.parked) {
      issueLog.info('QA work dispatched', {
        sessionId: qaSessionId,
        attemptNumber: attemptCount + 1,
      })

      try {
        const appUrl = getAppUrl(config)
        await linearClient.updateAgentSession({
          sessionId: qaSessionId,
          externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/${qaSessionId}` }],
        })
      } catch (err) {
        issueLog.warn('Failed to update QA session externalUrl', { error: err })
      }

      try {
        await emitActivity(linearClient, qaSessionId, 'thought', `QA work queued (attempt #${attemptCount + 1}). Waiting for an available worker...`)
      } catch (err) {
        issueLog.warn('Failed to emit QA queued activity', { error: err })
      }

      try {
        await linearClient.createComment(
          issueId,
          `## Automated QA Started\n\nQA attempt #${attemptCount + 1} has been queued.\n\nThe QA agent will:\n1. Checkout the PR branch\n2. Run tests and validation\n3. Verify implementation against requirements\n4. Update status to Delivered (pass) or Backlog (fail)`
        )
      } catch (err) {
        issueLog.error('Failed to post QA start comment', { error: err })
      }
    } else {
      issueLog.error('Failed to queue QA work')
    }
  }

  // === Handle Icebox → Backlog transition (auto-development) ===
  if (currentStateName === 'Backlog' && updatedFrom?.stateId) {
    const previousStateName = await resolveStateName(
      config,
      payload.organizationId,
      issueId,
      updatedFrom.stateId as string
    )

    if (previousStateName !== 'Icebox') {
      issueLog.debug('Issue transitioned to Backlog but not from Icebox', { previousStateName })
    } else {
      issueLog.info('Issue transitioned from Icebox to Backlog', {
        previousStateName,
        actorName: actor?.name,
      })

      const existingSession = await getSessionStateByIssue(issueId)
      if (existingSession && ['running', 'claimed', 'pending'].includes(existingSession.status)) {
        issueLog.info('Session already active, skipping development trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'session_already_active' })
      }

      if (await didJustQueueDevelopment(issueId)) {
        issueLog.info('Issue in development cooldown period, skipping')
        return NextResponse.json({ success: true, skipped: true, reason: 'development_cooldown' })
      }

      const idempotencyKey = generateIdempotencyKey(webhookId, `dev:${issueId}:${Date.now()}`)
      if (await isWebhookProcessed(idempotencyKey)) {
        issueLog.info('Duplicate development trigger ignored', { idempotencyKey })
        return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_dev_trigger' })
      }

      const linearClient = await config.linearClient.getClient(payload.organizationId)

      let devSessionId: string
      try {
        const appUrl = getAppUrl(config)
        const sessionResult = await linearClient.createAgentSessionOnIssue({
          issueId,
          externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/pending` }],
        })

        if (!sessionResult.success || !sessionResult.sessionId) {
          issueLog.error('Failed to create Linear AgentSession', { sessionResult })
          return NextResponse.json({ success: false, error: 'Failed to create agent session' })
        }

        devSessionId = sessionResult.sessionId
        issueLog.info('Linear AgentSession created', { sessionId: devSessionId })
      } catch (err) {
        issueLog.error('Error creating Linear AgentSession', { error: err })
        return NextResponse.json({ success: false, error: 'Error creating agent session' })
      }

      await markDevelopmentQueued(issueId)

      // Auto-detect parent for coordination
      let workType: AgentWorkType = 'development'
      try {
        const isParent = await linearClient.isParentIssue(issueId)
        if (isParent) {
          workType = 'coordination'
          issueLog.info('Parent issue detected, switching to coordination work type')
        }
      } catch (err) {
        issueLog.warn('Failed to check if issue is parent', { error: err })
      }

      const prompt = config.generatePrompt(issueIdentifier, workType)

      await storeSessionState(devSessionId, {
        issueId,
        issueIdentifier,
        claudeSessionId: null,
        worktreePath: '',
        status: 'pending',
        queuedAt: Date.now(),
        promptContext: prompt,
        priority: 3,
        organizationId: payload.organizationId,
        workType,
      })

      const devWork: QueuedWork = {
        sessionId: devSessionId,
        issueId,
        issueIdentifier,
        priority: 3,
        queuedAt: Date.now(),
        prompt,
        workType,
      }

      const devResult = await dispatchWork(devWork)

      if (devResult.dispatched || devResult.parked) {
        issueLog.info('Development work dispatched', { sessionId: devSessionId })

        try {
          const appUrl = getAppUrl(config)
          await linearClient.updateAgentSession({
            sessionId: devSessionId,
            externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/${devSessionId}` }],
          })
        } catch (err) {
          issueLog.warn('Failed to update session externalUrl', { error: err })
        }

        try {
          await emitActivity(linearClient, devSessionId, 'thought', 'Development work queued. Waiting for an available worker...')
        } catch (err) {
          issueLog.warn('Failed to emit queued activity', { error: err })
        }
      } else {
        issueLog.error('Failed to queue development work')
      }
    }
  }

  // === Handle Finished → Delivered transition (auto-acceptance) ===
  if (currentStateName === 'Delivered' && updatedFrom?.stateId) {
    const previousStateName = await resolveStateName(
      config,
      payload.organizationId,
      issueId,
      updatedFrom.stateId as string
    )

    if (previousStateName !== 'Finished') {
      issueLog.debug('Issue transitioned to Delivered but not from Finished', { previousStateName })
    } else {
      issueLog.info('Issue transitioned from Finished to Delivered', {
        previousStateName,
        actorName: actor?.name,
      })

      // Skip acceptance for sub-issues
      let isChildForAcceptance = !!(data.parent)
      if (!isChildForAcceptance) {
        try {
          const checkClient = await config.linearClient.getClient(payload.organizationId)
          isChildForAcceptance = await checkClient.isChildIssue(issueId)
        } catch (err) {
          issueLog.warn('Failed to check if issue is a child', { error: err })
        }
      }

      if (isChildForAcceptance) {
        issueLog.info('Sub-issue detected, skipping individual acceptance trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'sub_issue_skipped' })
      }

      if (!autoTrigger?.enableAutoAcceptance) {
        issueLog.debug('Auto-acceptance disabled, skipping acceptance trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'auto_acceptance_disabled' })
      }

      const projectName = (data.project as Record<string, unknown> | undefined)?.name as string | undefined
      if (!isProjectAllowed(projectName, autoTrigger.autoAcceptanceProjects)) {
        issueLog.debug('Project not in auto-acceptance list, skipping', { projectName })
        return NextResponse.json({ success: true, skipped: true, reason: 'project_not_allowed' })
      }

      const labels = data.labels as Array<{ name: string }> | undefined
      if (hasExcludedLabel(labels, autoTrigger.autoAcceptanceExcludeLabels)) {
        issueLog.debug('Issue has excluded label, skipping acceptance trigger')
        return NextResponse.json({ success: true, skipped: true, reason: 'excluded_label' })
      }

      if (autoTrigger.autoAcceptanceRequireAgentWorked) {
        const workRecord = await wasAgentWorked(issueId)
        if (!workRecord) {
          issueLog.debug('Issue not worked by agent, skipping acceptance trigger')
          return NextResponse.json({ success: true, skipped: true, reason: 'not_agent_worked' })
        }
      }

      if (await didJustQueueAcceptance(issueId)) {
        issueLog.info('Issue in acceptance cooldown period, skipping')
        return NextResponse.json({ success: true, skipped: true, reason: 'acceptance_cooldown' })
      }

      const idempotencyKey = generateIdempotencyKey(webhookId, `acceptance:${issueId}:${Date.now()}`)
      if (await isWebhookProcessed(idempotencyKey)) {
        issueLog.info('Duplicate acceptance trigger ignored', { idempotencyKey })
        return NextResponse.json({ success: true, skipped: true, reason: 'duplicate_acceptance_trigger' })
      }

      // Check deployment status
      try {
        const deploymentResult = await checkIssueDeploymentStatus(issueIdentifier)

        if (deploymentResult?.anyFailed) {
          issueLog.info('Deployment failed, blocking acceptance')

          const linearClient = await config.linearClient.getClient(payload.organizationId)
          await linearClient.createComment(
            issueId,
            `## Acceptance Blocked: Deployment Failed\n\n` +
            `Cannot proceed with acceptance testing until Vercel deployment succeeds.\n\n` +
            formatFailedDeployments(deploymentResult) +
            `\n\n**PR:** ${deploymentResult.pr.url}\n` +
            `**Commit:** \`${deploymentResult.commitSha.slice(0, 7)}\`\n\n` +
            `Please fix the deployment issues. The issue will remain in Delivered status.`
          )

          return NextResponse.json({ success: true, skipped: true, reason: 'deployment_failed' })
        }
      } catch (err) {
        issueLog.warn('Deployment check failed, proceeding with acceptance', { error: err })
      }

      await markAcceptanceQueued(issueId)

      const linearClient = await config.linearClient.getClient(payload.organizationId)

      // Detect parent → acceptance-coordination
      let acceptanceWorkType: AgentWorkType = 'acceptance'
      let acceptancePrompt = config.generatePrompt(issueIdentifier, 'acceptance')
      try {
        const isParent = await linearClient.isParentIssue(issueId)
        if (isParent) {
          acceptanceWorkType = 'acceptance-coordination'
          acceptancePrompt = config.generatePrompt(issueIdentifier, 'acceptance-coordination')
          issueLog.info('Parent issue detected, using acceptance-coordination work type')
        }
      } catch (err) {
        issueLog.warn('Failed to detect parent issue for acceptance routing', { error: err })
      }

      // Create Linear AgentSession for acceptance
      let acceptanceSessionId: string
      try {
        const appUrl = getAppUrl(config)
        const sessionResult = await linearClient.createAgentSessionOnIssue({
          issueId,
          externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/pending` }],
        })

        if (!sessionResult.success || !sessionResult.sessionId) {
          issueLog.error('Failed to create Linear AgentSession for acceptance', { sessionResult })
          return NextResponse.json({ success: false, error: 'Failed to create agent session for acceptance' })
        }

        acceptanceSessionId = sessionResult.sessionId
        issueLog.info('Linear AgentSession created for acceptance', { sessionId: acceptanceSessionId })
      } catch (err) {
        issueLog.error('Error creating Linear AgentSession for acceptance', { error: err })
        return NextResponse.json({ success: false, error: 'Error creating agent session for acceptance' })
      }

      await storeSessionState(acceptanceSessionId, {
        issueId,
        issueIdentifier,
        claudeSessionId: null,
        worktreePath: '',
        status: 'pending',
        queuedAt: Date.now(),
        promptContext: acceptancePrompt,
        priority: 2,
        organizationId: payload.organizationId,
        workType: acceptanceWorkType,
      })

      const acceptanceWork: QueuedWork = {
        sessionId: acceptanceSessionId,
        issueId,
        issueIdentifier,
        priority: 2,
        queuedAt: Date.now(),
        prompt: acceptancePrompt,
        workType: acceptanceWorkType,
      }

      const accResult = await dispatchWork(acceptanceWork)

      if (accResult.dispatched || accResult.parked) {
        issueLog.info('Acceptance work dispatched', { sessionId: acceptanceSessionId })

        try {
          const appUrl = getAppUrl(config)
          await linearClient.updateAgentSession({
            sessionId: acceptanceSessionId,
            externalUrls: [{ label: 'Agent Dashboard', url: `${appUrl}/sessions/${acceptanceSessionId}` }],
          })
        } catch (err) {
          issueLog.warn('Failed to update acceptance session externalUrl', { error: err })
        }

        try {
          await emitActivity(linearClient, acceptanceSessionId, 'thought', 'Acceptance work queued. Waiting for an available worker...')
        } catch (err) {
          issueLog.warn('Failed to emit acceptance queued activity', { error: err })
        }

        try {
          await linearClient.createComment(
            issueId,
            `## Acceptance Processing Started\n\nQA passed. Validating work completion and preparing to merge PR...\n\nThe acceptance handler will:\n1. Verify the preview deployment is working\n2. Check PR is ready to merge (CI passing, no conflicts)\n3. Merge the PR\n4. Clean up local resources\n5. Move issue to Accepted on success`
          )
        } catch (err) {
          issueLog.error('Failed to post acceptance start comment', { error: err })
        }
      } else {
        issueLog.error('Failed to queue acceptance work')
      }
    }
  }

  return null // Continue processing
}
