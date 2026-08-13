import { countWords } from '../diff/index.js';
import type { SnapshotKind, SnapshotMeta } from './types.js';

/** Frontmatter fields recorded in every snapshot file (spec §4.3). */
export interface SnapshotFrontmatter {
  id: number;
  doc: string;
  ts: number;
  kind: SnapshotKind;
  label: string;
  words: number;
  model?: string;
  instruction?: string;
}

const esc = (s: string) => JSON.stringify(s.replace(/\n/g, ' '));

/** Serialize a snapshot to a plain .md file: YAML frontmatter + full text. */
export function encodeSnapshotFile(fm: SnapshotFrontmatter, text: string): string {
  const lines = [
    '---',
    `id: ${fm.id}`,
    `doc: ${esc(fm.doc)}`,
    `ts: ${fm.ts}`,
    `kind: ${fm.kind}`,
    `label: ${esc(fm.label)}`,
    `words: ${fm.words}`,
  ];
  if (fm.model) lines.push(`model: ${esc(fm.model)}`);
  if (fm.instruction) lines.push(`instruction: ${esc(fm.instruction)}`);
  lines.push('---', '');
  return lines.join('\n') + text;
}

/** Parse a snapshot file back into frontmatter + text. */
export function parseSnapshotFile(content: string): { fm: SnapshotFrontmatter; text: string } {
  const eol = content.indexOf('\n');
  if (!content.startsWith('---') || eol < 0) throw new Error('snapshot file missing frontmatter');
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('snapshot file missing closing frontmatter');
  const fm = parseFrontmatter(content.slice(4, end).split('\n'));
  const text = content.slice(end + 5);
  return { fm, text };
}

function parseFrontmatter(lines: string[]): SnapshotFrontmatter {
  const raw: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    raw[line.slice(0, i).trim()] = unquote(line.slice(i + 1).trim());
  }
  const num = (k: string) => Number(raw[k] ?? NaN);
  return {
    id: num('id'),
    doc: raw['doc'] ?? '',
    ts: num('ts'),
    kind: (raw['kind'] ?? 'auto') as SnapshotKind,
    label: raw['label'] ?? '',
    words: num('words') || 0,
    model: raw['model'] || undefined,
    instruction: raw['instruction'] || undefined,
  };
}

const unquote = (s: string) =>
  s.length >= 2 && s[0] === '"' && s.endsWith('"') ? JSON.parse(s) : s;

/** Frontmatter for a fresh capture; words recomputed from the text. */
export function makeFrontmatter(
  id: number,
  doc: string,
  ts: number,
  kind: SnapshotKind,
  label: string,
  meta: SnapshotMeta,
  text: string,
): SnapshotFrontmatter {
  const fm: SnapshotFrontmatter = {
    id,
    doc,
    ts,
    kind,
    label,
    words: countWords(text),
  };
  if (typeof meta.model === 'string') fm.model = meta.model;
  if (typeof meta.instruction === 'string') fm.instruction = meta.instruction;
  return fm;
}
