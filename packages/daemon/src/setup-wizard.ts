/**
 * First-run setup wizard for the Rensei local daemon.
 *
 * Architecture reference:
 *   rensei-architecture/011-local-daemon-fleet.md §First-run setup
 *
 * The wizard runs interactively (via stdin/stdout) when:
 *   - process.stdin.isTTY is true, AND
 *   - RENSEI_DAEMON_SKIP_WIZARD is not set.
 *
 * It collects the minimum configuration to produce a valid ~/.rensei/daemon.yaml:
 *   [1/5] Machine identity (ID + region)
 *   [2/5] Capacity (cores, memory, max sessions)
 *   [3/5] Orchestrator (SaaS / self-hosted / local file queue)
 *   [4/5] Project allowlist (discovered from cwd git remote)
 *   [5/5] Auto-update (channel + schedule + drain timeout)
 *
 * The wizard is idempotent: if a config already exists, it re-prompts only
 * for changed values, preserving unchanged ones.
 *
 * In non-TTY environments (CI, test), the wizard is skipped and a default
 * config is returned (or the existing config is returned as-is).
 */

import * as readline from 'node:readline'
import { execSync } from 'node:child_process'
import { homedir, cpus, totalmem } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type { DaemonConfig } from './types.js'
import { deriveDefaultMachineId, writeConfig } from './config.js'

// ---------------------------------------------------------------------------
// Environment flag that bypasses the wizard (for tests and CI)
// ---------------------------------------------------------------------------

export function shouldSkipWizard(): boolean {
  return (
    !process.stdin.isTTY ||
    !!process.env['RENSEI_DAEMON_SKIP_WIZARD']
  )
}

// ---------------------------------------------------------------------------
// Interactive prompt helper
// ---------------------------------------------------------------------------

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim())
    })
  })
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await prompt(rl, `${question} ${hint}: `)
  if (answer === '') return defaultYes
  return answer.toLowerCase().startsWith('y')
}

async function promptDefault(
  rl: readline.Interface,
  question: string,
  defaultValue: string | number,
): Promise<string> {
  const answer = await prompt(rl, `  ${question} [${defaultValue}]: `)
  return answer === '' ? String(defaultValue) : answer
}

// ---------------------------------------------------------------------------
// System detection
// ---------------------------------------------------------------------------

function detectCpuCount(): number {
  return cpus().length
}

function detectMemoryMb(): number {
  return Math.floor(totalmem() / 1024 / 1024)
}

function defaultMaxSessions(cpuCount: number): number {
  // Heuristic from 011: ~1 session per 2 CPUs, capped at 8
  return Math.min(8, Math.max(1, Math.floor(cpuCount / 2)))
}

function detectGitRemote(): string | undefined {
  try {
    return execSync('git remote get-url origin', { stdio: 'pipe', encoding: 'utf-8' }).trim()
  } catch {
    return undefined
  }
}

function remoteToRepository(remote: string): string {
  // Normalize git remote URL to host/org/repo format
  // ssh: git@github.com:renseiai/agentfactory.git → github.com/renseiai/agentfactory
  // https: https://github.com/renseiai/agentfactory.git → github.com/renseiai/agentfactory
  return remote
    .replace(/^git@/, '')
    .replace(/^https?:\/\//, '')
    .replace(/:/, '/')
    .replace(/\.git$/, '')
}

// ---------------------------------------------------------------------------
// Default config builder (non-interactive fallback)
// ---------------------------------------------------------------------------

/**
 * Build a minimal default DaemonConfig without user interaction.
 * Used when the wizard is skipped (CI, non-TTY).
 *
 * The config is written only if configPath is provided.
 */
export function buildDefaultConfig(
  existingConfig?: DaemonConfig,
  configPath?: string,
): DaemonConfig {
  const cpuCount = detectCpuCount()
  const memMb = detectMemoryMb()

  const config: DaemonConfig = existingConfig ?? {
    apiVersion: 'rensei.dev/v1',
    kind: 'LocalDaemon',
    machine: {
      id: deriveDefaultMachineId(),
      region: 'local',
    },
    capacity: {
      maxConcurrentSessions: defaultMaxSessions(cpuCount),
      maxVCpuPerSession: 4,
      maxMemoryMbPerSession: 8192,
      reservedForSystem: {
        vCpu: Math.min(4, Math.floor(cpuCount / 4)),
        memoryMb: Math.min(16384, Math.floor(memMb / 4)),
      },
    },
    projects: [],
    orchestrator: {
      url: process.env['RENSEI_ORCHESTRATOR_URL'] ?? 'https://platform.rensei.dev',
      authToken: process.env['RENSEI_DAEMON_TOKEN'],
    },
    autoUpdate: {
      channel: 'stable',
      schedule: 'nightly',
      drainTimeoutSeconds: 600,
    },
  }

  if (configPath) {
    writeConfig(config, configPath)
  }

  return config
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

/**
 * Run the interactive first-run setup wizard.
 *
 * @param existingConfig - Existing config (if any) to use as defaults.
 * @param configPath - Where to write the resulting config.
 * @returns The completed DaemonConfig (also written to disk).
 */
export async function runSetupWizard(
  existingConfig?: DaemonConfig,
  configPath?: string,
): Promise<DaemonConfig> {
  if (shouldSkipWizard()) {
    return buildDefaultConfig(existingConfig, configPath)
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    const cpuCount = detectCpuCount()
    const memMb = detectMemoryMb()

    console.log('\nWelcome to Rensei. Let\'s get your machine working.\n')

    // -----------------------------------------------------------------------
    // [1/5] Machine identity
    // -----------------------------------------------------------------------
    console.log('[1/5] Machine identity')
    const defaultId = existingConfig?.machine.id ?? deriveDefaultMachineId()
    const defaultRegion = existingConfig?.machine.region ?? 'home-network'

    const machineId = await promptDefault(rl, 'Machine ID (auto-generated)', defaultId)
    const region = await promptDefault(rl, 'Region (helps the scheduler with latency)', defaultRegion)
    if (!await confirm(rl, '  Continue?')) {
      throw new Error('Setup wizard cancelled by user.')
    }
    console.log()

    // -----------------------------------------------------------------------
    // [2/5] Capacity
    // -----------------------------------------------------------------------
    console.log('[2/5] Capacity')
    console.log(`  Detected: ${cpuCount} cores, ${Math.round(memMb / 1024)} GB RAM`)
    const defaultReservedCores = existingConfig?.capacity.reservedForSystem.vCpu ?? Math.min(4, Math.floor(cpuCount / 4))
    const defaultReservedMem = existingConfig?.capacity.reservedForSystem.memoryMb ?? Math.min(16384, Math.floor(memMb / 4))
    const defaultMaxSess = existingConfig?.capacity.maxConcurrentSessions ?? defaultMaxSessions(cpuCount)

    const reservedCores = parseInt(await promptDefault(rl, 'Reserve cores for system', defaultReservedCores), 10)
    const reservedMemMb = parseInt(await promptDefault(rl, 'Reserve memory MB for system', defaultReservedMem), 10)
    const maxSessions = parseInt(await promptDefault(rl, 'Max concurrent sessions', defaultMaxSess), 10)
    if (!await confirm(rl, '  Continue?')) {
      throw new Error('Setup wizard cancelled by user.')
    }
    console.log()

    // -----------------------------------------------------------------------
    // [3/5] Orchestrator
    // -----------------------------------------------------------------------
    console.log('[3/5] Orchestrator')
    console.log('  Where do work assignments come from?')
    console.log('  > 1. Rensei Platform (SaaS)        — register with platform.rensei.dev')
    console.log('    2. Self-hosted (OSS only)         — point at your own webhook target')
    console.log('    3. Local file queue (single-user) — for solo dev, no network')
    const choiceStr = await promptDefault(rl, 'Choice', existingConfig ? '1' : '1')
    const choice = parseInt(choiceStr, 10)

    let orchestratorUrl: string
    let authToken: string | undefined = existingConfig?.orchestrator.authToken

    switch (choice) {
      case 2: {
        orchestratorUrl = await promptDefault(rl, 'Orchestrator URL', existingConfig?.orchestrator.url ?? 'https://your-rensei-instance.example.com') as string
        break
      }
      case 3: {
        const queuePath = resolvePath(homedir(), '.rensei', 'queue')
        orchestratorUrl = `file://${queuePath}`
        console.log(`  Using local file queue at ${queuePath}`)
        break
      }
      default: {
        orchestratorUrl = 'https://platform.rensei.dev'
        const envToken = process.env['RENSEI_DAEMON_TOKEN']
        if (!envToken && !authToken) {
          const token = await promptDefault(rl, 'Registration token (rsp_live_...)', '')
          if (token) authToken = token
        } else {
          authToken = envToken ?? authToken
          console.log(`  ✔ Using registration token from ${envToken ? 'RENSEI_DAEMON_TOKEN env var' : 'existing config'}`)
        }
        break
      }
    }
    if (!await confirm(rl, '  Continue?')) {
      throw new Error('Setup wizard cancelled by user.')
    }
    console.log()

    // -----------------------------------------------------------------------
    // [4/5] Project allowlist
    // -----------------------------------------------------------------------
    console.log('[4/5] Project allowlist')
    const projects = [...(existingConfig?.projects ?? [])]
    const detectedRemote = detectGitRemote()
    if (detectedRemote) {
      const repo = remoteToRepository(detectedRemote)
      const alreadyAdded = projects.some((p) => p.repository === repo)
      if (!alreadyAdded) {
        const addIt = await confirm(rl, `  Detected: ${repo}  [add?]`)
        if (addIt) {
          projects.push({ id: repo.split('/').pop() ?? repo, repository: repo })
        }
      }
    }

    const addMore = await confirm(rl, '  Add another project?', false)
    if (addMore) {
      const repoUrl = await promptDefault(rl, 'Repository (e.g. github.com/org/repo)', '')
      if (repoUrl) {
        projects.push({ id: String(repoUrl).split('/').pop() ?? String(repoUrl), repository: String(repoUrl) })
      }
    }
    if (!await confirm(rl, '  Continue?')) {
      throw new Error('Setup wizard cancelled by user.')
    }
    console.log()

    // -----------------------------------------------------------------------
    // [5/5] Auto-update
    // -----------------------------------------------------------------------
    console.log('[5/5] Auto-update')
    const channelStr = await promptDefault(rl, 'Channel (stable/beta/main)', existingConfig?.autoUpdate.channel ?? 'stable')
    const scheduleStr = await promptDefault(rl, 'Schedule (nightly/on-release/manual)', existingConfig?.autoUpdate.schedule ?? 'nightly')
    const drainTimeoutStr = await promptDefault(rl, 'Drain timeout seconds', existingConfig?.autoUpdate.drainTimeoutSeconds ?? 600)
    console.log()

    // -----------------------------------------------------------------------
    // Assemble and write config
    // -----------------------------------------------------------------------
    const config: DaemonConfig = {
      apiVersion: 'rensei.dev/v1',
      kind: 'LocalDaemon',
      machine: { id: machineId, region },
      capacity: {
        maxConcurrentSessions: isNaN(maxSessions) ? 8 : maxSessions,
        maxVCpuPerSession: existingConfig?.capacity.maxVCpuPerSession ?? 4,
        maxMemoryMbPerSession: existingConfig?.capacity.maxMemoryMbPerSession ?? 8192,
        reservedForSystem: {
          vCpu: isNaN(reservedCores) ? 4 : reservedCores,
          memoryMb: isNaN(reservedMemMb) ? 16384 : reservedMemMb,
        },
      },
      projects,
      orchestrator: { url: orchestratorUrl, authToken },
      autoUpdate: {
        channel: (['stable', 'beta', 'main'].includes(channelStr) ? channelStr : 'stable') as 'stable' | 'beta' | 'main',
        schedule: (['nightly', 'on-release', 'manual'].includes(scheduleStr) ? scheduleStr : 'nightly') as 'nightly' | 'on-release' | 'manual',
        drainTimeoutSeconds: parseInt(drainTimeoutStr, 10) || 600,
      },
    }

    if (configPath) {
      writeConfig(config, configPath)
      console.log(`✔ Setup complete. Config written to ${configPath}`)
    }

    console.log('  Status: rensei daemon status')
    console.log('  Logs:   rensei daemon logs')
    console.log('  Stop:   rensei daemon stop\n')

    return config
  } finally {
    rl.close()
  }
}
