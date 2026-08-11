/**
 * Word-level, rewrap-tolerant diff engine.
 *
 * Algorithm (reference: reference/v0-single-file-prototype.html):
 * 1. Split both texts into blocks on blank lines; key = whitespace-collapsed
 *    text (rewrapping becomes invisible to the diff).
 * 2. LCS over block keys (DP, capped at 400x400; beyond that, fall back to
 *    whole-document replace).
 * 3. Within each contiguous delete/insert run, pair deletions with insertions
 *    by order into "changed" pairs.
 * 4. For changed pairs, tokenize to words (whitespace dropped, case-sensitive)
 *    and LCS with a cap (1500x1500 tokens); if exceeded, render the pair as a
 *    full replace.
 * 5. Emit typed ops (equal | insert | delete) with per-op word counts.
 */

export type DiffOpType = 'equal' | 'insert' | 'delete';

export interface DiffOp {
  type: DiffOpType;
  text: string;
  words: number;
  /** True when this op is a word-level run inside a changed paragraph. */
  inline: boolean;
}

export interface DiffResult {
  ops: DiffOp[];
  added: number;
  removed: number;
}

export interface DiffOptions {
  /** Called with progress 0..1 (block pairing and word diffs complete). */
  onProgress?: (progress: number) => void;
}

export const BLOCK_LCS_CAP = 400 * 400;
export const WORD_LCS_CAP = 1500 * 1500;

export function countWords(text: string): number {
  return (text.match(/\S+/g) || []).length;
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface Block {
  text: string;
  key: string;
}

function splitBlocks(text: string): Block[] {
  return String(text)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => ({ text: b, key: collapse(b) }));
}

type LcsOp =
  | { kind: 'eq'; a: number; b: number }
  | { kind: 'del'; a: number }
  | { kind: 'ins'; b: number };

/**
 * Longest common subsequence via DP. Returns null when the cell budget is
 * exceeded (caller decides the fallback). The returned ops walk a->b.
 */
function lcs(a: readonly string[], b: readonly string[], maxCells: number): LcsOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ kind: 'ins' as const, b: j }));
  if (m === 0) return a.map((_, i) => ({ kind: 'del' as const, a: i }));
  if ((n + 1) * (m + 1) > maxCells) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  const cell = (i: number, j: number) => dp[i * w + j]!;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', a: i, b: j });
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      ops.push({ kind: 'del', a: i });
      i++;
    } else {
      ops.push({ kind: 'ins', b: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', a: i });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'ins', b: j });
    j++;
  }
  return ops;
}

function trivialOps(n: number, m: number): LcsOp[] {
  const ops: LcsOp[] = [];
  for (let i = 0; i < n; i++) ops.push({ kind: 'del', a: i });
  for (let j = 0; j < m; j++) ops.push({ kind: 'ins', b: j });
  return ops;
}

/**
 * Word-level diff of a changed block pair. Returns inline ops (equal runs
 * inside the paragraph included) plus added/removed word counts.
 */
function wordDiff(a: string, b: string): { ops: DiffOp[]; added: number; removed: number } {
  const ta = a.match(/\S+/g) ?? [];
  const tb = b.match(/\S+/g) ?? [];
  const ops = lcs(ta, tb, WORD_LCS_CAP);
  if (!ops) {
    return {
      ops: [
        { type: 'delete', text: collapse(a), words: ta.length, inline: true },
        { type: 'insert', text: collapse(b), words: tb.length, inline: true },
      ],
      added: tb.length,
      removed: ta.length,
    };
  }
  const out: DiffOp[] = [];
  let added = 0;
  let removed = 0;
  let runType: DiffOpType | null = null;
  let runWords = 0;
  let run = '';
  const emit = () => {
    if (!runWords) return;
    out.push({ type: runType as DiffOpType, text: run, words: runWords, inline: true });
    run = '';
    runWords = 0;
  };
  for (const op of ops) {
    const type: DiffOpType = op.kind === 'eq' ? 'equal' : op.kind === 'del' ? 'delete' : 'insert';
    if (type !== runType) {
      emit();
      runType = type;
    }
    const word = op.kind === 'eq' || op.kind === 'del' ? ta[op.a]! : tb[op.b]!;
    if (run) run += ' ';
    run += word;
    runWords++;
    if (type === 'delete') removed++;
    else if (type === 'insert') added++;
  }
  emit();
  return { ops: out, added, removed };
}

export function diffProse(aText: string, bText: string, options: DiffOptions = {}): DiffResult {
  const { onProgress } = options;
  if (aText === bText) return { ops: [], added: 0, removed: 0 };
  const A = splitBlocks(aText);
  const B = splitBlocks(bText);
  const ops = lcs(A.map((x) => x.key), B.map((x) => x.key), BLOCK_LCS_CAP) ?? trivialOps(A.length, B.length);

  const out: DiffOp[] = [];
  let added = 0;
  let removed = 0;
  let k = 0;
  let pairsDone = 0;
  let pairsTotal = 0;
  {
    let runDels = 0;
    let runIns = 0;
    for (const op of ops) {
      if (op.kind === 'eq') {
        pairsTotal += Math.min(runDels, runIns);
        runDels = 0;
        runIns = 0;
      } else if (op.kind === 'del') {
        runDels++;
      } else {
        runIns++;
      }
    }
    pairsTotal += Math.min(runDels, runIns);
  }
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.kind === 'eq') {
      const blk = A[op.a]!;
      out.push({ type: 'equal', text: collapse(blk.text), words: countWords(blk.text), inline: false });
      k++;
      continue;
    }
    const dA: Block[] = [];
    const iB: Block[] = [];
    let cur: LcsOp | undefined;
    while (k < ops.length && (cur = ops[k]) && cur.kind !== 'eq') {
      if (cur.kind === 'del') dA.push(A[cur.a]!);
      else iB.push(B[cur.b]!);
      k++;
    }
    const n = Math.min(dA.length, iB.length);
    for (let p = 0; p < n; p++) {
      const r = wordDiff(dA[p]!.text, iB[p]!.text);
      out.push(...r.ops);
      added += r.added;
      removed += r.removed;
      if (onProgress) {
        pairsDone++;
        onProgress(pairsTotal ? pairsDone / pairsTotal : 1);
      }
    }
    for (let p = n; p < dA.length; p++) {
      const words = countWords(dA[p]!.text);
      removed += words;
      out.push({ type: 'delete', text: collapse(dA[p]!.text), words, inline: false });
    }
    for (let p = n; p < iB.length; p++) {
      const words = countWords(iB[p]!.text);
      added += words;
      out.push({ type: 'insert', text: collapse(iB[p]!.text), words, inline: false });
    }
  }
  return { ops: out, added, removed };
}
