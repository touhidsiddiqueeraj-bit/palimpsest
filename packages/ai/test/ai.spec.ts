import { describe, expect, it, vi } from 'vitest';
import { createClient, inlineEdit, isLocalUrl, DEFAULT_PROVIDERS } from '../src/index.js';

function mockFetch(cb: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => Promise.resolve(cb(url, init))),
  );
  return () => vi.unstubAllGlobals();
}

describe('providers', () => {
  it('recognizes local endpoints', () => {
    expect(isLocalUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false);
  });

  it('offers local-first defaults only', () => {
    expect(DEFAULT_PROVIDERS[0]!.baseUrl).toContain('127.0.0.1');
    expect(DEFAULT_PROVIDERS[1]!.baseUrl).toContain('127.0.0.1');
  });
});

describe('client', () => {
  it('speaks the ollama chat protocol', async () => {
    const restore = mockFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:11434/api/chat');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('llama3.2');
      expect(body.stream).toBe(false);
      return new Response(JSON.stringify({ message: { content: 'jo' } }), { status: 200 });
    });
    const c = createClient({
      id: 'o',
      kind: 'ollama',
      baseUrl: DEFAULT_PROVIDERS[0]!.baseUrl,
      model: 'llama3.2',
    });
    expect(await c.complete([{ role: 'user', content: 'hi' }])).toBe('jo');
    restore();
  });

  it('speaks OpenAI chat/completions for lmstudio and openai kinds', async () => {
    const restore = mockFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('local-model');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'lm' } }] }), {
        status: 200,
      });
    });
    const c = createClient({
      id: 'lm',
      kind: 'lmstudio',
      baseUrl: DEFAULT_PROVIDERS[1]!.baseUrl,
      model: 'local-model',
    });
    expect(await c.complete([{ role: 'user', content: 'hi' }])).toBe('lm');
    restore();
  });

  it('sends the API key only for remote providers', async () => {
    const restore = mockFetch((_url, init) => {
      expect(new Headers(init.headers as HeadersInit).get('Authorization')).toBe('Bearer sk-test');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'k' } }] }), {
        status: 200,
      });
    });
    const c = createClient(
      {
        id: 'r',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test',
      },
      { localOnly: false },
    );
    expect(await c.complete([{ role: 'user', content: 'hi' }])).toBe('k');
    restore();
  });

  it('blocks remote endpoints under Local-only', async () => {
    const restore = mockFetch(() => new Response('{}', { status: 200 }));
    const c = createClient({
      id: 'r',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
    await expect(c.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('Local-only');
    restore();
  });

  it('reports non-OK responses', async () => {
    const restore = mockFetch(() => new Response('nope', { status: 500 }));
    const c = createClient({
      id: 'o',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'x',
    });
    await expect(c.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('HTTP 500');
    restore();
  });
});

describe('inlineEdit', () => {
  it('proposes a full document and diffs it word-level', async () => {
    const restore = mockFetch(
      () =>
        new Response(JSON.stringify({ message: { content: 'The red fox ran.' } }), { status: 200 }),
    );
    const c = createClient({
      id: 'o',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'x',
    });
    const { proposed, diff } = await inlineEdit({
      client: c,
      instruction: 'Make the fox red and running.',
      document: 'The quick brown fox jumps.',
    });
    expect(proposed).toBe('The red fox ran.');
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(3);
    restore();
  });

  it('never mutates the source document', async () => {
    const restore = mockFetch(
      () => new Response(JSON.stringify({ message: { content: 'X' } }), { status: 200 }),
    );
    const c = createClient({
      id: 'o',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'x',
    });
    const src = 'The quick brown fox jumps.';
    const { proposed } = await inlineEdit({ client: c, instruction: 'shorten', document: src });
    expect(proposed).toBe('X');
    expect(src).toBe('The quick brown fox jumps.');
    restore();
  });

  it('strips a single outer code fence models add despite the prompt', async () => {
    const wrapped = '```markdown\n# Title\n\nBody text.\n```';
    const restore = mockFetch(
      () => new Response(JSON.stringify({ message: { content: wrapped } }), { status: 200 }),
    );
    const c = createClient({
      id: 'o',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'x',
    });
    const { proposed } = await inlineEdit({
      client: c,
      instruction: 'anything',
      document: '# Title\n\nOld body.',
    });
    expect(proposed).toBe('# Title\n\nBody text.');
    restore();
  });

  it('keeps the response untouched when the source document itself starts with a fence', async () => {
    const wrapped = '```\nfenced body\n```';
    const restore = mockFetch(
      () => new Response(JSON.stringify({ message: { content: wrapped } }), { status: 200 }),
    );
    const c = createClient({
      id: 'o',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'x',
    });
    const { proposed } = await inlineEdit({
      client: c,
      instruction: 'anything',
      document: '```\noriginal fenced doc\n```',
    });
    expect(proposed).toBe(wrapped);
    restore();
  });
});
