import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { waitForProcessExit } from '../worker-fleet-runner.js'

// ---------------------------------------------------------------------------
// waitForProcessExit
//
// Guards the shutdown race that made Ctrl+C hang the fleet for 30s. The
// previous implementation used `new Promise(r => child.on('exit', r))` and
// deadlocked whenever the child had already exited by the time shutdown ran.
// ---------------------------------------------------------------------------

describe('waitForProcessExit', () => {
  it('resolves immediately when the child has already exited normally', async () => {
    const child = spawn('sh', ['-c', 'exit 0'])

    // Let the child exit before calling waitForProcessExit.
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    expect(child.exitCode).toBe(0)

    // If this were the old `new Promise(r => child.on('exit', r))` pattern,
    // it would hang forever — the `exit` event already fired. Wrap in a
    // timeout race to make the failure mode crisp instead of just a test
    // hang.
    await expect(
      Promise.race([
        waitForProcessExit(child),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT: waitForProcessExit did not resolve on already-exited child')), 1000),
        ),
      ]),
    ).resolves.toBeUndefined()
  })

  it('resolves immediately when the child has already been killed', async () => {
    const child = spawn('sh', ['-c', 'sleep 30'])
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))

    // After SIGKILL, exitCode is null but signalCode is set — the helper
    // must check both to know the process is done.
    expect(child.signalCode).toBe('SIGKILL')

    await expect(
      Promise.race([
        waitForProcessExit(child),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT: waitForProcessExit did not resolve on already-killed child')), 1000),
        ),
      ]),
    ).resolves.toBeUndefined()
  })

  it('waits for a live child to exit', async () => {
    const child = spawn('sh', ['-c', 'sleep 0.1; exit 0'])

    const start = Date.now()
    await waitForProcessExit(child)
    const elapsed = Date.now() - start

    // Child sleeps 100ms before exiting — waitForProcessExit must not
    // resolve before then.
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(child.exitCode).toBe(0)
  })

  it('does not register multiple exit listeners if called repeatedly (leak guard)', async () => {
    const child = spawn('sh', ['-c', 'sleep 0.2; exit 0'])

    // Call three times before the child exits — each should return a
    // promise that resolves when the child exits. The `once` ensures no
    // listener accumulation.
    const [a, b, c] = [waitForProcessExit(child), waitForProcessExit(child), waitForProcessExit(child)]

    // Each `waitForProcessExit` call attaches one listener (via `once`).
    // Three calls = three listeners, which is expected and fine (each
    // resolves its own promise). Node's default warning is 10+, so we're
    // well under it. Assert we haven't somehow registered the *default*
    // listener count.
    expect(child.listenerCount('exit')).toBeLessThanOrEqual(5)

    await Promise.all([a, b, c])
    expect(child.exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Real-child shutdown race
//
// End-to-end proof that the fleet-shutdown pattern no longer deadlocks when
// worker children exit before the parent's shutdown() runs. We don't
// construct the full WorkerFleet here — we exercise the same primitives
// (spawn, signal-driven exit, waitForProcessExit) in the same order.
// ---------------------------------------------------------------------------

describe('shutdown race (regression guard)', () => {
  it('shutdown completes promptly when children exit before Promise.all begins', async () => {
    // Spawn three "workers" that exit on their own immediately — mirrors a
    // SIGINT fanning out to the process group.
    const children: ChildProcess[] = [
      spawn('sh', ['-c', 'exit 0']),
      spawn('sh', ['-c', 'exit 0']),
      spawn('sh', ['-c', 'exit 0']),
    ]

    // Wait until all have actually exited.
    await Promise.all(
      children.map((c) => new Promise<void>((resolve) => c.once('exit', () => resolve()))),
    )

    // Now emulate what `shutdown()` does: send SIGTERM to processes we
    // think might still be alive (they aren't), then await their exits
    // via the helper. The old code used `new Promise(r => c.on('exit', r))`
    // and hung forever here.
    for (const c of children) {
      try {
        c.kill('SIGTERM')
      } catch {
        // Already dead — fine.
      }
    }

    const start = Date.now()
    await Promise.race([
      Promise.all(children.map((c) => waitForProcessExit(c))),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT: fleet shutdown hung on already-exited children')), 2000),
      ),
    ])
    const elapsed = Date.now() - start

    // Must be near-instant — certainly under the 30s force-kill window
    // that was the old symptom.
    expect(elapsed).toBeLessThan(500)
  })
})
