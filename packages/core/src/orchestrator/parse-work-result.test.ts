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

    it('matches QA patterns for qa-coordination work type', () => {
      expect(parseWorkResult('## QA Passed\nAll sub-issues pass.', 'qa-coordination')).toBe('passed')
      expect(parseWorkResult('## QA Failed\nSUP-712 needs work.', 'qa-coordination')).toBe('failed')
      expect(parseWorkResult('QA Result: Pass', 'qa-coordination')).toBe('passed')
      expect(parseWorkResult('QA Result: Fail', 'qa-coordination')).toBe('failed')
    })

    it('checks fail patterns before pass patterns', () => {
      // Both present - fail takes precedence since it's checked first
      expect(parseWorkResult('## QA Failed\n## QA Passed', 'qa')).toBe(
        'failed'
      )
    })

    it('detects "Overall Result: FAIL" (coordination style)', () => {
      expect(parseWorkResult('**Overall Result: FAIL** — 4 of 6 phases failed', 'qa-coordination')).toBe('failed')
    })

    it('detects "Overall QA Result: FAIL" (coordination style)', () => {
      expect(parseWorkResult('**Overall QA Result: FAIL (0/6 sub-issues pass)**', 'qa-coordination')).toBe('failed')
    })

    it('detects "Roll-Up Verdict: FAIL"', () => {
      expect(parseWorkResult('### Roll-Up Verdict: FAIL (0/6 sub-issues pass)', 'qa-coordination')).toBe('failed')
    })

    it('detects "Parent QA verdict: FAIL"', () => {
      expect(parseWorkResult('**Parent QA verdict: FAIL — requires fixes**', 'qa-coordination')).toBe('failed')
    })

    it('detects "Overall Result: PASS" (coordination style)', () => {
      expect(parseWorkResult('**Overall Result: PASS** — all phases passed', 'qa-coordination')).toBe('passed')
    })

    it('detects "Roll-Up Verdict: PASS"', () => {
      expect(parseWorkResult('### Roll-Up Verdict: PASS (6/6 sub-issues pass)', 'qa-coordination')).toBe('passed')
    })

    // Real agent output patterns (SUP-867 regression)
    it('detects bold **PASS**', () => {
      expect(parseWorkResult('Branch unchanged — `4383c3e`. **PASS.** No new findings.', 'qa')).toBe('passed')
    })

    it('detects bold **PASS** without period', () => {
      expect(parseWorkResult('All tests pass. **PASS**', 'qa')).toBe('passed')
    })

    it('detects "Verdict: PASS" without QA prefix', () => {
      expect(parseWorkResult('**Verdict: PASS** — all criteria met', 'qa')).toBe('passed')
    })

    it('detects "Verdict: **PASS**" with bold', () => {
      expect(parseWorkResult('Verdict: **PASS**', 'qa')).toBe('passed')
    })

    it('detects "Status: **PASS**" without QA prefix', () => {
      expect(parseWorkResult('### Status: **PASS** — same as prior two passes', 'qa')).toBe('passed')
    })

    it('detects "Result: Pass" without QA prefix', () => {
      expect(parseWorkResult('Result: Pass — no issues found', 'qa')).toBe('passed')
    })

    it('detects bold **FAIL**', () => {
      expect(parseWorkResult('Build failed. **FAIL.**', 'qa')).toBe('failed')
    })

    it('detects "Verdict: FAIL" without QA prefix', () => {
      expect(parseWorkResult('Verdict: FAIL — build errors detected', 'qa')).toBe('failed')
    })

    it('detects "Status: **FAIL**" without QA prefix', () => {
      expect(parseWorkResult('Status: **FAIL**', 'qa')).toBe('failed')
    })

    it('does not false-positive on "tests pass" (no bold)', () => {
      expect(parseWorkResult('All tests pass and everything looks good.', 'qa')).toBe('unknown')
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

    it('matches acceptance patterns for acceptance-coordination work type', () => {
      expect(parseWorkResult('## Acceptance Complete', 'acceptance-coordination')).toBe('passed')
      expect(parseWorkResult('PR has been merged successfully', 'acceptance-coordination')).toBe('passed')
      expect(parseWorkResult('## Acceptance Failed', 'acceptance-coordination')).toBe('failed')
      expect(parseWorkResult('Cannot merge PR', 'acceptance-coordination')).toBe('failed')
    })
  })

  // Coordination heuristic pattern tests
  describe('coordination heuristic patterns', () => {
    it('detects "all 8/8 sub-issues completed"', () => {
      expect(
        parseWorkResult('all 8/8 sub-issues completed and marked Finished in Linear.', 'coordination')
      ).toBe('passed')
    })

    it('detects "all sub-issues completed" without count', () => {
      expect(
        parseWorkResult('All sub-issues completed successfully.', 'coordination')
      ).toBe('passed')
    })

    it('detects "all sub-issues finished"', () => {
      expect(
        parseWorkResult('All 3/3 sub-issues finished.', 'coordination')
      ).toBe('passed')
    })

    it('detects "Coordination Complete"', () => {
      expect(
        parseWorkResult('## Coordination Complete\nAll work done.', 'coordination')
      ).toBe('passed')
    })

    it('detects "Must Fix Before Merge" as fail', () => {
      expect(
        parseWorkResult('### CRITICAL — Must Fix Before Merge\n1. provision-trial.ts uses removed fields', 'coordination')
      ).toBe('failed')
    })

    it('detects "N Critical Issues (Block Merge)" as fail', () => {
      expect(
        parseWorkResult('### 3 Critical Issues (Block Merge)\n1. Bad migration', 'coordination')
      ).toBe('failed')
    })

    it('detects "sub-issues need work" as fail', () => {
      expect(
        parseWorkResult('2 sub-issues need work before this can proceed.', 'coordination')
      ).toBe('failed')
    })

    it('does not match coordination patterns for non-coordination work types', () => {
      expect(parseWorkResult('All sub-issues completed.', 'development')).toBe('unknown')
      expect(parseWorkResult('All sub-issues completed.', 'qa')).toBe('unknown')
    })

    it('checks fail patterns before pass patterns', () => {
      expect(
        parseWorkResult('All 8/8 sub-issues completed.\n### Must Fix Before Merge\n1. Bad code', 'coordination')
      ).toBe('failed')
    })
  })

  // QA coordination with real agent output formats
  describe('QA coordination real-world patterns', () => {
    it('detects "Status: N Issues Found" as fail', () => {
      expect(
        parseWorkResult('### Status: 3 Issues Found (1 Critical, 2 Minor)', 'qa-coordination')
      ).toBe('failed')
    })

    it('detects "Must Fix Before Merge" in QA context as fail', () => {
      expect(
        parseWorkResult('## QA Report\n### CRITICAL — Must Fix Before Merge\n1. Bad migration', 'qa')
      ).toBe('failed')
    })

    it('detects "N Critical Issues (Block Merge)" in QA context as fail', () => {
      expect(
        parseWorkResult('### 3 Critical Issues (Block Merge)\n1. Bad code', 'qa-coordination')
      ).toBe('failed')
    })
  })

  // Acceptance coordination with real agent output formats
  describe('acceptance coordination real-world patterns', () => {
    it('detects "Must Fix Before Merge" in acceptance context as fail', () => {
      expect(
        parseWorkResult('## Acceptance Coordination Report\n### CRITICAL — Must Fix Before Merge', 'acceptance-coordination')
      ).toBe('failed')
    })

    it('detects "N Critical Issues (Block Merge)" in acceptance context as fail', () => {
      expect(
        parseWorkResult('### 3 Critical Issues (Block Merge)\n1. provision-trial.ts uses removed fields', 'acceptance-coordination')
      ).toBe('failed')
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
