import { describe, it, expect } from 'vitest'
import { parseWorkResult } from './parse-work-result.js'

describe('parseWorkResult', () => {
  // Structured marker tests
  describe('structured markers', () => {
    it('detects <!-- WORK_RESULT:passed --> marker', () => {
      expect(
        parseWorkResult('Some text <!-- WORK_RESULT:passed --> more text', 'qa')
      ).toBe('passed')
    })

    it('detects <!-- WORK_RESULT:failed --> marker', () => {
      expect(parseWorkResult('<!-- WORK_RESULT:failed -->', 'qa')).toBe(
        'failed'
      )
    })

    it('is case-insensitive for marker value', () => {
      expect(parseWorkResult('<!-- WORK_RESULT:PASSED -->', 'qa')).toBe(
        'passed'
      )
      expect(
        parseWorkResult('<!-- WORK_RESULT:Failed -->', 'acceptance')
      ).toBe('failed')
    })

    it('handles extra whitespace in marker', () => {
      expect(parseWorkResult('<!--  WORK_RESULT:passed  -->', 'qa')).toBe(
        'passed'
      )
    })

    it('finds marker anywhere in the message', () => {
      const msg =
        'Here is my QA report\n\nEverything looks good\n\n<!-- WORK_RESULT:passed -->\n\nEnd of report'
      expect(parseWorkResult(msg, 'qa')).toBe('passed')
    })

    it('works for any work type (not just qa/acceptance)', () => {
      expect(
        parseWorkResult('<!-- WORK_RESULT:passed -->', 'development')
      ).toBe('passed')
      expect(
        parseWorkResult('<!-- WORK_RESULT:failed -->', 'coordination')
      ).toBe('failed')
    })
  })

  // QA heuristic pattern tests
  describe('QA heuristic patterns', () => {
    it('detects "## QA Passed" heading', () => {
      expect(parseWorkResult('## QA Passed\nAll tests pass.', 'qa')).toBe(
        'passed'
      )
    })

    it('detects "QA Result: Pass"', () => {
      expect(parseWorkResult('QA Result: Pass', 'qa')).toBe('passed')
    })

    it('detects "QA Status: Passed"', () => {
      expect(parseWorkResult('QA Status: Passed', 'qa')).toBe('passed')
    })

    it('detects "## QA Failed" heading', () => {
      expect(parseWorkResult('## QA Failed\nTests are broken.', 'qa')).toBe(
        'failed'
      )
    })

    it('detects "QA Result: Fail"', () => {
      expect(parseWorkResult('QA Result: Fail', 'qa')).toBe('failed')
    })

    it('does not match QA patterns for non-qa work types', () => {
      expect(parseWorkResult('## QA Passed', 'development')).toBe('unknown')
      expect(parseWorkResult('QA Result: Pass', 'acceptance')).toBe('unknown')
    })

    it('checks fail patterns before pass patterns', () => {
      // Both present - fail takes precedence since it's checked first
      expect(parseWorkResult('## QA Failed\n## QA Passed', 'qa')).toBe(
        'failed'
      )
    })
  })

  // Acceptance heuristic pattern tests
  describe('acceptance heuristic patterns', () => {
    it('detects "## Acceptance Complete"', () => {
      expect(parseWorkResult('## Acceptance Complete', 'acceptance')).toBe(
        'passed'
      )
    })

    it('detects "Acceptance Result: Pass"', () => {
      expect(parseWorkResult('Acceptance Result: Pass', 'acceptance')).toBe(
        'passed'
      )
    })

    it('detects "PR has been merged successfully"', () => {
      expect(
        parseWorkResult('PR has been merged successfully', 'acceptance')
      ).toBe('passed')
    })

    it('detects "## Acceptance Failed"', () => {
      expect(parseWorkResult('## Acceptance Failed', 'acceptance')).toBe(
        'failed'
      )
    })

    it('detects "Acceptance Processing Blocked"', () => {
      expect(
        parseWorkResult('Acceptance Processing Blocked', 'acceptance')
      ).toBe('failed')
    })

    it('detects "Cannot merge PR"', () => {
      expect(parseWorkResult('Cannot merge PR', 'acceptance')).toBe('failed')
    })

    it('does not match acceptance patterns for non-acceptance work types', () => {
      expect(parseWorkResult('## Acceptance Complete', 'qa')).toBe('unknown')
      expect(
        parseWorkResult('PR has been merged successfully', 'development')
      ).toBe('unknown')
    })
  })

  // Unknown result tests
  describe('unknown results', () => {
    it('returns unknown for undefined message', () => {
      expect(parseWorkResult(undefined, 'qa')).toBe('unknown')
    })

    it('returns unknown for empty string', () => {
      expect(parseWorkResult('', 'qa')).toBe('unknown')
    })

    it('returns unknown for message without any markers or patterns', () => {
      expect(
        parseWorkResult('Work completed successfully. All looks good.', 'qa')
      ).toBe('unknown')
    })

    it('returns unknown for generic success messages without structured marker', () => {
      expect(
        parseWorkResult('Everything passed! Great work.', 'qa')
      ).toBe('unknown')
    })

    it('returns unknown for message with only whitespace', () => {
      expect(parseWorkResult('   \n\n  \t  ', 'qa')).toBe('unknown')
    })
  })

  // Priority / edge cases
  describe('edge cases', () => {
    it('prefers structured marker over heuristic patterns', () => {
      const msg =
        '## QA Failed\n\nActually wait, it passed.\n\n<!-- WORK_RESULT:passed -->'
      expect(parseWorkResult(msg, 'qa')).toBe('passed')
    })

    it('handles messages with multiple structured markers (takes first)', () => {
      const msg =
        '<!-- WORK_RESULT:passed -->\nOops\n<!-- WORK_RESULT:failed -->'
      expect(parseWorkResult(msg, 'qa')).toBe('passed')
    })

    it('handles very long messages', () => {
      const long =
        'x'.repeat(100000) +
        '<!-- WORK_RESULT:passed -->' +
        'y'.repeat(100000)
      expect(parseWorkResult(long, 'qa')).toBe('passed')
    })

    it('does not match partial markers', () => {
      expect(parseWorkResult('WORK_RESULT:passed', 'qa')).toBe('unknown')
      expect(parseWorkResult('<!-- WORK_RESULT:maybe -->', 'qa')).toBe(
        'unknown'
      )
    })
  })
})
