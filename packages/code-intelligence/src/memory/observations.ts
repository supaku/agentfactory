/**
 * Agent Memory Observations
 *
 * Structured observation types captured from agent tool calls.
 * These form the write side of agent memory — observations are
 * persisted in the MemoryStore for cross-session retrieval.
 */

import { z } from 'zod'

// ── Observation Types ────────────────────────────────────────────────

export const ObservationTypeSchema = z.enum([
  'file_operation',
  'decision',
  'pattern_discovered',
  'error_encountered',
  'session_summary',
])
export type ObservationType = z.infer<typeof ObservationTypeSchema>

// ── File Operation Details ───────────────────────────────────────────

export const FileOperationTypeSchema = z.enum(['read', 'write', 'edit', 'delete', 'glob', 'grep'])
export type FileOperationType = z.infer<typeof FileOperationTypeSchema>

export const FileOperationDetailSchema = z.object({
  filePath: z.string(),
  operationType: FileOperationTypeSchema,
  summary: z.string(),
})
export type FileOperationDetail = z.infer<typeof FileOperationDetailSchema>

// ── Decision Details ─────────────────────────────────────────────────

export const DecisionDetailSchema = z.object({
  considered: z.string(),
  chosen: z.string(),
  reason: z.string(),
})
export type DecisionDetail = z.infer<typeof DecisionDetailSchema>

// ── Pattern Details ──────────────────────────────────────────────────

export const PatternDetailSchema = z.object({
  pattern: z.string(),
  context: z.string(),
})
export type PatternDetail = z.infer<typeof PatternDetailSchema>

// ── Error Details ────────────────────────────────────────────────────

export const ErrorDetailSchema = z.object({
  error: z.string(),
  fix: z.string().optional(),
})
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>

// ── Session Summary Details ──────────────────────────────────────────

export const SessionSummaryDetailSchema = z.object({
  outcome: z.enum(['success', 'failure', 'partial', 'cancelled']),
  outcomeDescription: z.string(),
  keyDecision: z.string().optional(),
  keyLearning: z.string().optional(),
  filesChanged: z.array(z.object({
    filePath: z.string(),
    changeSummary: z.string(),
  })).optional(),
  pitfalls: z.array(z.string()).optional(),
})
export type SessionSummaryDetail = z.infer<typeof SessionSummaryDetailSchema>

// ── Observation ──────────────────────────────────────────────────────

export const ObservationSchema = z.object({
  id: z.string().min(1),
  type: ObservationTypeSchema,
  content: z.string(),
  sessionId: z.string(),
  projectScope: z.string(),
  timestamp: z.number(),
  source: z.enum(['auto_capture', 'explicit']).default('auto_capture'),
  weight: z.number().default(1.0),
  detail: z.union([
    FileOperationDetailSchema,
    DecisionDetailSchema,
    PatternDetailSchema,
    ErrorDetailSchema,
    SessionSummaryDetailSchema,
  ]).optional(),
  tags: z.array(z.string()).optional(),
})
export type Observation = z.infer<typeof ObservationSchema>

// ── Observation Sink ─────────────────────────────────────────────────

/**
 * Sink for observations produced by the capture hook.
 * Implementations may store, forward, or batch observations.
 */
export interface ObservationSink {
  emit(observation: Observation): Promise<void>
}

/**
 * In-memory sink for testing — collects all emitted observations.
 */
export class InMemoryObservationSink implements ObservationSink {
  public observations: Observation[] = []

  async emit(observation: Observation): Promise<void> {
    this.observations.push(observation)
  }

  clear(): void {
    this.observations = []
  }
}

/**
 * No-op sink for when memory is disabled.
 */
export class NoopObservationSink implements ObservationSink {
  async emit(_observation: Observation): Promise<void> {
    // intentionally empty
  }
}
