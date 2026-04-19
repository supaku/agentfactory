/**
 * Vercel Deployment Provider
 *
 * Implements DeployProvider for Vercel platform.
 * Wraps the existing deployment-checker logic in a class-based provider.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type {
  DeployProvider,
  DeploymentStatus,
  DeploymentCheckResult,
  DeploymentCheckOptions,
  IssuePRInfo,
} from './types.js'

const execAsync = promisify(exec)

const DEFAULT_OPTIONS: Required<DeploymentCheckOptions> = {
  owner: 'renseiai',
  repo: 'agentfactory',
  timeout: 30000,
}

/**
 * Parse Vercel app name from GitHub status context
 */
function parseAppName(context: string): string {
  const match = context.match(/Vercel\s*[–-]\s*(.+)/)
  if (match) {
    return match[1].trim()
  }
  return context
}

/**
 * Check if a status description indicates a successful skip (monorepo optimization)
 */
function isSuccessfulSkip(description: string): boolean {
  return description.toLowerCase().includes('skipped') &&
         description.toLowerCase().includes('not affected')
}

/**
 * Map GitHub status state to normalized state
 */
function normalizeState(
  state: string,
  description: string
): DeploymentStatus['state'] {
  if (isSuccessfulSkip(description)) {
    return 'success'
  }
  switch (state.toLowerCase()) {
    case 'success': return 'success'
    case 'pending': return 'pending'
    case 'failure': return 'failure'
    case 'error': return 'error'
    default: return 'pending'
  }
}

export class VercelDeployProvider implements DeployProvider {
  readonly name = 'vercel'
  private readonly options: DeploymentCheckOptions

  constructor(options?: Record<string, unknown>) {
    this.options = {
      owner: (options?.owner as string) ?? DEFAULT_OPTIONS.owner,
      repo: (options?.repo as string) ?? DEFAULT_OPTIONS.repo,
      timeout: (options?.timeout as number) ?? DEFAULT_OPTIONS.timeout,
    }
  }

  async checkDeployment(commitSha: string, options?: DeploymentCheckOptions): Promise<DeploymentCheckResult> {
    const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...this.options, ...options }

    const { stdout } = await execAsync(
      `gh api repos/${owner}/${repo}/commits/${commitSha}/status`,
      { timeout }
    )

    const response = JSON.parse(stdout)

    const allStatuses: Array<{
      context: string
      state: string
      description: string
      target_url: string | null
    }> = response.statuses || []

    const vercelStatuses = allStatuses.filter(
      (s) => s.context.toLowerCase().includes('vercel')
    )

    const deploymentStatuses: DeploymentStatus[] = vercelStatuses.map((s) => ({
      app: parseAppName(s.context),
      state: normalizeState(s.state, s.description || ''),
      description: s.description || '',
      targetUrl: s.target_url,
      context: s.context,
    }))

    const allSucceeded = deploymentStatuses.length > 0 &&
      deploymentStatuses.every((s) => s.state === 'success')
    const anyFailed = deploymentStatuses.some(
      (s) => s.state === 'failure' || s.state === 'error'
    )
    const anyPending = deploymentStatuses.some((s) => s.state === 'pending')

    return {
      allSucceeded,
      anyFailed,
      anyPending,
      statuses: deploymentStatuses,
      commitSha,
      overallState: response.state || 'unknown',
    }
  }

  async checkPRDeployment(prNumber: number, options?: DeploymentCheckOptions): Promise<DeploymentCheckResult | null> {
    const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...this.options, ...options }

    let commitSha: string | null = null
    try {
      const { stdout } = await execAsync(
        `gh api repos/${owner}/${repo}/pulls/${prNumber} --jq '.head.sha'`,
        { timeout }
      )
      commitSha = stdout.trim() || null
    } catch {
      return null
    }

    if (!commitSha) {
      return null
    }
    return this.checkDeployment(commitSha, options)
  }

  async checkIssueDeployment(issueIdentifier: string, options?: DeploymentCheckOptions): Promise<(DeploymentCheckResult & { pr: IssuePRInfo }) | null> {
    const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...this.options, ...options }

    let prs: IssuePRInfo[] = []
    try {
      const { stdout } = await execAsync(
        `gh pr list --repo ${owner}/${repo} --state open --json number,headRefName,headRefOid,title,url --search "${issueIdentifier}"`,
        { timeout }
      )

      const rawPrs = JSON.parse(stdout || '[]')
      const lowerIdentifier = issueIdentifier.toLowerCase()
      const matchingPRs = rawPrs.filter((pr: { headRefName: string; title: string }) => {
        const branchMatch = pr.headRefName.toLowerCase().includes(lowerIdentifier)
        const titleMatch = pr.title.toLowerCase().includes(lowerIdentifier)
        return branchMatch || titleMatch
      })

      prs = matchingPRs.map(
        (pr: { number: number; headRefOid: string; headRefName: string; title: string; url: string }) => ({
          number: pr.number,
          headSha: pr.headRefOid,
          branch: pr.headRefName,
          title: pr.title,
          url: pr.url,
        })
      )
    } catch {
      return null
    }

    if (prs.length === 0) {
      return null
    }

    const pr = prs[0]
    const result = await this.checkDeployment(pr.headSha, options)

    return {
      ...result,
      pr,
    }
  }
}
