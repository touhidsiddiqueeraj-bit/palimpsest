import type { DiffOp } from './engine';

export function esc(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/**
 * Renders typed diff ops as <ins>/<del> HTML, grouped into paragraphs the way
 * the v0 prototype renders them: each block-level op owns a <p>, inline ops
 * merge into the surrounding paragraph.
 */
export function renderDiffHtml(ops: readonly DiffOp[]): string {
  if (ops.length === 0) return '<p class="muted">Identical to the current text.</p>';
  let html = '';
  let paragraphOpen = false;
  for (const op of ops) {
    if (op.type === 'equal') {
      html += (paragraphOpen ? '' : '<p>') + esc(op.text);
      paragraphOpen = true;
      continue;
    }
    if (paragraphOpen) {
      html += '</p>';
      paragraphOpen = false;
    }
    if (op.type === 'delete') {
      html += '<p><del>' + esc(op.text) + '</del></p>';
    } else {
      html += '<p><ins>' + esc(op.text) + '</ins></p>';
    }
  }
  if (paragraphOpen) html += '</p>';
  return html;
}
