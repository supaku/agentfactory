/**
 * REN-1342: orchestrator.ts size assertion test.
 *
 * The phase-2 decomposition mandates orchestrator.ts ≤ 2000 lines.
 * This test pins that contract — it fails the build if the file grows back.
 *
 * If you're tempted to bump this number, the answer is almost always:
 * extract more code into focused modules (event-processor.ts,
 * agent-spawner.ts, dispatcher.ts, session-supervisor.ts, workarea/*).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { describe, it, expect } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('orchestrator.ts decomposition (REN-1342)', () => {
  it('orchestrator.ts is under 2000 lines', () => {
    const path = resolve(__dirname, 'orchestrator.ts')
    const lines = readFileSync(path, 'utf-8').split('\n').length
    expect(lines).toBeLessThanOrEqual(2000)
  })

  it('dispatcher.ts module exists (work-queue + capability routing)', () => {
    const path = resolve(__dirname, 'dispatcher.ts')
    const content = readFileSync(path, 'utf-8')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('export function detectWorkType')
  })

  it('session-supervisor.ts module exists (heartbeat, drain, reap)', () => {
    const path = resolve(__dirname, 'session-supervisor.ts')
    const content = readFileSync(path, 'utf-8')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('export function evaluateDrainReap')
  })

  it('event-processor.ts module exists (extracted event-stream loop)', () => {
    const path = resolve(__dirname, 'event-processor.ts')
    const content = readFileSync(path, 'utf-8')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('export async function processEventStream')
    expect(content).toContain('export async function handleAgentEvent')
  })

  it('agent-spawner.ts module exists (extracted spawn lifecycle)', () => {
    const path = resolve(__dirname, 'agent-spawner.ts')
    const content = readFileSync(path, 'utf-8')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('export function spawnAgent')
    expect(content).toContain('export async function spawnAgentForIssue')
    expect(content).toContain('export async function spawnAgentWithResume')
  })
})
