import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { TOOLS, type McpContext } from './tools.js';

/** Registers every capability-layer tool on an MCP server. */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'palimpsest', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.description, inputSchema: tool.inputSchema as unknown as AnySchema },
      async (args: Record<string, unknown>) => {
        const result = await tool.run(args, ctx);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }
  return server;
}

/** Runs a stdio MCP server (spawned by the desktop app or an agent host). */
export async function runStdioServer(ctx: McpContext): Promise<void> {
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}
