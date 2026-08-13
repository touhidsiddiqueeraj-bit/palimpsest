/** BYOK provider registry: model-agnostic, keys never travel. */

export type ProviderKind = 'ollama' | 'lmstudio' | 'openai';

export interface Provider {
  /** Stable id the user picks from. */
  id: string;
  kind: ProviderKind;
  /** Local-first default endpoints; host overrides to any BYOK endpoint. */
  baseUrl: string;
  model: string;
  /** Optional key passed to remote (non-local) providers only. */
  apiKey?: string;
}

export const DEFAULT_PROVIDERS: Array<{
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
}> = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' },
  {
    kind: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
  },
  {
    kind: 'openai',
    label: 'OpenAI-compatible (BYOK)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
];

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}
