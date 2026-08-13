import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/index.js';

const render = (src: string, options?: Parameters<typeof renderMarkdown>[1]) =>
  renderMarkdown(src, options).html;

describe('markdown: blocks', () => {
  it('headings with levels and trailing hashes', () => {
    expect(render('# One')).toContain('<h1>One</h1>');
    expect(render('## Two ##')).toContain('<h2>Two</h2>');
    expect(render('###### Six')).toContain('<h6>Six</h6>');
  });

  it('paragraphs and hard breaks', () => {
    expect(render('a\nb\n\nc')).toBe('<p>a<br>b</p>\n<p>c</p>');
  });

  it('horizontal rules', () => {
    for (const hr of ['---', '***', '___']) {
      expect(render(hr)).toContain('<hr>');
    }
  });

  it('fenced code with language tag', () => {
    expect(render('```ts\nconst x = 1;\n```')).toBe(
      '<pre data-lang="ts"><code>const x = 1;</code></pre>',
    );
  });

  it('blockquotes, nested', () => {
    const html = render('> outer\n> > inner');
    expect(html).toContain('<blockquote>');
    expect(html).toMatch(/<blockquote>.*<blockquote>.*inner.*<\/blockquote>.*<\/blockquote>/s);
  });

  it('callouts for known kinds, plain quote otherwise', () => {
    expect(render('> [!note]\n> Save your work.')).toContain('<div class="callout callout-note">');
    expect(render('> [!WARNING]\n> Careful.')).toContain('class="callout callout-warning"');
    expect(render('> [!bogus]\n> Still a quote.')).toContain('<blockquote>');
  });

  it('math blocks pass through untouched', () => {
    const html = render('$$\nE = mc^2\n$$');
    expect(html).toContain('<div class="math">E = mc^2</div>');
  });

  it('tables with alignment', () => {
    const html = render('| a | b |\n| :-- | --: |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<th style="text-align:right">b</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  it('ordered and unordered lists, nested, task items', () => {
    const html = render('- [x] done\n- [ ] todo\n  1. nested');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li class="task"><input type="checkbox" disabled checked> done</li>');
    expect(html).toContain('<ol>');
    expect(html).toContain('nested');
  });
});

describe('markdown: inline', () => {
  it('strong, em, del, mark, code', () => {
    expect(render('**b** __b2__ *i* ~~s~~ ==m== `c`')).toContain(
      '<strong>b</strong> <strong>b2</strong> <em>i</em> <del>s</del> <mark>m</mark> <code>c</code>',
    );
  });

  it('links and images', () => {
    expect(render('[t](https://example.com)')).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener">t</a>',
    );
    expect(render('![alt](https://example.com/i.png)')).toContain(
      '<img src="https://example.com/i.png" alt="alt" loading="lazy">',
    );
  });

  it('blocks javascript: and data: links, allows mailto and internal', () => {
    expect(render('[x](javascript:alert(1))')).not.toContain('<a');
    expect(render('[x](data:text/html,boom)')).not.toContain('<a');
    expect(render('[m](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
    expect(render('[r](../other.md)')).toContain('href="../other.md"');
    expect(render('[a](#anchor)')).toContain('href="#anchor"');
  });

  it('raw HTML is escaped, never injected', () => {
    const html = render('<script>alert(1)</script>\n\n<div onclick="x">hi</div>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<div onclick');
    expect(html).toContain('&lt;script&gt;');
  });

  it('wikilinks resolve via resolver and render unresolved otherwise', () => {
    const plain = render('see [[chapter-2]]');
    expect(plain).toContain('<span class="wikilink-unresolved">[[chapter-2]]</span>');
    const resolved = render('see [[chapter-2]] and [[chapter-2|Two]]', {
      wikilinkResolver: (t) => (t === 'chapter-2' ? '/docs/chapter-2.md' : null),
    });
    expect(resolved).toContain('<a href="/docs/chapter-2.md" class="wikilink">chapter-2</a>');
    expect(resolved).toContain('<a href="/docs/chapter-2.md" class="wikilink">Two</a>');
  });

  it('footnotes: refs numbered, defs rendered at bottom with backlinks', () => {
    const html = render('Text[^a] more[^b].\n\n[^a]: first note\n[^b]: second note');
    expect(html).toContain('<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>');
    expect(html).toContain('id="fnref-2"');
    expect(html).toContain('<section class="footnotes">');
    expect(html).toContain('<li id="fn-1">first note');
    expect(html).toContain('<li id="fn-2">second note');
    expect(html).toContain('class="footnote-back"');
  });
});

describe('markdown: AST', () => {
  it('produces a block-level outline', () => {
    const doc = `# Title

Intro paragraph.

## Section one

> [!tip]
> A tip here.

- item one
- item two

| h | h2 |
| - | - |
| a | b |

\`\`\`py
print(1)
\`\`\`

$$\nx^2
$$`;
    const { ast } = renderMarkdown(doc);
    const kinds = ast.map((b) => b.type);
    expect(kinds).toEqual([
      'heading',
      'paragraph',
      'heading',
      'callout',
      'list',
      'table',
      'code',
      'math',
    ]);
    expect(ast[0]).toEqual({ type: 'heading', level: 1, text: 'Title' });
  });
});
