import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerFleetResources } from './resources.js'
import { registerFleetTools } from './tools.js'

export function createFleetMcpServer(): McpServer {
  const server = new McpServer({
    name: 'agentfactory-fleet',
    version: '0.7.52',
  })

  registerFleetTools(server)
  registerFleetResources(server)

  return server
}
