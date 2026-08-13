import { diffProse, type DiffResult } from '@palimpsest/core';
import type { AiClient } from './client.js';

export interface InlineEditResult {
  proposed: string;
  diff: DiffResult;
}

const SYSTEM = [
  'You edit Markdown documents. Return ONLY the full edited document,',
  'no commentary, no code fences, no preamble.',
].join(' ');

/**
 * AI proposes, the diff decides (product law 4). Returns the proposed text
 * plus the word-level diff against the current document — never writes.
 */
export async function inlineEdit(opts: {
  client: AiClient;
  instruction: string;
  document: string;
}): Promise<InlineEditResult> {
  const proposed = await opts.client.complete([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${opts.instruction}\n\n---\n${opts.document}`,
    },
  ]);
  return { proposed, diff: diffProse(opts.document, proposed) };
}
