/**
 * Linear CLI Runner — re-exports from @supaku/agentfactory (core).
 *
 * The canonical implementation lives in packages/core/src/tools/linear-runner.ts
 * so both the CLI and the in-process tool plugin share a single source of truth.
 */
export {
  runLinear,
  parseLinearArgs,
  type LinearRunnerConfig,
  type LinearRunnerResult,
} from '@supaku/agentfactory'
