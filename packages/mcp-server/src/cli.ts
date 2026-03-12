#!/usr/bin/env node

import { createFleetMcpServer } from './server.js'
import { startStdioTransport, startHttpTransport } from './transport.js'

const args = process.argv.slice(2)
const transportType = args.includes('--stdio') ? 'stdio' : 'http'

const server = createFleetMcpServer()

if (transportType === 'stdio') {
  console.error('[mcp-server] Starting in STDIO mode')
  await startStdioTransport(server)
} else {
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : undefined
  const hostIdx = args.indexOf('--host')
  const host = hostIdx !== -1 ? args[hostIdx + 1] : undefined

  await startHttpTransport(server, { port, host })

  // Graceful shutdown
  const shutdown = () => {
    console.log('[mcp-server] Shutting down...')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
