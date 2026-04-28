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
 * Not yet shipped (separate issues):
 *   - Observation ingestion pipeline (REN-1316)
 *   - Synthesis prompts (REN-1317)
 *   - Drift detection algorithm (REN-1317)
 *   - Workarea seam wiring (REN-1324)
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
