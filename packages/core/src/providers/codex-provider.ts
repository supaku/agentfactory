/**
 * OpenAI Codex Agent Provider (Stub)
 *
 * Will wrap @openai/codex-sdk to implement the AgentProvider interface.
 * Currently a placeholder — install the SDK and implement when ready.
 *
 * Expected SDK pattern:
 *   import { Codex } from '@openai/codex-sdk'
 *   const codex = new Codex({ apiKey })
 *   const thread = codex.startThread()
 *   const result = await thread.run(prompt)
 *   // or streamed: for await (const event of thread.runStreamed().events) { ... }
 */

import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
} from './types.js'

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const

  spawn(_config: AgentSpawnConfig): AgentHandle {
    throw new Error(
      'Codex provider is not yet implemented. Install @openai/codex-sdk and implement CodexProvider.'
    )
  }

  resume(_sessionId: string, _config: AgentSpawnConfig): AgentHandle {
    throw new Error(
      'Codex provider is not yet implemented. Install @openai/codex-sdk and implement CodexProvider.'
    )
  }
}

export function createCodexProvider(): CodexProvider {
  return new CodexProvider()
}
