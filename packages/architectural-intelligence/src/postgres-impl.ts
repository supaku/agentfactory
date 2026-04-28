/**
 * PostgresArchitecturalIntelligence — multi-tenant SaaS stub
 *
 * Architecture reference: rensei-architecture/007-intelligence-services.md
 * §"OSS vs SaaS responsibilities"
 *
 * This stub declares that the `ArchitecturalIntelligence` contract is real
 * and will be backed by the Postgres implementation in the SaaS control
 * plane, but defers the actual implementation to REN-1322.
 *
 * The SaaS implementation will:
 * - Reuse Memory's RLS layer (Postgres + pgvector + Cedar policies).
 * - Federate across multiple projects/repos within a tenant.
 * - Provide advanced drift detection rules configurable per-tenant.
 * - Expose the architecture browser via the dashboard (REN-1323+).
 *
 * Instantiating this class in any context will throw a descriptive error
 * that directs contributors to the correct issue.
 */

import type {
  ArchitecturalIntelligence,
  ArchQuerySpec,
  ArchView,
  ArchObservation,
  ArchScope,
  DriftReport,
  ChangeRef,
} from './types.js'

const NOT_IMPLEMENTED_MSG =
  'PostgresArchitecturalIntelligence is not yet implemented. ' +
  'This is the SaaS-only multi-tenant implementation — see REN-1322. ' +
  'For single-tenant local use, use SqliteArchitecturalIntelligence. ' +
  'For drift detection, use SqliteArchitecturalIntelligence.assessWithAdapter().'

/**
 * Multi-tenant SaaS implementation of ArchitecturalIntelligence.
 *
 * NOT IMPLEMENTED — all methods throw. See REN-1322.
 *
 * This class exists to:
 *   1. Declare that the ArchitecturalIntelligence interface has a planned
 *      Postgres-backed multi-tenant implementation.
 *   2. Provide a compile-time check that the interface is complete.
 *   3. Give clear error messages at runtime if accidentally instantiated.
 */
export class PostgresArchitecturalIntelligence implements ArchitecturalIntelligence {
  constructor() {
    throw new Error(NOT_IMPLEMENTED_MSG)
  }

  // The following methods are declared to satisfy the TypeScript interface
  // but will never be reached because the constructor throws.

  async query(_spec: ArchQuerySpec): Promise<ArchView> {
    throw new Error(NOT_IMPLEMENTED_MSG)
  }

  async contribute(_observation: ArchObservation): Promise<void> {
    throw new Error(NOT_IMPLEMENTED_MSG)
  }

  async synthesize(
    _scope: ArchScope,
    _format: 'markdown' | 'mermaid' | 'json',
  ): Promise<string> {
    throw new Error(NOT_IMPLEMENTED_MSG)
  }

  async assess(_change: ChangeRef): Promise<DriftReport> {
    throw new Error(NOT_IMPLEMENTED_MSG)
  }
}
