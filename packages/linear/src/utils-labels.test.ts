import { describe, it, expect } from 'vitest'
import { resolveGraphQLLabelNames, resolveSDKLabelNames } from './utils.js'

describe('resolveGraphQLLabelNames', () => {
  it('returns plain names for labels without parent', () => {
    const labels = [{ name: 'Bug' }, { name: 'Feature' }]
    expect(resolveGraphQLLabelNames(labels)).toEqual(['Bug', 'Feature'])
  })

  it('reconstructs group:value for grouped labels', () => {
    const labels = [
      { name: 'Bug' },
      { name: 'codex', parent: { name: 'provider', isGroup: true } },
      { name: 'Feature' },
    ]
    expect(resolveGraphQLLabelNames(labels)).toEqual(['Bug', 'provider:codex', 'Feature'])
  })

  it('ignores parent when isGroup is false', () => {
    const labels = [
      { name: 'codex', parent: { name: 'provider', isGroup: false } },
    ]
    expect(resolveGraphQLLabelNames(labels)).toEqual(['codex'])
  })

  it('handles null parent gracefully', () => {
    const labels = [
      { name: 'Bug', parent: null },
      { name: 'codex', parent: { name: 'provider', isGroup: true } },
    ]
    expect(resolveGraphQLLabelNames(labels)).toEqual(['Bug', 'provider:codex'])
  })

  it('handles empty array', () => {
    expect(resolveGraphQLLabelNames([])).toEqual([])
  })
})

describe('resolveSDKLabelNames', () => {
  it('returns plain names when parent resolves to undefined', async () => {
    const labels = [
      { name: 'Bug', parent: Promise.resolve(undefined) },
      { name: 'Feature', parent: Promise.resolve(undefined) },
    ]
    expect(await resolveSDKLabelNames(labels)).toEqual(['Bug', 'Feature'])
  })

  it('reconstructs group:value for grouped labels', async () => {
    const labels = [
      { name: 'Bug', parent: Promise.resolve(undefined) },
      { name: 'codex', parent: Promise.resolve({ name: 'provider', isGroup: true }) },
      { name: 'Feature', parent: Promise.resolve(undefined) },
    ]
    expect(await resolveSDKLabelNames(labels)).toEqual(['Bug', 'provider:codex', 'Feature'])
  })

  it('ignores parent when isGroup is false', async () => {
    const labels = [
      { name: 'codex', parent: Promise.resolve({ name: 'provider', isGroup: false }) },
    ]
    expect(await resolveSDKLabelNames(labels)).toEqual(['codex'])
  })

  it('handles parent resolution failure gracefully', async () => {
    const labels = [
      { name: 'codex', parent: Promise.reject(new Error('network error')) },
    ]
    expect(await resolveSDKLabelNames(labels)).toEqual(['codex'])
  })

  it('handles labels without parent property', async () => {
    const labels = [
      { name: 'Bug' },
      { name: 'Feature' },
    ]
    expect(await resolveSDKLabelNames(labels)).toEqual(['Bug', 'Feature'])
  })

  it('handles empty array', async () => {
    expect(await resolveSDKLabelNames([])).toEqual([])
  })
})
