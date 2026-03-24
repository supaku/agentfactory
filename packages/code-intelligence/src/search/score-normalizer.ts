/**
 * Min-max score normalization for hybrid search fusion.
 * Normalizes scores to [0, 1] range for CCS combination.
 */

/**
 * Apply min-max normalization to an array of scores.
 *
 * normalized = (score - min) / (max - min)
 *
 * Edge cases:
 * - Empty array → []
 * - Single result → [1.0]
 * - All same scores → all 1.0
 */
export function minMaxNormalize(scores: number[]): number[] {
  if (scores.length === 0) return []
  if (scores.length === 1) return [1.0]

  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min

  if (range === 0) return scores.map(() => 1.0)

  return scores.map(s => (s - min) / range)
}
