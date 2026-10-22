import { renderMarkdown } from '@palimpsest/core';
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './convert';

/** Mirrors onExport in App.tsx: standalone document with head/title/style. */
const wrapLikeExporter = (title: string, body: string): string =>
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<title>${title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</title>` +
  '<style>body{font-family:Georgia,serif;max-width:42rem;margin:2.5rem auto;line-height:1.7;color:#1a1a1a;padding:0 1rem}h1,h2,h3{line-height:1.25}code{font-family:ui-monospace,monospace;font-size:.9em}pre{background:#f4f4f4;padding:1rem;overflow:auto}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3rem .6rem}img{max-width:100%}</style>' +
  `</head><body>${body}</body></html>`;

const roundTrip = (md: string): string =>
  htmlToMarkdown(wrapLikeExporter('document', renderMarkdown(md).html));

describe('htmlToMarkdown round-trip (export -> import)', () => {
  it('never leaks head/style/title content into the document', () => {
    const md = '# Title\n\nA paragraph.';
    const out = roundTrip(md);
    expect(out).not.toContain('Georgia');
    expect(out).not.toContain('{');
    expect(out).not.toContain('style');
    expect(out).not.toContain('doctype');
    expect(out).toBe('# Title\n\nA paragraph.\n');
  });

  it('round-trips headings and paragraphs through the AST', () => {
    const md = '# H1\n\n## H2 with **bold** and *em*\n\nPlain text here.';
    expect(renderMarkdown(roundTrip(md)).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips fenced code blocks with language and entities', () => {
    const md = '```rust\nfn main() {\n    println!("a & b < c");\n}\n```';
    const rt = roundTrip(md);
    expect(rt).toContain('```rust');
    expect(renderMarkdown(rt).ast).toEqual(renderMarkdown(md).ast);
  });

  it('uses a longer fence when the code itself contains ```', () => {
    const md = '````markdown\n```js\nnested\n```\n````';
    expect(renderMarkdown(roundTrip(md)).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips nested lists without gluing items', () => {
    const md = '- one\n  - one-a\n  - one-b\n- two';
    const rt = roundTrip(md);
    expect(rt).toContain('- one\n  - one-a');
    expect(rt).toContain('  - one-b');
    expect(rt).toContain('- two');
    expect(rt).not.toContain('oneone');
    expect(renderMarkdown(rt).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips ordered lists with numbering', () => {
    const md = '1. first\n2. second\n   1. nested\n3. third';
    const rt = roundTrip(md);
    expect(rt).toContain('1. first');
    expect(rt).toContain('2. second');
    expect(rt).toContain('  1. nested');
    expect(rt).toContain('3. third');
    expect(renderMarkdown(rt).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips task checkboxes', () => {
    const md = '- [x] done\n- [ ] todo';
    const rt = roundTrip(md);
    expect(rt).toContain('- [x] done');
    expect(rt).toContain('- [ ] todo');
    expect(renderMarkdown(rt).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips tables with alignment', () => {
    const md = '| left | mid | right |\n| --- | :---: | ---: |\n| 1 | 2 | 3 |';
    const rt = roundTrip(md);
    expect(renderMarkdown(rt).ast).toEqual(renderMarkdown(md).ast);
    expect(rt).toContain('| :---: |');
    expect(rt).toContain('| ---: |');
  });

  it('treats literal pipes in foreign cells as column separators', () => {
    // The dialect has no \| escape (splitTableRow is a naive split), so a
    // bare pipe inside a cell splits exactly like it would in markdown source.
    const out = htmlToMarkdown(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
        '<tbody><tr><td>x | y</td><td>z</td></tr></tbody></table>',
    );
    expect(out).toContain('x | y');
    expect(renderMarkdown(out).ast).toEqual([
      { type: 'table', headers: ['a', 'b'], rows: [['x', 'y', 'z']] },
    ]);
  });

  it('round-trips callouts including their kind', () => {
    const md = '> [!note] Title\n> callout body';
    const rt = roundTrip(md);
    expect(rt).toContain('[!note]');
    expect(renderMarkdown(rt).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips plain blockquotes', () => {
    const md = '> quoted line\n> another line';
    expect(renderMarkdown(roundTrip(md)).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips footnotes (refs and definitions)', () => {
    const md = 'Claim[^1] and claim[^2].\n\n[^1]: first note\n[^2]: second note';
    const rt = roundTrip(md);
    expect(rt).toContain('[^1]: first note');
    expect(rt).toContain('[^2]: second note');
    expect(renderMarkdown(rt).ast).toEqual(renderMarkdown(md).ast);
  });

  it('round-trips inline marks, code, links and images', () => {
    const md =
      '**bold**, *em*, ~~del~~, ==mark==, `code`, [link](https://example.com), ![img](https://example.com/i.png)';
    expect(renderMarkdown(roundTrip(md)).ast).toEqual(renderMarkdown(md).ast);
  });

  it('decodes entities in text and code', () => {
    const md = 'Fish & chips <b>not tags</b> "quoted" and \'apostrophe\'';
    const rt = roundTrip(md);
    expect(rt).toContain('Fish & chips');
    expect(rt).toContain('"quoted"');
    expect(rt).toContain("'apostrophe'");
  });

  it('keeps unresolved wikilinks as wikilink syntax', () => {
    const md = 'See [[some-doc]] here.';
    const rt = roundTrip(md);
    expect(rt).toContain('[[some-doc]]');
  });

  it('round-trips horizontal rules and multi-line paragraphs', () => {
    const md = 'first\n\n---\n\nline one\nline two';
    expect(renderMarkdown(roundTrip(md)).ast).toEqual(renderMarkdown(md).ast);
  });
});

describe('htmlToMarkdown on raw fragments', () => {
  it('handles body-less fragments', () => {
    expect(htmlToMarkdown('<p>hi</p>')).toBe('hi\n');
  });

  it('handles empty documents', () => {
    expect(htmlToMarkdown('<html><head><style>x{}</style></head><body></body></html>')).toBe('');
  });

  it('tolerates malformed html without throwing', () => {
    expect(htmlToMarkdown('<p>unclosed <b>bold</p>')).toContain('bold');
    expect(htmlToMarkdown('a < b and <p>c</p>')).toContain('a < b');
  });

  it('skips script and style elements in fragments', () => {
    const out = htmlToMarkdown('<style>.x{color:red}</style><p>keep</p><script>bad()</script>');
    expect(out).toBe('keep\n');
  });

  it('handles self-closing and uppercase tags', () => {
    const out = htmlToMarkdown('<P>Text</P><BR/><UL><LI>item</LI></UL>');
    expect(out).toContain('Text');
    expect(out).toContain('- item');
  });
});
