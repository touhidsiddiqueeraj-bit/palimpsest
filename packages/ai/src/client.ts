import { isLocalUrl, type Provider } from './providers.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiClient {
  provider: Provider;
  /** Single non-streaming completion. */
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface ClientOptions {
  /** Hard Local-only gate (product law 7). Blocks non-local endpoints. */
  localOnly?: boolean;
  fetchImpl?: typeof fetch;
}

/** Normalizes a BYOK endpoint to the protocol its kind speaks. */
export function createClient(provider: Provider, opts: ClientOptions = {}): AiClient {
  const localOnly = opts.localOnly ?? true;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const call = async (url: string, init: RequestInit): Promise<string> => {
    if (localOnly && !isLocalUrl(url)) {
      throw new Error(`Local-only mode: blocked request to ${new URL(url).hostname}`);
    }
    const res = await fetchImpl(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return res.text();
  };

  return {
    provider,
    async complete(messages) {
      if (provider.kind === 'ollama') {
        const body = await call(`${provider.baseUrl.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: provider.model, messages, stream: false }),
        });
        const data = JSON.parse(body) as { message?: { content?: string } };
        return data.message?.content ?? '';
      }
      const body = await call(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: provider.model, messages }),
      });
      const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}
