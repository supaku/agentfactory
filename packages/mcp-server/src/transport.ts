import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import http from 'node:http'
import { verifyMcpAuth, isMcpAuthConfigured } from './auth.js'

export interface HttpTransportOptions {
  port?: number
  host?: string
}

export async function startStdioTransport(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

export async function startHttpTransport(
  server: McpServer,
  options: HttpTransportOptions = {}
): Promise<http.Server> {
  const port = options.port ?? parseInt(process.env.MCP_PORT ?? '3100', 10)
  const host = options.host ?? process.env.MCP_HOST ?? '0.0.0.0'

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })

  const httpServer = http.createServer(async (req, res) => {
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', server: 'agentfactory-fleet', auth: isMcpAuthConfigured() }))
      return
    }

    // MCP endpoint — verify auth for non-health endpoints
    if (req.url === '/mcp') {
      const authResult = verifyMcpAuth(req.headers.authorization)
      if (!authResult.authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: authResult.error }))
        return
      }

      await transport.handleRequest(req, res)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. Use /mcp for MCP protocol or /health for health check.' }))
  })

  await server.connect(transport)

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      console.log(`[mcp-server] AgentFactory Fleet MCP server listening on http://${host}:${port}`)
      console.log(`[mcp-server] MCP endpoint: http://${host}:${port}/mcp`)
      console.log(`[mcp-server] Health check: http://${host}:${port}/health`)
      console.log(`[mcp-server] Auth: ${isMcpAuthConfigured() ? 'enabled' : 'disabled (dev mode)'}`)
      resolve(httpServer)
    })
  })
}
