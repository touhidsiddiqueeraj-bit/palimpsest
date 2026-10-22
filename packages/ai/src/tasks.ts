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

/** Models routinely wrap the whole document in one outer code fence despite the
 * system prompt (```markdown ... ```). Accepting that verbatim would corrupt the
 * document on Accept/apply_edit, so strip a single outermost fence — but only
 * when the original document itself does not already start with a fence
 * (otherwise the wrap is ambiguous and we keep the response untouched). */
export function stripOuterFence(proposed: string, document: string): string {
  if (document.startsWith('```')) return proposed;
  const m = proposed.match(/^\s*```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*\s*$/);
  return m ? m[1]! : proposed;
}

/**
 * AI proposes, the diff decides (product law 4). Returns the proposed text
 * plus the word-level diff against the current document — never writes.
 */
export async function inlineEdit(opts: {
  client: AiClient;
  instruction: string;
  document: string;
}): Promise<InlineEditResult> {
  const proposed = stripOuterFence(
    await opts.client.complete([
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${opts.instruction}\n\n---\n${opts.document}`,
      },
    ]),
    opts.document,
  );
  return { proposed, diff: diffProse(opts.document, proposed) };
}
