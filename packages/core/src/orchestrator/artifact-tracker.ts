import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve, relative } from 'path'
import type { AgentToolUseEvent, AgentEvent } from '../providers/types.js'
import { initializeAgentDir, getAgentDir } from './state-recovery.js'

/**
 * Extended file action type for the artifact tracker.
 * Includes 'searched' beyond what StructuredSummary uses.
 */
export type TrackedFileAction = 'read' | 'created' | 'modified' | 'deleted' | 'searched'

/**
 * A tracked file with its operation history
 */
export interface TrackedFile {
  /** Absolute file path */
  path: string
  /** Path relative to worktree root */
  relativePath: string
  /** Chronological list of operations performed */
  actions: TrackedFileAction[]
  /** Unix timestamp when file was first encountered */
  firstSeenAt: number
  /** Unix timestamp of most recent operation */
  lastTouchedAt: number
  /** Number of lines read (from Read tool) */
  linesRead?: number
  /** Number of lines modified (from Edit/Write tools) */
  linesModified?: number
}

/**
 * The full artifact index
 */
export interface ArtifactIndex {
  /** Map of absolute path to tracked file info */
  files: Record<string, TrackedFile>
  /** Total read operations performed */
  totalReads: number
  /** Total write operations performed */
  totalWrites: number
  /** Unix timestamp of last index update */
  lastUpdatedAt: number
}

/**
 * Serialized format for persistence (JSON-compatible)
 */
interface SerializedArtifactIndex {
  files: Record<string, TrackedFile>
  totalReads: number
  totalWrites: number
  lastUpdatedAt: number
}

/**
 * Tracks files read/modified during an agent session.
 * Parses tool_use events to extract file operations and maintains
 * a persistent index for context window management.
 */
export class ArtifactTracker {
  private index: ArtifactIndex
  private worktreeRoot: string

  constructor(worktreeRoot: string, existingIndex?: ArtifactIndex) {
    this.worktreeRoot = worktreeRoot
    this.index = existingIndex ?? {
      files: {},
      totalReads: 0,
      totalWrites: 0,
      lastUpdatedAt: Date.now(),
    }
  }

  /**
   * Process an agent event to extract file operations.
   * Only processes tool_use events (not tool_result).
   */
  trackEvent(event: AgentEvent): void {
    if (event.type !== 'tool_use') return
    this.trackToolUseEvent(event)
  }

  /**
   * Process a tool_use event to extract file operations
   */
  private trackToolUseEvent(event: AgentToolUseEvent): void {
    const { toolName, input } = event
    const now = Date.now()

    switch (toolName) {
      case 'Read': {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          this.recordAction(filePath, 'read', now)
          this.index.totalReads++
        }
        break
      }
      case 'Write': {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          // Check if file exists to determine created vs modified
          const action = existsSync(filePath) ? 'modified' : 'created'
          this.recordAction(filePath, action, now)
          this.index.totalWrites++
        }
        break
      }
      case 'Edit': {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          this.recordAction(filePath, 'modified', now)
          this.index.totalWrites++
        }
        break
      }
      case 'Glob': {
        // Glob results are in tool_result, not tool_use; we track the search pattern
        // We don't track individual files from glob since results come in tool_result
        break
      }
      case 'Grep': {
        // Similar to Glob — results come in tool_result
        break
      }
      case 'Bash': {
        const command = input.command as string | undefined
        if (command) {
          this.parseBashCommand(command, now)
        }
        break
      }
    }
  }

  /**
   * Parse bash commands for file operation heuristics
   */
  private parseBashCommand(command: string, timestamp: number): void {
    // Detect rm commands
    const rmMatch = command.match(/\brm\s+(?:-[rRfv]+\s+)*([^\s|;&]+)/)
    if (rmMatch && rmMatch[1]) {
      this.recordAction(rmMatch[1], 'deleted', timestamp)
      this.index.totalWrites++
    }

    // Detect mv commands (source deleted, dest created)
    const mvMatch = command.match(/\bmv\s+(?:-[fv]+\s+)*([^\s|;&]+)\s+([^\s|;&]+)/)
    if (mvMatch && mvMatch[1] && mvMatch[2]) {
      this.recordAction(mvMatch[1], 'deleted', timestamp)
      this.recordAction(mvMatch[2], 'created', timestamp)
      this.index.totalWrites += 2
    }
  }

  /**
   * Record a file action in the index
   */
  private recordAction(filePath: string, action: TrackedFileAction, timestamp: number): void {
    const absPath = resolve(this.worktreeRoot, filePath)
    const relPath = relative(this.worktreeRoot, absPath)

    const existing = this.index.files[absPath]
    if (existing) {
      existing.actions.push(action)
      existing.lastTouchedAt = timestamp
    } else {
      this.index.files[absPath] = {
        path: absPath,
        relativePath: relPath,
        actions: [action],
        firstSeenAt: timestamp,
        lastTouchedAt: timestamp,
      }
    }
    this.index.lastUpdatedAt = timestamp
  }

  /**
   * Get the current artifact index
   */
  getIndex(): ArtifactIndex {
    return this.index
  }

  /**
   * Get files matching optional filters
   */
  getFiles(filter?: { action?: TrackedFileAction; glob?: string }): TrackedFile[] {
    let files = Object.values(this.index.files)

    if (filter?.action) {
      files = files.filter(f => f.actions.includes(filter.action!))
    }

    if (filter?.glob) {
      const pattern = filter.glob
      files = files.filter(f => {
        // Simple glob matching: * matches anything except /, ** matches anything
        const regex = new RegExp(
          '^' + pattern
            .replace(/\*\*/g, '___DOUBLESTAR___')
            .replace(/\*/g, '[^/]*')
            .replace(/___DOUBLESTAR___/g, '.*')
            .replace(/\?/g, '[^/]') + '$'
        )
        return regex.test(f.relativePath)
      })
    }

    return files
  }

  /**
   * Persist the index to .agent/artifacts.json atomically
   */
  persist(): void {
    const agentDir = getAgentDir(this.worktreeRoot)
    initializeAgentDir(this.worktreeRoot)
    const artifactsPath = resolve(agentDir, 'artifacts.json')
    const tempPath = artifactsPath + '.tmp'
    const serialized: SerializedArtifactIndex = {
      files: this.index.files,
      totalReads: this.index.totalReads,
      totalWrites: this.index.totalWrites,
      lastUpdatedAt: this.index.lastUpdatedAt,
    }
    writeFileSync(tempPath, JSON.stringify(serialized, null, 2))
    renameSync(tempPath, artifactsPath)
  }

  /**
   * Load a persisted artifact index from .agent/artifacts.json
   */
  static load(worktreeRoot: string): ArtifactTracker {
    const artifactsPath = resolve(getAgentDir(worktreeRoot), 'artifacts.json')
    try {
      if (!existsSync(artifactsPath)) {
        return new ArtifactTracker(worktreeRoot)
      }
      const content = readFileSync(artifactsPath, 'utf-8')
      const data = JSON.parse(content) as SerializedArtifactIndex
      const index: ArtifactIndex = {
        files: data.files ?? {},
        totalReads: data.totalReads ?? 0,
        totalWrites: data.totalWrites ?? 0,
        lastUpdatedAt: data.lastUpdatedAt ?? Date.now(),
      }
      return new ArtifactTracker(worktreeRoot, index)
    } catch {
      return new ArtifactTracker(worktreeRoot)
    }
  }

  /**
   * Generate a compact summary string for context injection
   */
  toContextString(): string {
    const files = Object.values(this.index.files)
    if (files.length === 0) return '## Files Tracked (0 files)\nNo files tracked yet.'

    const modified = files.filter(f => f.actions.some(a => a === 'created' || a === 'modified' || a === 'deleted'))
    const readOnly = files.filter(f => !f.actions.some(a => a === 'created' || a === 'modified' || a === 'deleted') && f.actions.includes('read'))
    const searchedOnly = files.filter(f => f.actions.every(a => a === 'searched'))

    const lines: string[] = []
    lines.push(`## Files Tracked (${files.length} files)`)

    if (modified.length > 0) {
      lines.push(`### Modified (${modified.length}):`)
      for (const f of modified) {
        const actionCounts = this.summarizeActions(f.actions)
        lines.push(`- ${f.relativePath} (${actionCounts})`)
      }
    }

    if (readOnly.length > 0) {
      lines.push(`### Read-only (${readOnly.length}):`)
      for (const f of readOnly) {
        const readCount = f.actions.filter(a => a === 'read').length
        lines.push(`- ${f.relativePath} (read ${readCount}x)`)
      }
    }

    if (searchedOnly.length > 0) {
      lines.push(`### Searched (${searchedOnly.length}):`)
      for (const f of searchedOnly) {
        lines.push(`- ${f.relativePath}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Summarize action counts for a file
   */
  private summarizeActions(actions: TrackedFileAction[]): string {
    const counts: Record<string, number> = {}
    for (const action of actions) {
      counts[action] = (counts[action] ?? 0) + 1
    }
    return Object.entries(counts)
      .map(([action, count]) => `${action} ${count}x`)
      .join(', ')
  }
}
