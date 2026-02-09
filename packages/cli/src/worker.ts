#!/usr/bin/env node
/**
 * AgentFactory Worker CLI
 *
 * Starts a remote worker that polls the Redis work queue
 * and processes assigned agent sessions.
 *
 * Usage:
 *   af-worker [options]
 *
 * Options:
 *   --capacity <number>   Maximum concurrent agents (default: 2)
 *   --api-url <url>       Agent API URL for activity proxying
 *   --api-key <key>       API key for worker authentication
 *
 * Environment:
 *   LINEAR_API_KEY        Required API key for Linear authentication
 *   REDIS_URL             Required for work queue polling
 *   WORKER_API_URL        Agent API URL (alternative to --api-url)
 *   WORKER_API_KEY        API key (alternative to --api-key)
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables
config({ path: path.resolve(process.cwd(), '.env.local') })

function parseArgs(): {
  capacity: number
  apiUrl?: string
  apiKey?: string
} {
  const args = process.argv.slice(2)
  const result = {
    capacity: 2,
    apiUrl: process.env.WORKER_API_URL,
    apiKey: process.env.WORKER_API_KEY,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--capacity':
        result.capacity = parseInt(args[++i], 10)
        break
      case '--api-url':
        result.apiUrl = args[++i]
        break
      case '--api-key':
        result.apiKey = args[++i]
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  return result
}

function printHelp(): void {
  console.log(`
AgentFactory Worker — Remote agent worker for distributed processing

Usage:
  af-worker [options]

Options:
  --capacity <number>   Maximum concurrent agents (default: 2)
  --api-url <url>       Agent API URL for activity proxying
  --api-key <key>       API key for worker authentication
  --help, -h            Show this help message

Environment:
  LINEAR_API_KEY        Required API key for Linear authentication
  REDIS_URL             Required for work queue polling
  WORKER_API_URL        Agent API URL (alternative to --api-url)
  WORKER_API_KEY        API key (alternative to --api-key)
`)
}

async function main(): Promise<void> {
  const args = parseArgs()

  if (!process.env.LINEAR_API_KEY) {
    console.error('Error: LINEAR_API_KEY environment variable is required')
    process.exit(1)
  }

  if (!process.env.REDIS_URL) {
    console.error('Error: REDIS_URL environment variable is required for worker mode')
    process.exit(1)
  }

  console.log('AgentFactory Worker')
  console.log('===================')
  console.log(`Capacity: ${args.capacity}`)
  console.log(`API URL: ${args.apiUrl ?? 'not configured'}`)
  console.log('')
  console.log('Worker started. Polling for work...')
  console.log('Press Ctrl+C to stop.')

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('')
    console.log('Worker shutting down...')
    process.exit(0)
  })

  // TODO: Implement worker polling loop
  // This is a placeholder — the full implementation involves:
  // 1. Register with worker-storage
  // 2. Poll work-queue at interval
  // 3. Claim and process work items
  // 4. Send heartbeats
  // 5. Clean up on shutdown
  console.log('Worker implementation: see @supaku/agentfactory-server for queue operations')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
