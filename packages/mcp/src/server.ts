import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer, type Server } from 'node:http';
import { z, type ZodType } from 'zod';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { TOOLS, type McpContext, type ToolDef } from './tools.js';

/** Minimal JSON-schema -> zod shape converter (all tool params are scalars/arrays today). */
function jsonSchemaToZodShape(schema: ToolDef['inputSchema']): Record<string, ZodType> {
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const shape: Record<string, ZodType> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const opt = (t: ZodType): ZodType => (required.has(name) ? t : t.optional());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prop as any;
    if (p.type === 'string') shape[name] = opt(z.string());
    else if (p.type === 'number') shape[name] = opt(z.number());
    else if (p.type === 'boolean') shape[name] = opt(z.boolean());
    else if (p.type === 'array')
      shape[name] = opt(z.array(p.items?.type === 'number' ? z.number() : z.string()));
    else shape[name] = opt(z.any());
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
  const http = createHttpServer((req, res) => {
    // stateless mode: fresh server + transport per request (SDK session state
    // breaks when one transport instance handles more than one request)
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({});
    void (async () => {
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
        // Close on response end (the SDK's documented stateless pattern) —
        // without this every request leaked its transport/session pair.
        res.on('close', () => {
          void transport.close().catch(() => {});
          void server.close().catch(() => {});
        });
      } catch (err) {
        console.error('palimpsest mcp http error:', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => http.listen(port, resolve));
  return http;
}
