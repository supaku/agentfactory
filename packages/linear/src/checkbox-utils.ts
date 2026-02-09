/**
 * Checkbox Utilities
 *
 * Parse and update markdown checkboxes in Linear issue descriptions.
 * Checkboxes follow the standard markdown format:
 *   - [ ] Unchecked item
 *   - [x] Checked item
 */

/**
 * Represents a checkbox item parsed from markdown
 */
export interface CheckboxItem {
  /** Zero-based index among all checkboxes in the document */
  index: number
  /** Line number in the markdown (zero-based) */
  line: number
  /** Whether the checkbox is checked */
  checked: boolean
  /** The text content after the checkbox */
  text: string
  /** Indentation level (number of leading spaces) */
  indentLevel: number
  /** The raw line text */
  raw: string
}

/**
 * Checkbox update specification
 */
export interface CheckboxUpdate {
  /** Update checkbox by its index */
  index?: number
  /** Update checkbox by matching text pattern */
  textPattern?: string | RegExp
  /** New checked state */
  checked: boolean
}

// Regex to match markdown checkbox lines
// Captures: (leading whitespace)(checkbox mark)(text content)
const CHECKBOX_REGEX = /^(\s*)- \[([ xX])\] (.*)$/

/**
 * Parse markdown and extract checkbox items
 *
 * @param markdown - The markdown content to parse
 * @returns Array of checkbox items found in the markdown
 */
export function parseCheckboxes(markdown: string): CheckboxItem[] {
  const lines = markdown.split('\n')
  const checkboxes: CheckboxItem[] = []
  let checkboxIndex = 0

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]
    const match = line.match(CHECKBOX_REGEX)

    if (match) {
      const [, indent, mark, text] = match
      checkboxes.push({
        index: checkboxIndex++,
        line: lineNum,
        indentLevel: indent.length,
        checked: mark.toLowerCase() === 'x',
        text: text.trim(),
        raw: line,
      })
    }
  }

  return checkboxes
}

/**
 * Update a checkbox by its index
 *
 * @param markdown - The markdown content
 * @param index - The checkbox index to update
 * @param checked - The new checked state
 * @returns The updated markdown, or the original if checkbox not found
 */
export function updateCheckbox(
  markdown: string,
  index: number,
  checked: boolean
): string {
  const checkboxes = parseCheckboxes(markdown)
  const checkbox = checkboxes.find((c) => c.index === index)

  if (!checkbox) {
    return markdown
  }

  const lines = markdown.split('\n')
  const newCheckmark = checked ? 'x' : ' '
  lines[checkbox.line] = checkbox.raw.replace(/\[([ xX])\]/, `[${newCheckmark}]`)

  return lines.join('\n')
}

/**
 * Update a checkbox by matching its text content
 *
 * @param markdown - The markdown content
 * @param textPattern - String or regex to match against checkbox text
 * @param checked - The new checked state
 * @returns The updated markdown, or the original if no match found
 */
export function updateCheckboxByText(
  markdown: string,
  textPattern: string | RegExp,
  checked: boolean
): string {
  const checkboxes = parseCheckboxes(markdown)

  const pattern =
    typeof textPattern === 'string'
      ? new RegExp(textPattern, 'i')
      : textPattern

  const checkbox = checkboxes.find((c) => pattern.test(c.text))

  if (!checkbox) {
    return markdown
  }

  return updateCheckbox(markdown, checkbox.index, checked)
}

/**
 * Apply multiple checkbox updates at once
 *
 * @param markdown - The markdown content
 * @param updates - Array of updates to apply
 * @returns The updated markdown
 */
export function updateCheckboxes(
  markdown: string,
  updates: CheckboxUpdate[]
): string {
  let result = markdown

  for (const update of updates) {
    if (update.index !== undefined) {
      result = updateCheckbox(result, update.index, update.checked)
    } else if (update.textPattern) {
      result = updateCheckboxByText(result, update.textPattern, update.checked)
    }
  }

  return result
}

/**
 * Check if markdown contains any checkboxes
 *
 * @param markdown - The markdown content to check
 * @returns True if at least one checkbox is found
 */
export function hasCheckboxes(markdown: string): boolean {
  const lines = markdown.split('\n')
  return lines.some((line) => CHECKBOX_REGEX.test(line))
}

/**
 * Get summary of checkbox states
 *
 * @param markdown - The markdown content
 * @returns Object with counts of checked and unchecked items
 */
export function getCheckboxSummary(markdown: string): {
  total: number
  checked: number
  unchecked: number
} {
  const checkboxes = parseCheckboxes(markdown)
  const checked = checkboxes.filter((c) => c.checked).length

  return {
    total: checkboxes.length,
    checked,
    unchecked: checkboxes.length - checked,
  }
}
