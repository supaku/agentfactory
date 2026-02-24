/**
 * Linear CLI Runner — process-agnostic Linear operations.
 *
 * All 15 command implementations extracted from packages/core/src/linear-cli.ts.
 * This module does NOT call process.exit, read process.argv, or load dotenv.
 */

import { createLinearAgentClient, getDefaultTeamName } from '@supaku/agentfactory-linear'
import {
  checkPRDeploymentStatus,
  formatDeploymentStatus,
} from '@supaku/agentfactory'

// ── Types ──────────────────────────────────────────────────────────

export interface LinearRunnerConfig {
  command: string
  args: Record<string, string | string[] | boolean>
  positionalArgs: string[]
  apiKey?: string
}

export interface LinearRunnerResult {
  output: unknown
}

// ── Arg parsing ────────────────────────────────────────────────────

/** Fields that should be split on commas to create arrays */
const ARRAY_FIELDS = new Set(['labels'])

/**
 * Parse CLI arguments into a structured object.
 *
 * Supports:
 * - `--key value` pairs
 * - JSON array values: `--labels '["Bug", "Feature"]'`
 * - Comma-separated values for array fields: `--labels "Bug,Feature"`
 * - Boolean flags: `--dry-run` (value = "true")
 *
 * Returns the command (first non-flag arg), named args, and positional args.
 */
export function parseLinearArgs(argv: string[]): {
  command: string | undefined
  args: Record<string, string | string[] | boolean>
  positionalArgs: string[]
} {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined
  const rest = command ? argv.slice(1) : argv

  const args: Record<string, string | string[] | boolean> = {}
  const positionalArgs: string[] = []

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = rest[i + 1]
      if (value && !value.startsWith('--')) {
        // Support JSON array format: --labels '["Bug", "Feature"]'
        if (value.startsWith('[') && value.endsWith(']')) {
          try {
            const parsed = JSON.parse(value)
            if (Array.isArray(parsed)) {
              args[key] = parsed
              i++
              continue
            }
          } catch {
            // Not valid JSON, fall through to normal handling
          }
        }

        // Only split on comma for known array fields
        if (ARRAY_FIELDS.has(key) && value.includes(',')) {
          args[key] = value.split(',').map((v) => v.trim())
        } else {
          args[key] = value
        }
        i++
      } else {
        args[key] = true
      }
    } else {
      positionalArgs.push(arg)
    }
  }

  return { command, args, positionalArgs }
}

// ── Internal types ─────────────────────────────────────────────────

type LinearClient = ReturnType<typeof createLinearAgentClient>

interface CreateIssueOptions {
  title: string
  description?: string
  team: string
  project?: string
  labels?: string[]
  state?: string
  parentId?: string
}

interface UpdateIssueOptions {
  title?: string
  description?: string
  state?: string
  labels?: string[]
}

interface CreateBlockerOptions {
  title: string
  sourceIssueId: string
  description?: string
  team?: string
  project?: string
  assignee?: string
}

// ── Command implementations ────────────────────────────────────────

async function getIssue(client: LinearClient, issueId: string): Promise<unknown> {
  const issue = await client.getIssue(issueId)
  const state = await issue.state
  const team = await issue.team
  const project = await issue.project
  const labels = await issue.labels()

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    status: state?.name,
    team: team?.name,
    project: project?.name,
    labels: labels.nodes.map((l) => l.name),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

async function createIssue(client: LinearClient, options: CreateIssueOptions): Promise<unknown> {
  const team = await client.getTeam(options.team)

  const createPayload: Parameters<LinearClient['linearClient']['createIssue']>[0] = {
    teamId: team.id,
    title: options.title,
  }

  if (options.description) {
    createPayload.description = options.description
  }

  if (options.parentId) {
    createPayload.parentId = options.parentId
  }

  if (options.project) {
    const projects = await client.linearClient.projects({
      filter: { name: { eq: options.project } },
    })
    if (projects.nodes.length > 0) {
      createPayload.projectId = projects.nodes[0].id
    }
  }

  if (options.state) {
    const statuses = await client.getTeamStatuses(team.id)
    const stateId = statuses[options.state]
    if (stateId) {
      createPayload.stateId = stateId
    }
  }

  if (options.labels && options.labels.length > 0) {
    const allLabels = await client.linearClient.issueLabels()
    const labelIds: string[] = []
    for (const labelName of options.labels) {
      const label = allLabels.nodes.find(
        (l) => l.name.toLowerCase() === labelName.toLowerCase()
      )
      if (label) {
        labelIds.push(label.id)
      }
    }
    if (labelIds.length > 0) {
      createPayload.labelIds = labelIds
    }
  }

  const payload = await client.linearClient.createIssue(createPayload)
  if (!payload.success) {
    throw new Error('Failed to create issue')
  }

  const issue = await payload.issue
  if (!issue) {
    throw new Error('Issue created but not returned')
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  }
}

async function updateIssue(
  client: LinearClient,
  issueId: string,
  options: UpdateIssueOptions
): Promise<unknown> {
  const issue = await client.getIssue(issueId)
  const team = await issue.team

  const updateData: Parameters<LinearClient['updateIssue']>[1] = {}

  if (options.title) {
    updateData.title = options.title
  }

  if (options.description) {
    updateData.description = options.description
  }

  if (options.state && team) {
    const statuses = await client.getTeamStatuses(team.id)
    const stateId = statuses[options.state]
    if (stateId) {
      updateData.stateId = stateId
    }
  }

  if (options.labels && options.labels.length > 0) {
    const allLabels = await client.linearClient.issueLabels()
    const labelIds: string[] = []
    for (const labelName of options.labels) {
      const label = allLabels.nodes.find(
        (l) => l.name.toLowerCase() === labelName.toLowerCase()
      )
      if (label) {
        labelIds.push(label.id)
      }
    }
    updateData.labelIds = labelIds
  }

  const updatedIssue = await client.updateIssue(issue.id, updateData)
  const state = await updatedIssue.state

  return {
    id: updatedIssue.id,
    identifier: updatedIssue.identifier,
    title: updatedIssue.title,
    status: state?.name,
    url: updatedIssue.url,
  }
}

async function listComments(client: LinearClient, issueId: string): Promise<unknown> {
  const comments = await client.getIssueComments(issueId)

  return comments.map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
  }))
}

async function createComment(
  client: LinearClient,
  issueId: string,
  body: string
): Promise<unknown> {
  const comment = await client.createComment(issueId, body)

  return {
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
  }
}

async function addRelation(
  client: LinearClient,
  issueId: string,
  relatedIssueId: string,
  relationType: 'related' | 'blocks' | 'duplicate'
): Promise<unknown> {
  const result = await client.createIssueRelation({
    issueId,
    relatedIssueId,
    type: relationType,
  })

  return {
    success: result.success,
    relationId: result.relationId,
    issueId,
    relatedIssueId,
    type: relationType,
  }
}

async function listRelations(client: LinearClient, issueId: string): Promise<unknown> {
  const result = await client.getIssueRelations(issueId)

  return {
    issueId,
    relations: result.relations.map((r) => ({
      id: r.id,
      type: r.type,
      relatedIssue: r.relatedIssueIdentifier ?? r.relatedIssueId,
      createdAt: r.createdAt,
    })),
    inverseRelations: result.inverseRelations.map((r) => ({
      id: r.id,
      type: r.type,
      sourceIssue: r.issueIdentifier ?? r.issueId,
      createdAt: r.createdAt,
    })),
  }
}

async function removeRelation(client: LinearClient, relationId: string): Promise<unknown> {
  const result = await client.deleteIssueRelation(relationId)

  return {
    success: result.success,
    relationId,
  }
}

async function listBacklogIssues(client: LinearClient, projectName: string): Promise<unknown> {
  const projects = await client.linearClient.projects({
    filter: { name: { eqIgnoreCase: projectName } },
  })

  if (projects.nodes.length === 0) {
    throw new Error(`Project not found: ${projectName}`)
  }

  const project = projects.nodes[0]

  const issues = await client.linearClient.issues({
    filter: {
      project: { id: { eq: project.id } },
      state: { name: { eqIgnoreCase: 'Backlog' } },
    },
  })

  const results = []
  for (const issue of issues.nodes) {
    const state = await issue.state
    const labels = await issue.labels()
    results.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      priority: issue.priority,
      status: state?.name,
      labels: labels.nodes.map((l) => l.name),
    })
  }

  results.sort((a, b) => {
    const aPriority = a.priority || 5
    const bPriority = b.priority || 5
    return aPriority - bPriority
  })

  return results
}

async function getBlockingIssues(
  client: LinearClient,
  issueId: string
): Promise<Array<{ identifier: string; title: string; status: string }>> {
  const relations = await client.getIssueRelations(issueId)
  const blockingIssues: Array<{ identifier: string; title: string; status: string }> = []

  for (const relation of relations.inverseRelations) {
    if (relation.type === 'blocks') {
      const blockingIssue = await client.getIssue(relation.issueId)
      const state = await blockingIssue.state
      const statusName = state?.name ?? 'Unknown'

      if (statusName !== 'Accepted') {
        blockingIssues.push({
          identifier: blockingIssue.identifier,
          title: blockingIssue.title,
          status: statusName,
        })
      }
    }
  }

  return blockingIssues
}

async function listUnblockedBacklogIssues(
  client: LinearClient,
  projectName: string
): Promise<unknown> {
  const projects = await client.linearClient.projects({
    filter: { name: { eqIgnoreCase: projectName } },
  })

  if (projects.nodes.length === 0) {
    throw new Error(`Project not found: ${projectName}`)
  }

  const project = projects.nodes[0]

  const issues = await client.linearClient.issues({
    filter: {
      project: { id: { eq: project.id } },
      state: { name: { eqIgnoreCase: 'Backlog' } },
    },
  })

  const results = []
  for (const issue of issues.nodes) {
    const blockingIssues = await getBlockingIssues(client, issue.id)
    const state = await issue.state
    const labels = await issue.labels()

    results.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      priority: issue.priority,
      status: state?.name,
      labels: labels.nodes.map((l) => l.name),
      blocked: blockingIssues.length > 0,
      blockedBy: blockingIssues,
    })
  }

  const unblockedResults = results.filter((r) => !r.blocked)

  unblockedResults.sort((a, b) => {
    const aPriority = a.priority || 5
    const bPriority = b.priority || 5
    return aPriority - bPriority
  })

  return unblockedResults
}

async function checkBlocked(client: LinearClient, issueId: string): Promise<unknown> {
  const blockingIssues = await getBlockingIssues(client, issueId)

  return {
    issueId,
    blocked: blockingIssues.length > 0,
    blockedBy: blockingIssues,
  }
}

async function listSubIssues(client: LinearClient, issueId: string): Promise<unknown> {
  const graph = await client.getSubIssueGraph(issueId)

  return {
    parentId: graph.parentId,
    parentIdentifier: graph.parentIdentifier,
    subIssueCount: graph.subIssues.length,
    subIssues: graph.subIssues.map((node) => ({
      id: node.issue.id,
      identifier: node.issue.identifier,
      title: node.issue.title,
      status: node.issue.status,
      priority: node.issue.priority,
      labels: node.issue.labels,
      url: node.issue.url,
      blockedBy: node.blockedBy,
      blocks: node.blocks,
    })),
  }
}

async function listSubIssueStatuses(client: LinearClient, issueId: string): Promise<unknown> {
  const statuses = await client.getSubIssueStatuses(issueId)

  return {
    parentIssue: issueId,
    subIssueCount: statuses.length,
    subIssues: statuses,
    allFinishedOrLater: statuses.every((s) =>
      ['Finished', 'Delivered', 'Accepted', 'Canceled'].includes(s.status)
    ),
    incomplete: statuses.filter(
      (s) => !['Finished', 'Delivered', 'Accepted', 'Canceled'].includes(s.status)
    ),
  }
}

async function updateSubIssue(
  client: LinearClient,
  issueId: string,
  options: { state?: string; comment?: string }
): Promise<unknown> {
  const issue = await client.getIssue(issueId)

  if (options.state) {
    await client.updateIssueStatus(
      issue.id,
      options.state as 'Backlog' | 'Started' | 'Finished' | 'Delivered' | 'Accepted' | 'Canceled'
    )
  }

  if (options.comment) {
    await client.createComment(issue.id, options.comment)
  }

  const updatedIssue = await client.getIssue(issueId)
  const state = await updatedIssue.state

  return {
    id: updatedIssue.id,
    identifier: updatedIssue.identifier,
    title: updatedIssue.title,
    status: state?.name,
    url: updatedIssue.url,
  }
}

async function checkDeployment(
  prNumber: number,
  format: 'json' | 'markdown' = 'json'
): Promise<unknown> {
  const result = await checkPRDeploymentStatus(prNumber)

  if (!result) {
    throw new Error(
      `Could not get deployment status for PR #${prNumber}. Make sure the PR exists and you have access to it.`
    )
  }

  if (format === 'markdown') {
    return formatDeploymentStatus(result)
  }

  return result
}

async function createBlocker(
  client: LinearClient,
  options: CreateBlockerOptions
): Promise<unknown> {
  // 1. Fetch source issue to resolve team/project
  const sourceIssue = await client.getIssue(options.sourceIssueId)
  const sourceTeam = await sourceIssue.team
  const sourceProject = await sourceIssue.project

  const teamName = options.team ?? sourceTeam?.key
  if (!teamName) {
    throw new Error('Could not resolve team from source issue. Provide --team explicitly.')
  }

  const team = await client.getTeam(teamName)
  const projectName = options.project ?? sourceProject?.name

  // 2. Deduplicate: check for existing Icebox issues with same title + "Needs Human" label
  if (projectName) {
    const projects = await client.linearClient.projects({
      filter: { name: { eqIgnoreCase: projectName } },
    })
    if (projects.nodes.length > 0) {
      const existingIssues = await client.linearClient.issues({
        filter: {
          project: { id: { eq: projects.nodes[0].id } },
          state: { name: { eqIgnoreCase: 'Icebox' } },
          labels: { name: { eqIgnoreCase: 'Needs Human' } },
        },
      })

      const duplicate = existingIssues.nodes.find(
        (i) => i.title.toLowerCase() === options.title.toLowerCase()
      )

      if (duplicate) {
        // Add a +1 comment to the existing issue
        await client.createComment(
          duplicate.id,
          `+1 — Also needed by ${sourceIssue.identifier}`
        )
        return {
          id: duplicate.id,
          identifier: duplicate.identifier,
          title: duplicate.title,
          url: duplicate.url,
          sourceIssue: sourceIssue.identifier,
          relation: 'blocks',
          deduplicated: true,
        }
      }
    }
  }

  // 3. Create the blocker issue
  const createPayload: Parameters<LinearClient['linearClient']['createIssue']>[0] = {
    teamId: team.id,
    title: options.title,
  }

  // Description with source reference
  const descParts: string[] = []
  if (options.description) {
    descParts.push(options.description)
  }
  descParts.push(`\n---\n*Source issue: ${sourceIssue.identifier}*`)
  createPayload.description = descParts.join('\n\n')

  // Set state to Icebox
  const statuses = await client.getTeamStatuses(team.id)
  const iceboxStateId = statuses['Icebox']
  if (iceboxStateId) {
    createPayload.stateId = iceboxStateId
  }

  // Set "Needs Human" label
  const allLabels = await client.linearClient.issueLabels()
  const needsHumanLabel = allLabels.nodes.find(
    (l) => l.name.toLowerCase() === 'needs human'
  )
  if (needsHumanLabel) {
    createPayload.labelIds = [needsHumanLabel.id]
  }

  // Set project
  if (projectName) {
    const projects = await client.linearClient.projects({
      filter: { name: { eqIgnoreCase: projectName } },
    })
    if (projects.nodes.length > 0) {
      createPayload.projectId = projects.nodes[0].id
    }
  }

  const payload = await client.linearClient.createIssue(createPayload)
  if (!payload.success) {
    throw new Error('Failed to create blocker issue')
  }

  const blockerIssue = await payload.issue
  if (!blockerIssue) {
    throw new Error('Blocker issue created but not returned')
  }

  // 4. Create blocking relation: blocker blocks source
  await client.createIssueRelation({
    issueId: blockerIssue.id,
    relatedIssueId: sourceIssue.id,
    type: 'blocks',
  })

  // 5. Post comment on source issue
  await client.createComment(
    sourceIssue.id,
    `\u{1F6A7} Human blocker created: [${blockerIssue.identifier}](${blockerIssue.url}) — ${options.title}`
  )

  // 6. Optionally assign
  if (options.assignee) {
    const users = await client.linearClient.users({
      filter: {
        or: [
          { name: { eqIgnoreCase: options.assignee } },
          { email: { eq: options.assignee } },
        ],
      },
    })
    if (users.nodes.length > 0) {
      await client.linearClient.updateIssue(blockerIssue.id, {
        assigneeId: users.nodes[0].id,
      })
    }
  }

  return {
    id: blockerIssue.id,
    identifier: blockerIssue.identifier,
    title: blockerIssue.title,
    url: blockerIssue.url,
    sourceIssue: sourceIssue.identifier,
    relation: 'blocks',
    deduplicated: false,
  }
}

// ── Commands that don't require LINEAR_API_KEY ─────────────────────

const NO_API_KEY_COMMANDS = new Set(['check-deployment'])

// ── Main runner ────────────────────────────────────────────────────

export async function runLinear(config: LinearRunnerConfig): Promise<LinearRunnerResult> {
  const { command, args, positionalArgs, apiKey } = config

  // Lazy client — only created for commands that need it
  let _client: LinearClient | null = null
  function client(): LinearClient {
    if (!_client) {
      if (!apiKey) {
        throw new Error('LINEAR_API_KEY environment variable is required')
      }
      _client = createLinearAgentClient({ apiKey })
    }
    return _client
  }

  // Validate API key for commands that need it
  if (!NO_API_KEY_COMMANDS.has(command) && !apiKey) {
    throw new Error('LINEAR_API_KEY environment variable is required')
  }

  // Helper: get first positional or error
  function requirePositional(name: string): string {
    const val = positionalArgs[0]
    if (!val || val.startsWith('--')) {
      throw new Error(`Missing required argument: <${name}>`)
    }
    return val
  }

  // Parse sub-options from the original args (for commands that re-parse after positional)
  function subArgs(): Record<string, string | string[] | boolean> {
    return args
  }

  let output: unknown

  switch (command) {
    case 'get-issue': {
      const issueId = requirePositional('issue-id')
      output = await getIssue(client(), issueId)
      break
    }

    case 'create-issue': {
      const teamArg = (args.team as string | undefined) ?? (getDefaultTeamName() || undefined)
      if (!args.title || !teamArg) {
        throw new Error(
          'Usage: af-linear create-issue --title "Title" --team "Team" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]\n' +
          'Tip: Set LINEAR_TEAM_NAME env var to provide a default team.'
        )
      }
      output = await createIssue(client(), {
        title: args.title as string,
        team: teamArg,
        description: args.description as string | undefined,
        project: args.project as string | undefined,
        labels: args.labels as string[] | undefined,
        state: args.state as string | undefined,
        parentId: args.parentId as string | undefined,
      })
      break
    }

    case 'update-issue': {
      const issueId = requirePositional('issue-id')
      const opts = subArgs()
      output = await updateIssue(client(), issueId, {
        title: opts.title as string | undefined,
        description: opts.description as string | undefined,
        state: opts.state as string | undefined,
        labels: opts.labels as string[] | undefined,
      })
      break
    }

    case 'list-comments': {
      const issueId = requirePositional('issue-id')
      output = await listComments(client(), issueId)
      break
    }

    case 'create-comment': {
      const issueId = requirePositional('issue-id')
      if (!args.body) {
        throw new Error('Usage: af-linear create-comment <issue-id> --body "Comment text"')
      }
      output = await createComment(client(), issueId, args.body as string)
      break
    }

    case 'list-backlog-issues': {
      if (!args.project) {
        throw new Error('Usage: af-linear list-backlog-issues --project "ProjectName"')
      }
      output = await listBacklogIssues(client(), args.project as string)
      break
    }

    case 'list-unblocked-backlog': {
      if (!args.project) {
        throw new Error('Usage: af-linear list-unblocked-backlog --project "ProjectName"')
      }
      output = await listUnblockedBacklogIssues(client(), args.project as string)
      break
    }

    case 'check-blocked': {
      const issueId = requirePositional('issue-id')
      output = await checkBlocked(client(), issueId)
      break
    }

    case 'add-relation': {
      const issueId = positionalArgs[0]
      const relatedIssueId = positionalArgs[1]
      const relationType = args.type as string | undefined
      if (
        !issueId ||
        issueId.startsWith('--') ||
        !relatedIssueId ||
        relatedIssueId.startsWith('--') ||
        !relationType ||
        !['related', 'blocks', 'duplicate'].includes(relationType)
      ) {
        throw new Error(
          'Usage: af-linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>'
        )
      }
      output = await addRelation(
        client(),
        issueId,
        relatedIssueId,
        relationType as 'related' | 'blocks' | 'duplicate'
      )
      break
    }

    case 'list-relations': {
      const issueId = requirePositional('issue-id')
      output = await listRelations(client(), issueId)
      break
    }

    case 'remove-relation': {
      const relationId = requirePositional('relation-id')
      output = await removeRelation(client(), relationId)
      break
    }

    case 'list-sub-issues': {
      const issueId = requirePositional('issue-id')
      output = await listSubIssues(client(), issueId)
      break
    }

    case 'list-sub-issue-statuses': {
      const issueId = requirePositional('issue-id')
      output = await listSubIssueStatuses(client(), issueId)
      break
    }

    case 'update-sub-issue': {
      const issueId = requirePositional('issue-id')
      const opts = subArgs()
      output = await updateSubIssue(client(), issueId, {
        state: opts.state as string | undefined,
        comment: opts.comment as string | undefined,
      })
      break
    }

    case 'check-deployment': {
      const prArg = requirePositional('pr-number')
      const prNumber = parseInt(prArg, 10)
      if (isNaN(prNumber)) {
        throw new Error('PR number must be a valid integer')
      }
      const format = (args.format as 'json' | 'markdown') || 'json'
      output = await checkDeployment(prNumber, format)
      break
    }

    case 'create-blocker': {
      const sourceIssueId = requirePositional('source-issue-id')
      if (!args.title) {
        throw new Error(
          'Usage: af-linear create-blocker <source-issue-id> --title "Title" [--description "..."] [--team "..."] [--project "..."] [--assignee "user@email.com"]'
        )
      }
      output = await createBlocker(client(), {
        title: args.title as string,
        sourceIssueId,
        description: args.description as string | undefined,
        team: args.team as string | undefined,
        project: args.project as string | undefined,
        assignee: args.assignee as string | undefined,
      })
      break
    }

    default:
      throw new Error(`Unknown command: ${command}`)
  }

  return { output }
}
