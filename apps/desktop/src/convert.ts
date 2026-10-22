/**
 * HTML -> Markdown converter for import (spec: import/export).
 *
 * Tree-based: the app's own exporter emits a complete standalone document
 * (doctype/head/title/style/body) and the renderer produces nested lists,
 * fenced code, tables, callouts, task checkboxes and footnotes. The previous
 * regex soup imported that as raw CSS text glued to the document, merged
 * nested-list items into one item, collapsed code fences into single-backtick
 * runs and fused table cells together. This converter round-trips the
 * renderer's own output; foreign HTML degrades gracefully (unknown tags pass
 * their text through).
 */

interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: Node[];
}
type Node = { text: string } | El;

const VOID_TAGS = new Set(['meta', 'br', 'hr', 'img', 'input', 'link', 'source', 'area', 'base']);
const DROP_TAGS = new Set(['style', 'script', 'head', 'title', 'meta', 'link', 'noscript']);
const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'blockquote',
  'pre',
  'table',
  'div',
  'section',
  'article',
  'main',
  'hr',
  'figure',
  'figcaption',
]);

const TAG_RE = /<\s*(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/y;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

const isEl = (n: Node): n is El => 'tag' in n;

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    const named = NAMED_ENTITIES[name.toLowerCase()];
    if (named !== undefined) return named;
    if (name.startsWith('#')) {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isNaN(code) && code > 0 && code < 0x110000) return String.fromCodePoint(code);
    }
    return whole;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** Tolerant tag tokenizer; comments, doctype and PIs are skipped, stray
 * close tags ignored, text preserved verbatim (entities decoded at emit). */
function parseHtml(html: string): Node[] {
  const root: El = { tag: '#root', attrs: {}, kids: [] };
  const stack: El[] = [root];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1]!.kids.push({ text: html.slice(i) });
      break;
    }
    if (lt > i) stack[stack.length - 1]!.kids.push({ text: html.slice(i, lt) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    // Only "<tag" / "</tag" are tags; a "<" followed by anything else
    // (space, digit, "="...) is literal text (e.g. "a < b").
    if (!/[a-zA-Z/]/.test(html[lt + 1] ?? '')) {
      stack[stack.length - 1]!.kids.push({ text: '<' });
      i = lt + 1;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      stack[stack.length - 1]!.kids.push({ text: '<' });
      i = lt + 1;
      continue;
    }
    i = TAG_RE.lastIndex;
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      // close: pop through the nearest matching open tag
      const idx = stack.map((e) => e.tag).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const el: El = { tag, attrs: parseAttrs(m[3] ?? ''), kids: [] };
    stack[stack.length - 1]!.kids.push(el);
    if (!m[4] && !VOID_TAGS.has(tag)) stack.push(el);
  }
  return root.kids;
}

/** Raw (entity-decoded) text of a subtree, for <pre>/<code> content. */
function rawText(nodes: Node[]): string {
  let s = '';
  for (const n of nodes) s += isEl(n) ? rawText(n.kids) : decodeEntities(n.text);
  return s;
}

function emitInline(nodes: Node[]): string {
  let s = '';
  for (const n of nodes) {
    if (!isEl(n)) {
      s += decodeEntities(n.text);
      continue;
    }
    switch (n.tag) {
      case 'strong':
      case 'b':
        s += '**' + emitInline(n.kids) + '**';
        break;
      case 'em':
      case 'i':
        s += '*' + emitInline(n.kids) + '*';
        break;
      case 'del':
      case 's':
      case 'strike':
        s += '~~' + emitInline(n.kids) + '~~';
        break;
      case 'mark':
        s += '==' + emitInline(n.kids) + '==';
        break;
      case 'code': {
        const t = emitInline(n.kids);
        s += t.includes('`') ? '`` ' + t + ' ``' : '`' + t + '`';
        break;
      }
      case 'br':
        s += '\n';
        break;
      case 'img':
        s += '![' + (n.attrs.alt ?? '') + '](' + (n.attrs.src ?? '') + ')';
        break;
      case 'a': {
        if ((n.attrs.class ?? '').includes('footnote-back')) break;
        const href = n.attrs.href ?? '';
        const txt = emitInline(n.kids);
        if (txt && href) s += '[' + txt + '](' + href + ')';
        else s += txt;
        break;
      }
      case 'sup':
        if ((n.attrs.class ?? '').includes('footnote-ref')) {
          s += '[^' + rawText(n.kids).trim() + ']';
        } else {
          s += emitInline(n.kids);
        }
        break;
      default:
        if (DROP_TAGS.has(n.tag)) break;
        s += emitInline(n.kids);
    }
  }
  return s;
}

/** Prefix every line of a block's markdown with "> " (blank lines get ">"). */
function quote(md: string): string {
  return md
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => (l.trim() === '' ? '>' : '> ' + l))
    .join('\n');
}

function emitPre(el: El): string {
  const codeEl = el.kids.find((k): k is El => isEl(k) && k.tag === 'code');
  const content = (codeEl ? rawText(codeEl.kids) : rawText(el.kids)).replace(/\n+$/, '');
  let lang = (el.attrs['data-lang'] ?? '').replace(/[`\r\n]/g, '').trim();
  if (codeEl && !lang) lang = (codeEl.attrs['data-lang'] ?? '').replace(/[`\r\n]/g, '').trim();
  let fence = '```';
  while (content.includes(fence)) fence += '`';
  return fence + lang + '\n' + content + '\n' + fence + '\n\n';
}

function emitList(el: El, ordered: boolean, depth: number): string {
  const lines: string[] = [];
  let n = 0;
  for (const k of el.kids) {
    if (!isEl(k) || k.tag !== 'li') continue;
    n++;
    let checked: boolean | null = null;
    let inline = '';
    let nested = '';
    for (const c of k.kids) {
      if (!isEl(c)) {
        inline += decodeEntities(c.text);
        continue;
      }
      if (c.tag === 'input') {
        checked = 'checked' in c.attrs;
        continue;
      }
      if (c.tag === 'ul' || c.tag === 'ol') {
        nested += emitList(c, c.tag === 'ol', depth + 1);
        continue;
      }
      inline += BLOCK_TAGS.has(c.tag) ? emitBlock(c) : emitInline([c]);
    }
    const marker = ordered ? n + '. ' : '- ';
    const box = checked === null ? '' : checked ? '[x] ' : '[ ] ';
    const pad = '  '.repeat(depth);
    const item = pad + marker + box + inline.replace(/\s+/g, ' ').trim();
    lines.push(nested ? item + '\n' + nested.replace(/\n+$/, '') : item);
  }
  return lines.join('\n') + '\n\n';
}

function cellsOf(tr: El): Array<{ text: string; align: string }> {
  const out: Array<{ text: string; align: string }> = [];
  for (const k of tr.kids) {
    if (isEl(k) && (k.tag === 'th' || k.tag === 'td')) {
      const align = /text-align:\s*(\w+)/.exec(k.attrs.style ?? '')?.[1] ?? '';
      out.push({ text: emitInline(k.kids).trim(), align });
    }
  }
  return out;
}

function emitTable(el: El): string {
  const trs: El[] = [];
  const walk = (node: Node): void => {
    if (!isEl(node)) return;
    if (node.tag === 'tr') trs.push(node);
    else node.kids.forEach(walk);
  };
  el.kids.forEach(walk);
  if (trs.length === 0) return '';
  const header = cellsOf(trs[0]!);
  if (header.length === 0) return '';
  const lines = [
    '| ' + header.map((h) => h.text).join(' | ') + ' |',
    '| ' +
      header
        .map((h) => (h.align === 'center' ? ':---:' : h.align === 'right' ? '---:' : '---'))
        .join(' | ') +
      ' |',
  ];
  for (const tr of trs.slice(1)) {
    const cells = cellsOf(tr);
    lines.push('| ' + header.map((_, i) => cells[i]?.text ?? '').join(' | ') + ' |');
  }
  return lines.join('\n') + '\n\n';
}

function emitFootnotes(el: El): string {
  const defs: string[] = [];
  const walk = (node: Node): void => {
    if (!isEl(node)) return;
    if (node.tag === 'li') {
      const id = /^fn-(.+)$/.exec(node.attrs.id ?? '')?.[1];
      if (id) {
        const kids = node.kids.filter(
          (k) => !(isEl(k) && (k.attrs.class ?? '').includes('footnote-back')),
        );
        defs.push('[^' + id + ']: ' + emitInline(kids).trim());
      }
    } else {
      node.kids.forEach(walk);
    }
  };
  el.kids.forEach(walk);
  return defs.length ? defs.join('\n') + '\n\n' : '';
}

function emitBlock(el: El): string {
  const heading = /^h([1-6])$/.exec(el.tag);
  if (heading) return '#'.repeat(+heading[1]!) + ' ' + emitInline(el.kids).trim() + '\n\n';
  switch (el.tag) {
    case 'p': {
      const t = emitInline(el.kids);
      return t.trim() ? t + '\n\n' : '';
    }
    case 'hr':
      return '---\n\n';
    case 'pre':
      return emitPre(el);
    case 'blockquote':
      return quote(emitNodes(el.kids)) + '\n\n';
    case 'div': {
      const cls = el.attrs.class ?? '';
      const kind = /(?:^|\s)callout-(\w+)/.exec(cls)?.[1];
      if (/(?:^|\s)callout(?:\s|$)/.test(cls) && kind) {
        return quote('[!' + kind + ']\n' + emitNodes(el.kids)) + '\n\n';
      }
      return emitNodes(el.kids);
    }
    case 'ul':
      return emitList(el, false, 0);
    case 'ol':
      return emitList(el, true, 0);
    case 'table':
      return emitTable(el);
    case 'section':
      if ((el.attrs.class ?? '').includes('footnotes')) return emitFootnotes(el);
      return emitNodes(el.kids);
    default:
      return emitNodes(el.kids);
  }
}

function emitNodes(nodes: Node[]): string {
  let s = '';
  for (const n of nodes) {
    if (!isEl(n)) {
      s += decodeEntities(n.text);
      continue;
    }
    if (DROP_TAGS.has(n.tag)) continue;
    s += BLOCK_TAGS.has(n.tag) ? emitBlock(n) : emitInline([n]);
  }
  return s;
}

/** Depth-first search for <body>, skipping head/script/style subtrees. */
function findBody(nodes: Node[]): El | null {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    if (n.tag === 'body') return n;
    if (DROP_TAGS.has(n.tag)) continue;
    const deep = findBody(n.kids);
    if (deep) return deep;
  }
  return null;
}

export function htmlToMarkdown(html: string): string {
  const top = parseHtml(html);
  // Standalone documents: keep only <body> (head/title/style would otherwise
  // leak into the document as text).
  const body = findBody(top);
  let md = emitNodes(body ? body.kids : top);
  md = md
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md ? md + '\n' : '';
}
