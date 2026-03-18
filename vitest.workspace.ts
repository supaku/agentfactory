import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/linear',
  'packages/server',
  'packages/cli',
  'packages/nextjs',
  'packages/mcp-server',
  'packages/dashboard',
  'packages/test-utils',
])
