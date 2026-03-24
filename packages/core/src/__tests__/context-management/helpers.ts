import type { AgentEvent, AgentToolUseEvent, AgentAssistantTextEvent, AgentSystemEvent } from '../../providers/types.js'
import type { StructuredSummary } from '../../orchestrator/state-types.js'
import { SUMMARY_SCHEMA_VERSION } from '../../orchestrator/state-types.js'
import type { ArtifactIndex } from '../../orchestrator/artifact-tracker.js'

export function makeToolUse(toolName: string, input: Record<string, unknown>): AgentToolUseEvent {
  return { type: 'tool_use', toolName, input, raw: {} }
}

export function makeAssistantText(text: string): AgentAssistantTextEvent {
  return { type: 'assistant_text', text, raw: {} }
}

export function makeCompactBoundary(): AgentSystemEvent {
  return { type: 'system', subtype: 'compact_boundary', raw: {} }
}

export function makeEmptyArtifacts(): ArtifactIndex {
  return { files: {}, totalReads: 0, totalWrites: 0, lastUpdatedAt: 0 }
}

export function makeSummary(overrides: Partial<StructuredSummary> = {}): StructuredSummary {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    sessionIntent: 'Test session intent',
    fileModifications: [],
    decisionsMade: [],
    nextSteps: [],
    compactionCount: 1,
    lastCompactedAt: Date.now(),
    tokenEstimate: 100,
    ...overrides,
  }
}

/**
 * Generate a simulated session event sequence for testing
 */
export function generateSessionEvents(config: {
  fileCount: number
  assistantMessages: number
  toolCallsPerFile?: number
}): AgentEvent[] {
  const events: AgentEvent[] = []
  const toolCallsPerFile = config.toolCallsPerFile ?? 2

  // Add initial assistant message with intent
  events.push(makeAssistantText(
    'I will implement the requested feature by modifying the relevant source files and adding tests.'
  ))

  // Generate file operations
  for (let i = 0; i < config.fileCount; i++) {
    const filePath = `/src/file-${i}.ts`

    // Read the file
    events.push(makeToolUse('Read', { file_path: filePath }))

    // Edit the file
    for (let j = 0; j < toolCallsPerFile - 1; j++) {
      events.push(makeToolUse('Edit', { file_path: filePath, old_string: `old-${j}`, new_string: `new-${j}` }))
    }

    // Add assistant commentary
    if (i < config.assistantMessages) {
      events.push(makeAssistantText(`Modified file-${i}.ts to update the implementation logic.`))
    }
  }

  return events
}

/**
 * Generate an artifact index from file operations
 */
export function generateArtifactIndex(filePaths: string[]): ArtifactIndex {
  const files: ArtifactIndex['files'] = {}
  for (const path of filePaths) {
    files[path] = {
      path,
      relativePath: path.replace(/^\//, ''),
      actions: ['read', 'modified'],
      firstSeenAt: 1000,
      lastTouchedAt: 2000,
    }
  }
  return {
    files,
    totalReads: filePaths.length,
    totalWrites: filePaths.length,
    lastUpdatedAt: Date.now(),
  }
}

/**
 * Quality metrics for evaluating context management
 */
export interface ContextQualityMetrics {
  /** Fraction of planted facts that survived compression (0-1) */
  factualRetentionScore: number
  /** Fraction of file operations correctly tracked (0-1) */
  fileTrackingAccuracy: number
  /** Fraction of next steps that are coherent (0-1) */
  nextStepsCoherence: number
  /** Fraction of decisions preserved (0-1) */
  decisionPreservation: number
  /** Ratio of tokens saved to tokens dropped */
  compressionRatio: number
}
