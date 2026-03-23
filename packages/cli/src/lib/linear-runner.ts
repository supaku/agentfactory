/**
 * Linear CLI Runner — re-exports from @renseiai/plugin-linear.
 *
 * The canonical implementation lives in packages/linear/src/tools/linear-runner.ts
 * so both the CLI and the in-process tool plugin share a single source of truth.
 */
export {
  runLinear,
  parseLinearArgs,
  type LinearRunnerConfig,
  type LinearRunnerResult,
} from '@renseiai/plugin-linear'
