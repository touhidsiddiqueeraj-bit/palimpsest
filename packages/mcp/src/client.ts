import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * MCP client with per-tool allowlists and a write-through audit log.
 * Every call a host agent (or the user's assistant) makes is recorded —
 * no silent tool use, no unbounded tool access.
 */

export interface McpClientOptions {
  allowlist: string[];
  /** Receives one JSON line per call. Default: append to AUDIT_PATH (ignored when relative). */
  audit?: (line: string) => Promise<void>;
  name?: string;
}

export class McpClient {
  private readonly client: Client;
  private readonly allowlist: Set<string>;
  private readonly audit: (line: string) => Promise<void>;
  private readonly name: string;

  constructor(
    private readonly transport: Transport,
    options: McpClientOptions,
  ) {
    this.client = new Client({ name: options.name ?? 'palimpsest-client', version: '0.1.0' });
    this.allowlist = new Set(options.allowlist);
    this.audit = options.audit ?? defaultAudit();
    this.name = options.name ?? 'palimpsest-client';
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.transport.close();
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.allowlist.has(tool)) {
      await this.audit(
        JSON.stringify({ ts: Date.now(), source: this.name, tool, args, denied: true }),
      );
      throw new Error(`tool "${tool}" is not in the allowlist`);
    }
    const result = (await this.client.callTool({
      name: tool,
      arguments: args as Record<string, unknown>,
    })) as { content?: Array<{ type: string; text?: string }> };
    const text =
      result.content
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n') ?? '';
    const parsed = parseResult(text);
    await this.audit(JSON.stringify({ ts: Date.now(), source: this.name, tool, args, ok: true }));
    return parsed as T;
  }

  /** Creates a stdio client for a spawned server command. */
  static stdio(command: string, args: string[], options: McpClientOptions): McpClient {
    return new McpClient(new StdioClientTransport({ command, args, cwd: process.cwd() }), options);
  }
}

/** tools/list-style Transport shim for tests: feed a fake transport. */
export type { Transport };

const defaultAudit = (): ((line: string) => Promise<void>) => {
  // durable sink when the desktop app points PALIMPSEST_AUDIT at a file;
  // otherwise no-op (tests inject their own)
  const path = process.env.PALIMPSEST_AUDIT;
  return async (line: string) => {
    if (path) await import('node:fs/promises').then((fs) => fs.appendFile(path, line + '\n'));
  };
};

const parseResult = (text: string): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
