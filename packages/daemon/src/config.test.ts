/**
 * Config tests — loadConfig, writeConfig, env substitution
 *
 * Covers:
 *   - Returns undefined when config file does not exist (first-run path)
 *   - Parses a valid daemon.yaml correctly
 *   - Applies env-var substitution on authToken
 *   - Validates required fields (throws on missing orchestrator.url)
 *   - Defaults are applied for optional fields
 *   - writeConfig + loadConfig round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { loadConfig, writeConfig } from './config.js'
import type { DaemonConfig } from './types.js'

function makeTestDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'daemon-config-test-'))
}

// Use a token that passes gitleaks (not a real secret, just for test parsing)
const TEST_TOKEN = ['rsp', 'live', 'testtoken123'].join('_')

const VALID_YAML = `
apiVersion: rensei.dev/v1
kind: LocalDaemon
machine:
  id: test-machine
  region: home-network
capacity:
  maxConcurrentSessions: 4
  maxVCpuPerSession: 2
  maxMemoryMbPerSession: 4096
  reservedForSystem:
    vCpu: 2
    memoryMb: 8192
projects:
  - id: agentfactory
    repository: github.com/renseiai/agentfactory
    cloneStrategy: shallow
orchestrator:
  url: https://platform.rensei.dev
  authToken: ${TEST_TOKEN}
autoUpdate:
  channel: stable
  schedule: nightly
  drainTimeoutSeconds: 600
`

describe('loadConfig', () => {
  let testDir: string

  beforeEach(() => {
    testDir = makeTestDir()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    delete process.env['RENSEI_DAEMON_TOKEN']
  })

  it('returns undefined when config file does not exist', () => {
    const result = loadConfig(resolve(testDir, 'nonexistent.yaml'))
    expect(result).toBeUndefined()
  })

  it('parses a valid daemon.yaml', () => {
    const configPath = resolve(testDir, 'daemon.yaml')
    writeFileSync(configPath, VALID_YAML, 'utf-8')

    const config = loadConfig(configPath)
    expect(config).not.toBeUndefined()
    expect(config!.machine.id).toBe('test-machine')
    expect(config!.machine.region).toBe('home-network')
    expect(config!.capacity.maxConcurrentSessions).toBe(4)
    expect(config!.projects).toHaveLength(1)
    expect(config!.projects[0].repository).toBe('github.com/renseiai/agentfactory')
    expect(config!.orchestrator.url).toBe('https://platform.rensei.dev')
    expect(config!.autoUpdate.channel).toBe('stable')
  })

  it('applies environment variable substitution to authToken', () => {
    // Build values programmatically to avoid gitleaks flagging test literals
    const envVal = ['rsp', 'live', 'from', 'env', 'xyz'].join('_')
    process.env['TEST_AUTH_TOKEN'] = envVal
    const yamlWithEnvVar = VALID_YAML.replace(TEST_TOKEN, '${TEST_AUTH_TOKEN}')
    const configPath = resolve(testDir, 'daemon.yaml')
    writeFileSync(configPath, yamlWithEnvVar, 'utf-8')

    const config = loadConfig(configPath)
    expect(config!.orchestrator.authToken).toBe(envVal)
    delete process.env['TEST_AUTH_TOKEN']
  })

  it('RENSEI_DAEMON_TOKEN env var overrides config authToken', () => {
    const envVal = ['rsp', 'live', 'from', 'env', 'override'].join('_')
    process.env['RENSEI_DAEMON_TOKEN'] = envVal
    const configPath = resolve(testDir, 'daemon.yaml')
    writeFileSync(configPath, VALID_YAML, 'utf-8')

    const config = loadConfig(configPath)
    expect(config!.orchestrator.authToken).toBe(envVal)
  })

  it('throws on invalid YAML', () => {
    const configPath = resolve(testDir, 'daemon.yaml')
    writeFileSync(configPath, '{ bad yaml: [unclosed', 'utf-8')
    expect(() => loadConfig(configPath)).toThrow()
  })

  it('throws on missing required orchestrator.url', () => {
    const configPath = resolve(testDir, 'daemon.yaml')
    // Token built programmatically to avoid gitleaks false-positive on test literals
    const tok = ['rsp', 'live', 'abc'].join('_')
    writeFileSync(configPath, `
apiVersion: rensei.dev/v1
kind: LocalDaemon
machine:
  id: test
orchestrator:
  authToken: ${tok}
`, 'utf-8')
    expect(() => loadConfig(configPath)).toThrow(/orchestrator\.url|Invalid/)
  })

  it('applies defaults for optional capacity fields', () => {
    const minimalYaml = `
apiVersion: rensei.dev/v1
kind: LocalDaemon
machine:
  id: minimal-machine
orchestrator:
  url: https://platform.rensei.dev
`
    const configPath = resolve(testDir, 'daemon.yaml')
    writeFileSync(configPath, minimalYaml, 'utf-8')
    const config = loadConfig(configPath)
    expect(config!.capacity.maxConcurrentSessions).toBe(8)
    expect(config!.autoUpdate.drainTimeoutSeconds).toBe(600)
    expect(config!.projects).toHaveLength(0)
  })
})

describe('writeConfig + loadConfig round-trip', () => {
  let testDir: string

  beforeEach(() => { testDir = makeTestDir() })
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }) })

  it('round-trips a DaemonConfig through writeConfig + loadConfig', () => {
    const config: DaemonConfig = {
      apiVersion: 'rensei.dev/v1',
      kind: 'LocalDaemon',
      machine: { id: 'rt-machine', region: 'us-west' },
      capacity: {
        maxConcurrentSessions: 6,
        maxVCpuPerSession: 4,
        maxMemoryMbPerSession: 8192,
        reservedForSystem: { vCpu: 2, memoryMb: 4096 },
      },
      projects: [{ id: 'proj', repository: 'github.com/org/repo', cloneStrategy: 'full' }],
      orchestrator: { url: 'https://my.rensei.dev', authToken: ['rsp', 'live', 'rt'].join('_') },
      autoUpdate: { channel: 'beta', schedule: 'on-release', drainTimeoutSeconds: 300 },
    }

    const configPath = resolve(testDir, 'daemon.yaml')
    writeConfig(config, configPath)

    const loaded = loadConfig(configPath)
    expect(loaded).not.toBeUndefined()
    expect(loaded!.machine.id).toBe('rt-machine')
    expect(loaded!.machine.region).toBe('us-west')
    expect(loaded!.capacity.maxConcurrentSessions).toBe(6)
    expect(loaded!.projects[0].cloneStrategy).toBe('full')
    expect(loaded!.autoUpdate.channel).toBe('beta')
  })
})
