#!/usr/bin/env node
/**
 * Linear CLI - Command-line interface for Linear Agent SDK
 *
 * Usage:
 *   pnpm linear <command> [options]
 *
 * Commands:
 *   get-issue <id>              Get issue details
 *   create-issue                Create a new issue
 *   update-issue <id>           Update an existing issue
 *   list-comments <issueId>     List comments on an issue
 *   create-comment <issueId>    Create a comment on an issue
 *   list-backlog-issues         List backlog issues for a project
 *   list-unblocked-backlog      List unblocked backlog issues
 *   check-blocked <id>          Check if an issue is blocked
 *   add-relation <id> <id>      Create relation between issues
 *   list-relations <id>         List relations for an issue
 *   remove-relation <id>        Remove a relation by ID
 *   list-sub-issues <id>        List sub-issues of a parent issue
 *   list-sub-issue-statuses <id> List sub-issue statuses (lightweight)
 *   update-sub-issue <id>       Update sub-issue status with comment
 *   check-deployment <PR>       Check Vercel deployment status for a PR
 *
 * Array Values:
 *   --labels accepts comma-separated: --labels "Bug,Feature"
 *   For values with commas, use JSON: --labels '["Bug", "UI, UX"]'
 *   Text fields (--description, --title, --body) preserve commas.
 *
 * Environment:
 *   LINEAR_API_KEY              Required API key for authentication
 */

import { createLinearAgentClient } from '@supaku/agentfactory-linear'
import {
  checkPRDeploymentStatus,
  formatDeploymentStatus,
} from './deployment/index.js'

const LINEAR_API_KEY = process.env.LINEAR_API_KEY

// Commands that don't require LINEAR_API_KEY (they use gh CLI instead)
const NO_API_KEY_COMMANDS = ['check-deployment']

function getClient() {
  if (!LINEAR_API_KEY) {
    console.error('Error: LINEAR_API_KEY environment variable is required')
    process.exit(1)
  }
  return createLinearAgentClient({ apiKey: LINEAR_API_KEY })
}

// Lazy-initialized client - only created when needed
let _client: ReturnType<typeof createLinearAgentClient> | null = null
function client() {
  if (!_client) {
    _client = getClient()
  }
  return _client
}

// Type alias for client methods
type LinearClientType = ReturnType<typeof createLinearAgentClient>

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

// Fields that should be split on commas to create arrays
const ARRAY_FIELDS = new Set(['labels'])

function parseArgs(args: string[]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        // Support JSON array format: --labels '["Bug", "Feature"]'
        if (value.startsWith('[') && value.endsWith(']')) {
          try {
            const parsed = JSON.parse(value)
            if (Array.isArray(parsed)) {
              result[key] = parsed
              i++
              continue
            }
          } catch {
            // Not valid JSON, fall through to normal handling
          }
        }

        // Only split on comma for known array fields
        if (ARRAY_FIELDS.has(key) && value.includes(',')) {
          result[key] = value.split(',').map((v) => v.trim())
        } else {
          result[key] = value
        }
        i++
      } else {
        result[key] = 'true'
      }
    }
  }
  return result
}

async function getIssue(issueId: string) {
  const issue = await client().getIssue(issueId)
  const state = await issue.state
  const team = await issue.team
  const project = await issue.project
  const labels = await issue.labels()

  console.log(
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  )
}

async function createIssue(options: CreateIssueOptions) {
  // Get team ID
  const team = await client().getTeam(options.team)

  // Build create payload
  const createPayload: Parameters<LinearClientType['linearClient']['createIssue']>[0] = {
    teamId: team.id,
    title: options.title,
  }

  if (options.description) {
    createPayload.description = options.description
  }

  if (options.parentId) {
    createPayload.parentId = options.parentId
  }

  // Get project ID if specified
  if (options.project) {
    const projects = await client().linearClient.projects({
      filter: { name: { eq: options.project } },
    })
    if (projects.nodes.length > 0) {
      createPayload.projectId = projects.nodes[0].id
    }
  }

  // Get state ID if specified
  if (options.state) {
    const statuses = await client().getTeamStatuses(team.id)
    const stateId = statuses[options.state]
    if (stateId) {
      createPayload.stateId = stateId
    }
  }

  // Get label IDs if specified
  if (options.labels && options.labels.length > 0) {
    const allLabels = await client().linearClient.issueLabels()
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

  const payload = await client().linearClient.createIssue(createPayload)
  if (!payload.success) {
    console.error('Failed to create issue')
    process.exit(1)
  }

  const issue = await payload.issue
  if (!issue) {
    console.error('Issue created but not returned')
    process.exit(1)
  }

  console.log(
    JSON.stringify(
      {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
      },
      null,
      2
    )
  )
}

async function updateIssue(issueId: string, options: UpdateIssueOptions) {
  const issue = await client().getIssue(issueId)
  const team = await issue.team

  const updateData: Parameters<LinearClientType['updateIssue']>[1] = {}

  if (options.title) {
    updateData.title = options.title
  }

  if (options.description) {
    updateData.description = options.description
  }

  // Handle state update
  if (options.state && team) {
    const statuses = await client().getTeamStatuses(team.id)
    const stateId = statuses[options.state]
    if (stateId) {
      updateData.stateId = stateId
    }
  }

  // Handle labels update
  if (options.labels && options.labels.length > 0) {
    const allLabels = await client().linearClient.issueLabels()
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

  const updatedIssue = await client().updateIssue(issue.id, updateData)
  const state = await updatedIssue.state

  console.log(
    JSON.stringify(
      {
        id: updatedIssue.id,
        identifier: updatedIssue.identifier,
        title: updatedIssue.title,
        status: state?.name,
        url: updatedIssue.url,
      },
      null,
      2
    )
  )
}

async function listComments(issueId: string) {
  const comments = await client().getIssueComments(issueId)

  console.log(
    JSON.stringify(
      comments.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
      })),
      null,
      2
    )
  )
}

async function createComment(issueId: string, body: string) {
  const comment = await client().createComment(issueId, body)

  console.log(
    JSON.stringify(
      {
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
      },
      null,
      2
    )
  )
}

async function addRelation(
  issueId: string,
  relatedIssueId: string,
  relationType: 'related' | 'blocks' | 'duplicate'
) {
  const result = await client().createIssueRelation({
    issueId,
    relatedIssueId,
    type: relationType,
  })

  console.log(
    JSON.stringify(
      {
        success: result.success,
        relationId: result.relationId,
        issueId,
        relatedIssueId,
        type: relationType,
      },
      null,
      2
    )
  )
}

async function listRelations(issueId: string) {
  const result = await client().getIssueRelations(issueId)

  console.log(
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  )
}

async function removeRelation(relationId: string) {
  const result = await client().deleteIssueRelation(relationId)

  console.log(
    JSON.stringify(
      {
        success: result.success,
        relationId,
      },
      null,
      2
    )
  )
}

async function listBacklogIssues(projectName: string) {
  // Find the project
  const projects = await client().linearClient.projects({
    filter: { name: { eqIgnoreCase: projectName } },
  })

  if (projects.nodes.length === 0) {
    console.error(`Project not found: ${projectName}`)
    process.exit(1)
  }

  const project = projects.nodes[0]

  // Get issues in project with Backlog status
  const issues = await client().linearClient.issues({
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

  // Sort by priority (higher priority = lower number, 0 = no priority goes last)
  results.sort((a, b) => {
    const aPriority = a.priority || 5
    const bPriority = b.priority || 5
    return aPriority - bPriority
  })

  console.log(JSON.stringify(results, null, 2))
}

/**
 * Check if an issue is blocked by any non-Accepted issues
 * Returns the list of blocking issues if blocked, empty array if not blocked
 */
async function getBlockingIssues(
  issueId: string
): Promise<Array<{ identifier: string; title: string; status: string }>> {
  const relations = await client().getIssueRelations(issueId)
  const blockingIssues: Array<{ identifier: string; title: string; status: string }> = []

  // Check inverse relations for "blocks" type - these are issues blocking this one
  for (const relation of relations.inverseRelations) {
    if (relation.type === 'blocks') {
      const blockingIssue = await client().getIssue(relation.issueId)
      const state = await blockingIssue.state
      const statusName = state?.name ?? 'Unknown'

      // Issue is blocked if the blocking issue is not in Accepted status
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

async function listUnblockedBacklogIssues(projectName: string) {
  // Find the project
  const projects = await client().linearClient.projects({
    filter: { name: { eqIgnoreCase: projectName } },
  })

  if (projects.nodes.length === 0) {
    console.error(`Project not found: ${projectName}`)
    process.exit(1)
  }

  const project = projects.nodes[0]

  // Get issues in project with Backlog status
  const issues = await client().linearClient.issues({
    filter: {
      project: { id: { eq: project.id } },
      state: { name: { eqIgnoreCase: 'Backlog' } },
    },
  })

  const results = []
  for (const issue of issues.nodes) {
    // Check if issue is blocked
    const blockingIssues = await getBlockingIssues(issue.id)

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

  // Filter to only unblocked issues
  const unblockedResults = results.filter((r) => !r.blocked)

  // Sort by priority (higher priority = lower number, 0 = no priority goes last)
  unblockedResults.sort((a, b) => {
    const aPriority = a.priority || 5
    const bPriority = b.priority || 5
    return aPriority - bPriority
  })

  console.log(JSON.stringify(unblockedResults, null, 2))
}

async function checkBlocked(issueId: string) {
  const blockingIssues = await getBlockingIssues(issueId)

  console.log(
    JSON.stringify(
      {
        issueId,
        blocked: blockingIssues.length > 0,
        blockedBy: blockingIssues,
      },
      null,
      2
    )
  )
}

async function listSubIssues(issueId: string) {
  const graph = await client().getSubIssueGraph(issueId)

  console.log(
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  )
}

async function updateSubIssue(
  issueId: string,
  options: { state?: string; comment?: string }
) {
  const issue = await client().getIssue(issueId)

  if (options.state) {
    await client().updateIssueStatus(
      issue.id,
      options.state as 'Backlog' | 'Started' | 'Finished' | 'Delivered' | 'Accepted' | 'Canceled'
    )
  }

  if (options.comment) {
    await client().createComment(issue.id, options.comment)
  }

  const updatedIssue = await client().getIssue(issueId)
  const state = await updatedIssue.state

  console.log(
    JSON.stringify(
      {
        id: updatedIssue.id,
        identifier: updatedIssue.identifier,
        title: updatedIssue.title,
        status: state?.name,
        url: updatedIssue.url,
      },
      null,
      2
    )
  )
}

async function listSubIssueStatuses(issueId: string) {
  const statuses = await client().getSubIssueStatuses(issueId)

  console.log(
    JSON.stringify(
      {
        parentIssue: issueId,
        subIssueCount: statuses.length,
        subIssues: statuses,
        allFinishedOrLater: statuses.every((s) =>
          ['Finished', 'Delivered', 'Accepted', 'Canceled'].includes(s.status)
        ),
        incomplete: statuses.filter(
          (s) => !['Finished', 'Delivered', 'Accepted', 'Canceled'].includes(s.status)
        ),
      },
      null,
      2
    )
  )
}

async function checkDeployment(prNumber: number, format: 'json' | 'markdown' = 'json') {
  const result = await checkPRDeploymentStatus(prNumber)

  if (!result) {
    console.error(`Could not get deployment status for PR #${prNumber}`)
    console.error('Make sure the PR exists and you have access to it.')
    process.exit(1)
  }

  if (format === 'markdown') {
    console.log(formatDeploymentStatus(result))
  } else {
    console.log(JSON.stringify(result, null, 2))
  }

  // Exit with error code if any deployment failed
  if (result.anyFailed) {
    process.exit(1)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command) {
    console.error('Usage: pnpm linear <command> [options]')
    console.error('')
    console.error('Commands:')
    console.error('  get-issue <id>              Get issue details')
    console.error('  create-issue                Create a new issue')
    console.error('  update-issue <id>           Update an existing issue')
    console.error('  list-comments <issueId>     List comments on an issue')
    console.error('  create-comment <issueId>    Create a comment on an issue')
    console.error('  list-backlog-issues         List backlog issues for a project')
    console.error('  list-unblocked-backlog      List unblocked backlog issues')
    console.error('  check-blocked <id>          Check if an issue is blocked')
    console.error('  add-relation <id> <id>      Create relation between issues')
    console.error('  list-relations <id>         List relations for an issue')
    console.error('  remove-relation <id>        Remove a relation by ID')
    console.error('  list-sub-issues <id>        List sub-issues of a parent issue')
    console.error('  list-sub-issue-statuses <id> List sub-issue statuses (lightweight)')
    console.error('  update-sub-issue <id>       Update sub-issue status with comment')
    console.error('  check-deployment <PR>       Check Vercel deployment status')
    process.exit(1)
  }

  // Validate LINEAR_API_KEY for commands that need it
  if (!NO_API_KEY_COMMANDS.includes(command) && !LINEAR_API_KEY) {
    console.error('Error: LINEAR_API_KEY environment variable is required')
    process.exit(1)
  }

  const options = parseArgs(args.slice(1))

  switch (command) {
    case 'get-issue': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error('Usage: pnpm linear get-issue <issue-id>')
        process.exit(1)
      }
      await getIssue(issueId)
      break
    }

    case 'create-issue': {
      if (!options.title || !options.team) {
        console.error(
          'Usage: pnpm linear create-issue --title "Title" --team "Team" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]'
        )
        process.exit(1)
      }
      await createIssue({
        title: options.title as string,
        team: options.team as string,
        description: options.description as string | undefined,
        project: options.project as string | undefined,
        labels: options.labels as string[] | undefined,
        state: options.state as string | undefined,
        parentId: options.parentId as string | undefined,
      })
      break
    }

    case 'update-issue': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error(
          'Usage: pnpm linear update-issue <issue-id> [--title "..."] [--description "..."] [--state "..."] [--labels "..."]'
        )
        process.exit(1)
      }
      const updateOpts = parseArgs(args.slice(2))
      await updateIssue(issueId, {
        title: updateOpts.title as string | undefined,
        description: updateOpts.description as string | undefined,
        state: updateOpts.state as string | undefined,
        labels: updateOpts.labels as string[] | undefined,
      })
      break
    }

    case 'list-comments': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error('Usage: pnpm linear list-comments <issue-id>')
        process.exit(1)
      }
      await listComments(issueId)
      break
    }

    case 'create-comment': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--') || !options.body) {
        console.error(
          'Usage: pnpm linear create-comment <issue-id> --body "Comment text"'
        )
        process.exit(1)
      }
      await createComment(issueId, options.body as string)
      break
    }

    case 'list-backlog-issues': {
      if (!options.project) {
        console.error(
          'Usage: pnpm linear list-backlog-issues --project "ProjectName"'
        )
        process.exit(1)
      }
      await listBacklogIssues(options.project as string)
      break
    }

    case 'list-unblocked-backlog': {
      if (!options.project) {
        console.error(
          'Usage: pnpm linear list-unblocked-backlog --project "ProjectName"'
        )
        process.exit(1)
      }
      await listUnblockedBacklogIssues(options.project as string)
      break
    }

    case 'check-blocked': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error('Usage: pnpm linear check-blocked <issue-id>')
        process.exit(1)
      }
      await checkBlocked(issueId)
      break
    }

    case 'add-relation': {
      const issueId = args[1]
      const relatedIssueId = args[2]
      const relationType = options.type as string | undefined
      if (
        !issueId ||
        issueId.startsWith('--') ||
        !relatedIssueId ||
        relatedIssueId.startsWith('--') ||
        !relationType ||
        !['related', 'blocks', 'duplicate'].includes(relationType)
      ) {
        console.error(
          'Usage: pnpm linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>'
        )
        process.exit(1)
      }
      await addRelation(
        issueId,
        relatedIssueId,
        relationType as 'related' | 'blocks' | 'duplicate'
      )
      break
    }

    case 'list-relations': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error('Usage: pnpm linear list-relations <issue-id>')
        process.exit(1)
      }
      await listRelations(issueId)
      break
    }

    case 'remove-relation': {
      const relationId = args[1]
      if (!relationId || relationId.startsWith('--')) {
        console.error('Usage: pnpm linear remove-relation <relation-id>')
        process.exit(1)
      }
      await removeRelation(relationId)
      break
    }

    case 'list-sub-issues': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error('Usage: pnpm linear list-sub-issues <issue-id>')
        process.exit(1)
      }
      await listSubIssues(issueId)
      break
    }

    case 'list-sub-issue-statuses': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error('Usage: pnpm linear list-sub-issue-statuses <issue-id>')
        process.exit(1)
      }
      await listSubIssueStatuses(issueId)
      break
    }

    case 'update-sub-issue': {
      const issueId = args[1]
      if (!issueId || issueId.startsWith('--')) {
        console.error(
          'Usage: pnpm linear update-sub-issue <issue-id> [--state "Finished"] [--comment "Done"]'
        )
        process.exit(1)
      }
      const subOpts = parseArgs(args.slice(2))
      await updateSubIssue(issueId, {
        state: subOpts.state as string | undefined,
        comment: subOpts.comment as string | undefined,
      })
      break
    }

    case 'check-deployment': {
      const prArg = args[1]
      if (!prArg || prArg.startsWith('--')) {
        console.error('Usage: pnpm linear check-deployment <pr-number> [--format json|markdown]')
        process.exit(1)
      }
      const prNumber = parseInt(prArg, 10)
      if (isNaN(prNumber)) {
        console.error('PR number must be a valid integer')
        process.exit(1)
      }
      const format = (options.format as 'json' | 'markdown') || 'json'
      await checkDeployment(prNumber, format)
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
