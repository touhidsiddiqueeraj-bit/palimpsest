/**
 * Markdown renderer: HTML + lightweight block-level AST.
 *
 * Port of the v0 prototype renderer (reference/v0-single-file-prototype.html)
 * upgraded with: GFM footnotes, GitHub callouts, [[wikilinks]] resolution,
 * math block pass-through, and link sanitization. All output is escaped —
 * documents can never inject raw HTML.
 */

import { esc } from '../diff/html.js';

export interface RenderOptions {
  /** Maps a [[wikilink]] target to an href; null leaves it unresolved. */
  wikilinkResolver?: (target: string) => string | null;
}

export type AstBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'callout'; kind: string; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'math'; text: string }
  | { type: 'footnote-def'; id: string; text: string }
  | { type: 'hr' };

export interface RenderResult {
  html: string;
  ast: AstBlock[];
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const INTERNAL_LINK = /^(#|\/|\.)/;
const CALLOT_KINDS = new Set(['note', 'tip', 'warning', 'important', 'caution']);

function safeHref(href: string): boolean {
  const h = href.trim();
  return SAFE_LINK.test(h) || INTERNAL_LINK.test(h);
}

interface InlineCtx {
  resolver?: RenderOptions['wikilinkResolver'];
  footnotes: string[];
}

/** Renders inline markdown to escaped HTML, collecting footnote refs in order. */
function inline(text: string, ctx: InlineCtx): string {
  let s = esc(text);
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(String(c));
    return '\u0001' + (codes.length - 1) + '\u0001';
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, url) => {
    const href = String(url).replace(/&amp;/g, '&');
    if (!safeHref(href)) return esc(alt);
    return '<img src="' + esc(href) + '" alt="' + esc(alt) + '" loading="lazy">';
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, txt, url) => {
    const href = String(url).replace(/&amp;/g, '&');
    if (!safeHref(href)) return esc(txt);
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + txt + '</a>';
  });
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, target, alias) => {
    const t = String(target).trim();
    const label = alias ? String(alias) : t;
    const href = ctx.resolver ? ctx.resolver(t) : null;
    if (href === null || href === undefined) {
      return '<span class="wikilink-unresolved">[[' + esc(t) + ']]</span>';
    }
    return '<a href="' + esc(href) + '" class="wikilink">' + esc(label) + '</a>';
  });
  s = s.replace(/\[\^([^\]]+)\]/g, (m, id) => {
    const n = ctx.footnotes.indexOf(String(id));
    if (n === -1) {
      ctx.footnotes.push(String(id));
      return '<sup class="footnote-ref"><a href="#fn-' + (ctx.footnotes.length) + '" id="fnref-' + (ctx.footnotes.length) + '">' + (ctx.footnotes.length) + '</a></sup>';
    }
    const num = n + 1;
    return '<sup class="footnote-ref"><a href="#fn-' + num + '" id="fnref-' + num + '">' + num + '</a></sup>';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/\u0001(\d+)\u0001/g, (m, n) => '<code>' + codes[+n] + '</code>');
  return s;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

interface ParseOut {
  html: string;
  next: number;
  ast: AstBlock[];
}

function parseTable(lines: string[], i: number, ctx: InlineCtx, ast: AstBlock[]): ParseOut {
  const header = splitTableRow(lines[i]!);
  const aligns = splitTableRow(lines[i + 1]!).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  let j = i + 2;
  const rows: string[][] = [];
  while (j < lines.length && lines[j]!.includes('|') && !/^\s*$/.test(lines[j]!)) {
    rows.push(splitTableRow(lines[j]!));
    j++;
  }
  const al = (k: number) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
  let html = '<table><thead><tr>' + header.map((h, k) => '<th' + al(k) + '>' + inline(h, ctx) + '</th>').join('') + '</tr></thead><tbody>';
  for (const r of rows) {
    html += '<tr>' + header.map((_, k) => '<td' + al(k) + '>' + inline(r[k] || '', ctx) + '</td>').join('') + '</tr>';
  }
  html += '</tbody></table>';
  ast.push({ type: 'table', headers: header, rows });
  return { html, next: j, ast };
}

function renderListAst(n: ListNode): AstBlock {
  const items: string[] = [];
  const collect = (node: ListNode) => {
    for (const it of node.items) {
      items.push(it.check !== null ? (it.check ? '[x] ' : '[ ] ') + it.text : it.text);
      if (it.childList) collect(it.childList);
    }
  };
  collect(n);
  return { type: 'list', ordered: n.type === 'ol', items };
}

interface ListItem {
  text: string;
  check: boolean | null;
  childList: ListNode | null;
}

interface ListNode {
  type: string | null;
  indent: number;
  items: ListItem[];
}

function renderListNode(n: ListNode): string {
  if (!n.items.length) return '';
  const tag = n.type === 'ol' ? 'ol' : 'ul';
  return (
    '<' + tag + '>' +
    n.items
      .map((it) => {
        let h = '<li' + (it.check !== null ? ' class="task"' : '') + '>';
        if (it.check !== null) h += '<input type="checkbox" disabled' + (it.check ? ' checked' : '') + '> ';
        h += it.text;
        if (it.childList) h += renderListNode(it.childList);
        return h + '</li>';
      })
      .join('') +
    '</' + tag + '>'
  );
}

function parseList(lines: string[], i: number, ctx: InlineCtx, ast: AstBlock[]): ParseOut {
  const itemRe = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const root: ListNode = { type: null, indent: -1, items: [] };
  const stack: ListNode[] = [root];
  let lastItem: ListItem | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) {
      const nxt = lines[i + 1] || '';
      if (itemRe.test(nxt) || /^\s{2,}\S/.test(nxt)) {
        i++;
        continue;
      }
      break;
    }
    const m = line.match(itemRe);
    if (m) {
      const indent = m[1]!.replace(/\t/g, '  ').length;
      const ordered = /^\d/.test(m[2]!);
      while (stack.length > 1) {
        const top = stack[stack.length - 1]!;
        if (indent > top.indent) break;
        if (indent === top.indent && top.type && (top.type === 'ol') === ordered) break;
        stack.pop();
      }
      let top = stack[stack.length - 1]!;
      if (!top.type) {
        top.type = ordered ? 'ol' : 'ul';
        top.indent = indent;
      } else if (indent > top.indent) {
        const host = top.items[top.items.length - 1]!;
        const nl: ListNode = { type: ordered ? 'ol' : 'ul', indent, items: [] };
        if (host) host.childList = nl;
        stack.push(nl);
        top = nl;
      }
      const item: ListItem = { text: m[3]!, check: null, childList: null };
      const cb = item.text.match(/^\[([ xX])\]\s+(.*)$/);
      if (cb && top.type === 'ul') {
        item.check = cb[1] !== ' ';
        item.text = cb[2]!;
      }
      item.text = inline(item.text, ctx);
      top.items.push(item);
      lastItem = item;
      i++;
      continue;
    }
    if (/^\s{2,}\S/.test(line) && lastItem) {
      lastItem.text += ' ' + inline(line.trim(), ctx);
      i++;
      continue;
    }
    break;
  }
  ast.push(renderListAst(root));
  return { html: renderListNode(root), next: i, ast };
}

function renderMarkdownImpl(src: string, options: RenderOptions): RenderResult {
  const ctx: InlineCtx = { resolver: options.wikilinkResolver, footnotes: [] };
  const fnDefs: Array<[string, string, number]> = []; // id, html, ref line
  const ast: AstBlock[] = [];
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let i = 0;

  const flushP = () => {
    if (para.length) {
      const text = para.join('\n');
      const html = '<p>' + para.map((l) => inline(l, ctx)).join('<br>') + '</p>';
      out.push(html);
      ast.push({ type: 'paragraph', text });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;
    let m: RegExpMatchArray | null;
    if (/^\s*$/.test(line)) {
      flushP();
      i++;
      continue;
    }
    if ((m = line.match(/^[ \t]*\$\$\s*$/))) {
      flushP();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++;
      const text = buf.join('\n');
      out.push('<div class="math">' + esc(text) + '</div>');
      ast.push({ type: 'math', text });
      continue;
    }
    if ((m = line.match(/^\s*`{3,}(.*)$/))) {
      flushP();
      const lang = m[1]!.trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*`{3,}\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++;
      const text = buf.join('\n');
      out.push('<pre' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' + esc(text) + '</code></pre>');
      ast.push({ type: 'code', lang, text });
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushP();
      const level = m[1]!.length;
      const text = m[2]!.replace(/\s+#+\s*$/, '');
      out.push('<h' + level + '>' + inline(text, ctx) + '</h' + level + '>');
      ast.push({ type: 'heading', level, text });
      i++;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushP();
      out.push('<hr>');
      ast.push({ type: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushP();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*> ?/, ''));
        i++;
      }
      let inner = buf.join('\n');
      let kind = '';
      const cm = inner.match(/^\[!([a-z]+)\](?:\s+|$)/i);
      if (cm && CALLOT_KINDS.has(cm[1]!.toLowerCase())) {
        kind = cm[1]!.toLowerCase();
        inner = inner.replace(/^\[![a-z]+\][ \t]*(?:\n|$)/i, '');
      }
      const sub = renderMarkdownImpl(inner, options);
      if (kind) {
        out.push('<div class="callout callout-' + kind + '">' + sub.html + '</div>');
        ast.push({ type: 'callout', kind, text: inner });
      } else {
        out.push('<blockquote>' + sub.html + '</blockquote>');
        ast.push({ type: 'blockquote', text: inner });
      }
      continue;
    }
    if ((m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/))) {
      flushP();
      const r = parseList(lines, i, ctx, ast);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-') && lines[i + 1]!.includes('|')) {
      flushP();
      const r = parseTable(lines, i, ctx, ast);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if ((m = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/))) {
      flushP();
      const id = m[1]!;
      const text = m[2]!;
      const num = ctx.footnotes.indexOf(id);
      if (num === -1) {
        ctx.footnotes.push(id);
        fnDefs.push([id, inline(text, ctx), ctx.footnotes.length]);
      } else {
        fnDefs.push([id, inline(text, ctx), num + 1]);
      }
      ast.push({ type: 'footnote-def', id, text });
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushP();

  if (fnDefs.length) {
    out.push('<section class="footnotes"><ol>');
    for (const [, html, num] of fnDefs) {
      out.push('<li id="fn-' + num + '">' + html + ' <a href="#fnref-' + num + '" class="footnote-back">↩</a></li>');
    }
    out.push('</ol></section>');
  }

  return { html: out.join('\n'), ast };
}

export function renderMarkdown(src: string, options: RenderOptions = {}): RenderResult {
  return renderMarkdownImpl(src, options);
}
