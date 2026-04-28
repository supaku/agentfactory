/**
 * @renseiai/architectural-intelligence — public API
 *
 * Architecture reference: rensei-architecture/007-intelligence-services.md
 * §Architectural Intelligence
 *
 * Package skeleton (REN-1315). Ships:
 *   - Full type vocabulary (types.ts)
 *   - ArchitecturalIntelligence interface (types.ts)
 *   - Single-tenant local implementation: SqliteArchitecturalIntelligence
 *   - Multi-tenant SaaS stub: PostgresArchitecturalIntelligence (throws; see REN-1322)
 *
 * Observation pipeline (REN-1324). Ships:
 *   - runObservationPass     — main pipeline entry point (pipeline.ts)
 *   - attachPipelineSubscribers — hook bus integration (pipeline.ts)
 *   - PrDiff / readDiffObservations — VCS diff reader (diff-reader.ts)
 *   - clusterObservations / effectiveConfidence — cluster+dedupe (cluster.ts)
 *   - isAuthoredDoc / makeAuthoredObservation — authored intent helpers
 *   - createTestBus          — in-package test hook bus
 *
 * Synthesis prompts (REN-1325). Ships:
 *   - promptRegistry / currentPrompt / versionedPrompt — versioned prompt registry
 *   - v1 prompts: pattern-extraction, convention-identification,
 *                 decision-recording, deviation-detection
 *   - evaluatePrompt / createStubAdapter / createFixedAdapter — eval rubric harness
 *   - compareABPrompts / formatABReport — A/B testing harness
 *
 * Not yet shipped (separate issues):
 *   - Drift detection algorithm (REN-1317)
 *   - MCP tool exposure (REN-1323)
 */

// Types + interface
export type {
  ArchitecturalIntelligence,
  ArchQuerySpec,
  ArchView,
  ArchObservation,
  ArchScope,
  WorkType,
  ArchitecturalPattern,
  Convention,
  Decision,
  Deviation,
  DriftReport,
  Citation,
  CitationConfidence,
  ChangeRef,
} from './types.js'

export { CITATION_CONFIDENCE_RANK } from './types.js'

// Implementations
export { SqliteArchitecturalIntelligence } from './sqlite-impl.js'
export type { SqliteArchConfig } from './sqlite-impl.js'

export { PostgresArchitecturalIntelligence } from './postgres-impl.js'

// Observation pipeline (REN-1324)
export {
  runObservationPass,
  attachPipelineSubscribers,
  isAuthoredDoc,
  makeAuthoredObservation,
  createTestBus,
  MEMORY_OBSERVATION_KINDS,
} from './pipeline.js'
export type {
  RunObservationPassInput,
  RunObservationPassResult,
  PipelineSubscriberOptions,
  PipelineHookBus,
  PipelineHookEvent,
  PipelineHookHandler,
  MemoryObservationEvent,
  MemoryObservationKind,
} from './pipeline.js'

// VCS diff reader (REN-1324)
export { readDiffObservations } from './diff-reader.js'
export type { PrDiff, PrFileDiff, DiffReaderConfig } from './diff-reader.js'

// Cluster + dedupe (REN-1324)
export { clusterObservations, effectiveConfidence, _jaccardSimilarity } from './cluster.js'
export type { ClusterConfig, ObservationWithTimestamp, ClusterResult } from './cluster.js'

// Synthesis prompts (REN-1325)
export {
  promptRegistry,
  currentPrompt,
  versionedPrompt,
  CURRENT_PROMPT_VERSION,
} from './prompts/index.js'
export type {
  PromptVersion,
  PromptModule,
  PromptRegistry,
  PatternExtractionModule,
  ConventionIdentificationModule,
  DecisionRecordingModule,
  DeviationDetectionModule,
  PatternExtractionInput,
  PatternExtractionOutput,
  ConventionIdentificationInput,
  ConventionIdentificationOutput,
  DecisionRecordingInput,
  DecisionRecordingOutput,
  DeviationDetectionInput,
  DeviationDetectionOutput,
  BaselineEntry,
} from './prompts/index.js'

// Eval rubric harness (REN-1325)
export { evaluatePrompt, createStubAdapter, createFixedAdapter } from './eval.js'
export type { ModelAdapter, EvalScore, EvalConfig } from './eval.js'

// A/B test harness (REN-1325)
export { compareABPrompts, formatABReport } from './ab-test.js'
export type {
  ABRunResult,
  ABSummary,
  ABTestResult,
  ABTestConfig,
} from './ab-test.js'
