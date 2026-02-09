/**
 * Linear API Utilities
 *
 * Helper functions for working with Linear API
 */

import {
  LINEAR_COMMENT_MAX_LENGTH,
  TRUNCATION_MARKER,
  MAX_COMPLETION_COMMENTS,
  COMMENT_OVERHEAD,
  CONTINUATION_MARKER,
} from './constants'

/**
 * Truncate a string to a maximum length, adding truncation marker if needed
 */
export function truncateText(
  text: string,
  maxLength: number = LINEAR_COMMENT_MAX_LENGTH
): string {
  if (text.length <= maxLength) {
    return text
  }

  const truncateAt = maxLength - TRUNCATION_MARKER.length
  return text.substring(0, truncateAt) + TRUNCATION_MARKER
}

/**
 * Build a completion comment with smart truncation.
 * Prioritizes: summary > plan status > session ID
 *
 * If the full comment exceeds maxLength:
 * 1. First, truncate plan items to show only states
 * 2. If still too long, truncate the summary
 */
export function buildCompletionComment(
  summary: string,
  planItems: Array<{ state: string; title: string }>,
  sessionId: string | null,
  maxLength: number = LINEAR_COMMENT_MAX_LENGTH
): string {
  const stateEmoji: Record<string, string> = {
    pending: '\u{2B1C}',
    inProgress: '\u{1F504}',
    completed: '\u{2705}',
    canceled: '\u{274C}',
  }

  // Build static parts
  const header = '## Agent Work Complete\n\n'
  const planHeader = '\n\n### Final Plan Status\n\n'
  const footer = `\n\n---\n*Session ID: ${sessionId ?? 'unknown'}*`

  // Full plan status
  const fullPlanStatus = planItems
    .map((item) => `${stateEmoji[item.state] ?? '\u{2B1C}'} ${item.title}`)
    .join('\n')

  // Abbreviated plan status (just emoji counts)
  const completedCount = planItems.filter((i) => i.state === 'completed').length
  const pendingCount = planItems.filter((i) => i.state === 'pending').length
  const canceledCount = planItems.filter((i) => i.state === 'canceled').length
  const abbreviatedPlanStatus = [
    `\u{2705} ${completedCount} completed`,
    pendingCount > 0 ? `\u{2B1C} ${pendingCount} pending` : null,
    canceledCount > 0 ? `\u{274C} ${canceledCount} canceled` : null,
  ]
    .filter(Boolean)
    .join(' | ')

  // Try full comment first
  const fullComment = header + summary + planHeader + fullPlanStatus + footer
  if (fullComment.length <= maxLength) {
    return fullComment
  }

  // Try with abbreviated plan
  const abbreviatedComment =
    header + summary + planHeader + abbreviatedPlanStatus + footer
  if (abbreviatedComment.length <= maxLength) {
    return abbreviatedComment
  }

  // Need to truncate summary
  const fixedLength =
    header.length +
    planHeader.length +
    abbreviatedPlanStatus.length +
    footer.length +
    TRUNCATION_MARKER.length
  const availableForSummary = maxLength - fixedLength

  if (availableForSummary > 100) {
    // Only truncate if we have reasonable space
    const truncatedSummary =
      summary.substring(0, availableForSummary) + TRUNCATION_MARKER
    return header + truncatedSummary + planHeader + abbreviatedPlanStatus + footer
  }

  // Extreme case: even the fixed parts are too long, just truncate everything
  return truncateText(fullComment, maxLength)
}

/**
 * Represents a chunk of content split for multiple comments
 */
export interface CommentChunk {
  body: string
  partNumber: number
  totalParts: number
}

/**
 * Check if a position is inside a code block
 */
function isInsideCodeBlock(text: string, position: number): boolean {
  let insideCodeBlock = false
  let i = 0
  while (i < position && i < text.length) {
    if (text.slice(i, i + 3) === '```') {
      insideCodeBlock = !insideCodeBlock
      i += 3
    } else {
      i++
    }
  }
  return insideCodeBlock
}

/**
 * Find a safe split point in text that doesn't break code blocks
 */
function findSafeSplitPoint(text: string, targetLength: number): number {
  if (text.length <= targetLength) {
    return text.length
  }

  // Try to split at paragraph boundary first
  const paragraphBoundary = text.lastIndexOf('\n\n', targetLength)
  if (paragraphBoundary > targetLength * 0.5 && !isInsideCodeBlock(text, paragraphBoundary)) {
    return paragraphBoundary
  }

  // Try to split at sentence boundary
  const sentenceEnd = text.lastIndexOf('. ', targetLength)
  if (sentenceEnd > targetLength * 0.5 && !isInsideCodeBlock(text, sentenceEnd)) {
    return sentenceEnd + 1 // Include the period
  }

  // Try to split at newline
  const newline = text.lastIndexOf('\n', targetLength)
  if (newline > targetLength * 0.5 && !isInsideCodeBlock(text, newline)) {
    return newline
  }

  // Try to split at word boundary
  const wordBoundary = text.lastIndexOf(' ', targetLength)
  if (wordBoundary > targetLength * 0.3 && !isInsideCodeBlock(text, wordBoundary)) {
    return wordBoundary
  }

  // If we're inside a code block, find the end of it
  if (isInsideCodeBlock(text, targetLength)) {
    // Look for code block end after targetLength
    const codeBlockEnd = text.indexOf('```', targetLength)
    if (codeBlockEnd !== -1 && codeBlockEnd < targetLength * 1.5) {
      // Include the closing fence and newline
      const afterFence = text.indexOf('\n', codeBlockEnd + 3)
      return afterFence !== -1 ? afterFence : codeBlockEnd + 3
    }
  }

  // Last resort: split at target length
  return targetLength
}

/**
 * Split content into multiple comment chunks
 *
 * Splitting strategy:
 * 1. Reserve space for part markers
 * 2. Split at paragraph boundaries first
 * 3. If paragraph too long, split at sentence boundaries
 * 4. If sentence too long, split at word boundaries
 * 5. Never split inside code blocks
 */
export function splitContentIntoComments(
  content: string,
  maxLength: number = LINEAR_COMMENT_MAX_LENGTH,
  maxComments: number = MAX_COMPLETION_COMMENTS
): CommentChunk[] {
  // Account for overhead (part markers, continuation markers)
  const effectiveMaxLength = maxLength - COMMENT_OVERHEAD

  if (content.length <= effectiveMaxLength) {
    return [{ body: content, partNumber: 1, totalParts: 1 }]
  }

  const chunks: string[] = []
  let remaining = content

  while (remaining.length > 0 && chunks.length < maxComments) {
    // Reserve space for continuation marker if not the last chunk
    const reserveForContinuation = remaining.length > effectiveMaxLength
      ? CONTINUATION_MARKER.length
      : 0
    const chunkMaxLength = effectiveMaxLength - reserveForContinuation

    if (remaining.length <= chunkMaxLength) {
      chunks.push(remaining)
      remaining = ''
    } else {
      const splitPoint = findSafeSplitPoint(remaining, chunkMaxLength)
      const chunk = remaining.slice(0, splitPoint).trimEnd()
      chunks.push(chunk)
      remaining = remaining.slice(splitPoint).trimStart()
    }
  }

  // If we hit max comments and still have content, append truncation to last chunk
  if (remaining.length > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] += TRUNCATION_MARKER
  }

  const totalParts = chunks.length

  return chunks.map((chunk, index) => {
    const partNumber = index + 1
    const isLastPart = partNumber === totalParts

    // Add part marker for multi-part comments
    let body = chunk
    if (totalParts > 1) {
      const partMarker = `\n\n---\n*Part ${partNumber}/${totalParts}*`
      if (!isLastPart) {
        body = chunk + CONTINUATION_MARKER + partMarker
      } else {
        body = chunk + partMarker
      }
    }

    return { body, partNumber, totalParts }
  })
}

/**
 * Build completion comments with smart splitting.
 * Returns multiple comment chunks if content exceeds max length.
 *
 * For backward compatibility, maintains the same header/footer structure
 * as buildCompletionComment, but splits long content across multiple comments.
 */
export function buildCompletionComments(
  summary: string,
  planItems: Array<{ state: string; title: string }>,
  sessionId: string | null,
  maxLength: number = LINEAR_COMMENT_MAX_LENGTH
): CommentChunk[] {
  const stateEmoji: Record<string, string> = {
    pending: '\u{2B1C}',
    inProgress: '\u{1F504}',
    completed: '\u{2705}',
    canceled: '\u{274C}',
  }

  // Build static parts
  const header = '## Agent Work Complete\n\n'
  const planHeader = '\n\n### Final Plan Status\n\n'
  const footer = `\n\n---\n*Session ID: ${sessionId ?? 'unknown'}*`

  // Full plan status
  const fullPlanStatus = planItems
    .map((item) => `${stateEmoji[item.state] ?? '\u{2B1C}'} ${item.title}`)
    .join('\n')

  // Abbreviated plan status (just emoji counts)
  const completedCount = planItems.filter((i) => i.state === 'completed').length
  const pendingCount = planItems.filter((i) => i.state === 'pending').length
  const canceledCount = planItems.filter((i) => i.state === 'canceled').length
  const abbreviatedPlanStatus = [
    `\u{2705} ${completedCount} completed`,
    pendingCount > 0 ? `\u{2B1C} ${pendingCount} pending` : null,
    canceledCount > 0 ? `\u{274C} ${canceledCount} canceled` : null,
  ]
    .filter(Boolean)
    .join(' | ')

  // Try full comment first (single comment)
  const fullComment = header + summary + planHeader + fullPlanStatus + footer
  if (fullComment.length <= maxLength) {
    return [{ body: fullComment, partNumber: 1, totalParts: 1 }]
  }

  // Try with abbreviated plan (still single comment)
  const abbreviatedComment =
    header + summary + planHeader + abbreviatedPlanStatus + footer
  if (abbreviatedComment.length <= maxLength) {
    return [{ body: abbreviatedComment, partNumber: 1, totalParts: 1 }]
  }

  // Need to split into multiple comments
  // First comment gets header + beginning of summary
  // Middle comments get summary continuation
  // Last comment gets end of summary + plan status + footer

  const fixedSuffixLength = planHeader.length + abbreviatedPlanStatus.length + footer.length
  const headerLength = header.length

  // Split the summary into chunks
  const summaryChunks = splitContentIntoComments(
    summary,
    maxLength - COMMENT_OVERHEAD - Math.max(headerLength, fixedSuffixLength),
    MAX_COMPLETION_COMMENTS
  )

  // Build final comments
  const result: CommentChunk[] = []
  const totalParts = summaryChunks.length

  for (let i = 0; i < summaryChunks.length; i++) {
    const isFirst = i === 0
    const isLast = i === summaryChunks.length - 1
    const partNumber = i + 1

    let body = ''

    if (isFirst) {
      body += header
    }

    body += summaryChunks[i].body

    // Remove the part marker from the chunk (we'll add our own)
    if (totalParts > 1) {
      body = body.replace(/\n\n---\n\*Part \d+\/\d+\*$/, '')
      body = body.replace(new RegExp(escapeRegExp(CONTINUATION_MARKER), 'g'), '')
    }

    if (isLast) {
      body += planHeader + abbreviatedPlanStatus + footer
    }

    // Add part marker for multi-part comments
    if (totalParts > 1) {
      if (!isLast) {
        body += CONTINUATION_MARKER
      }
      body += `\n\n---\n*Part ${partNumber}/${totalParts}*`
    }

    result.push({ body, partNumber, totalParts })
  }

  return result
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
