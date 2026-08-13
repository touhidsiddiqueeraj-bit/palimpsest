import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer, type Server } from 'node:http';
import { z, type ZodType } from 'zod';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { TOOLS, type McpContext, type ToolDef } from './tools.js';

/** Minimal JSON-schema -> zod shape converter (all tool params are scalars/arrays today). */
function jsonSchemaToZodShape(schema: ToolDef['inputSchema']): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prop as any;
    if (p.type === 'string') shape[name] = z.string();
    else if (p.type === 'number') shape[name] = z.number();
    else if (p.type === 'boolean') shape[name] = z.boolean();
    else if (p.type === 'array')
      shape[name] = z.array(p.items?.type === 'number' ? z.number() : z.string());
    else shape[name] = z.any();
  }
  return shape;
}

/** Registers every capability-layer tool on an MCP server. */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'palimpsest', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.description,
        inputSchema: jsonSchemaToZodShape(tool.inputSchema) as unknown as AnySchema,
      },
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

/** Runs an MCP server over HTTP (Streamable HTTP transport, no external deps). */
export async function runHttpServer(ctx: McpContext, port = 3000): Promise<Server> {
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({});
  const http = createHttpServer((req, res) => {
    void transport.handleRequest(req, res);
  });
  await server.connect(transport);
  await new Promise<void>((resolve) => http.listen(port, resolve));
  return http;
}
