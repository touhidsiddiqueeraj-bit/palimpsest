import { describe, expect, it } from 'vitest';
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '../src/client.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** In-memory transport that answers tool calls with the server-style JSON text content. */
class MemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly responses: Map<string, unknown>) {}

  async start(): Promise<void> {}

  async send(message: unknown): Promise<void> {
    const req = message as JSONRPCRequest;
    if (req.method === 'notifications/initialized') return;
    if (req.method === 'initialize') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'test', version: '0.0.0' },
        },
      } as JSONRPCMessage);
      return;
    }
    const params = req.params as { name?: string; arguments?: Record<string, unknown> };
    const payload = req.method === 'tools/call' ? (params.arguments ?? {}) : {};
    const result =
      req.method === 'tools/call'
        ? {
            content: [
              {
                type: 'text',
                text: JSON.stringify(this.responses.get(String(params.name)) ?? payload),
              },
            ],
          }
        : { tools: [] };
    this.onmessage?.({ jsonrpc: '2.0', id: req.id, result } as JSONRPCMessage);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

const withAudit = (): { lines: string[]; audit: (l: string) => Promise<void> } => {
  const lines: string[] = [];
  return {
    lines,
    audit: (l) => {
      lines.push(l);
      return Promise.resolve();
    },
  };
};

describe('mcp client (allowlist + audit)', () => {
  it('routes allowed calls and parses JSON text results', async () => {
    const { lines, audit } = withAudit();
    const client = new McpClient(
      new MemoryTransport(new Map([['recall', { results: [{ status: 'current' }] }]])),
      {
        allowlist: ['recall'],
        audit,
      },
    );
    await client.connect();
    const r = await client.call<{ results: Array<{ status: string }> }>('recall', { query: 'fox' });
    expect(r.results[0]?.status).toBe('current');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ tool: 'recall', ok: true });
    await client.close();
  });

  it('denies non-allowlisted tools and still records the attempt', async () => {
    const { lines, audit } = withAudit();
    const client = new McpClient(new MemoryTransport(new Map()), {
      allowlist: ['recall'],
      audit,
    });
    await client.connect();
    await expect(client.call('restore_version', { snapshot_id: 1 })).rejects.toThrow(/allowlist/);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ tool: 'restore_version', denied: true });
    await client.close();
  });
});
