import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';

export interface EditorApi {
  wrap(before: string, after?: string, url?: (sel: string) => string): void;
  insert(text: string): void;
  scrollToLine(line: number): void;
  focus(): void;
}

const mdStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--cm-h1)', fontWeight: '700' },
  { tag: tags.heading2, color: 'var(--cm-h2)', fontWeight: '700' },
  { tag: tags.heading3, color: 'var(--cm-h3)', fontWeight: '700' },
  { tag: tags.heading4, color: 'var(--cm-h4)', fontWeight: '700' },
  { tag: tags.heading5, color: 'var(--cm-h5)', fontWeight: '700' },
  { tag: tags.heading6, color: 'var(--cm-h6)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--cm-strong)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--cm-em)', fontStyle: 'italic' },
  { tag: tags.strikethrough, color: 'var(--cm-strike)' },
  { tag: tags.monospace, color: 'var(--cm-code)' },
  { tag: tags.link, color: 'var(--cm-link)' },
  { tag: tags.url, color: 'var(--cm-url)', textDecoration: 'underline' },
  { tag: tags.quote, color: 'var(--cm-quote)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--cm-list)' },
  { tag: tags.meta, color: 'var(--cm-meta)' },
  { tag: tags.contentSeparator, color: 'var(--cm-hr)' },
  { tag: tags.comment, color: 'var(--cm-comment)' },
]);

function wrap(view: EditorView, before: string, after = before, url?: (sel: string) => string): boolean {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to) || 'text';
  view.dispatch({
    changes: { from, to, insert: `${before}${url ? url(sel) : sel}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + sel.length },
  });
  view.focus();
  return true;
}

const shortcuts = keymap.of([
  { key: 'Mod-b', run: (v) => wrap(v, '**') },
  { key: 'Mod-i', run: (v) => wrap(v, '*') },
  { key: 'Mod-shift-k', run: (v) => wrap(v, '**') },
  { key: 'Mod-k', run: (v) => wrap(v, '[', '](https://)', (sel) => sel) },
]);

const SLASH: Array<{ label: string; insert: string }> = [
  { label: 'Heading 1', insert: '# ' },
  { label: 'Heading 2', insert: '## ' },
  { label: 'Heading 3', insert: '### ' },
  { label: 'Heading 4', insert: '#### ' },
  { label: 'Bold', insert: '**text**' },
  { label: 'Italic', insert: '*text*' },
  { label: 'Strikethrough', insert: '~~text~~' },
  { label: 'Inline code', insert: '`text`' },
  { label: 'Code block', insert: '```\n\n```' },
  { label: 'Quote', insert: '> ' },
  { label: 'Bullet list', insert: '- ' },
  { label: 'Numbered list', insert: '1. ' },
  { label: 'Task list', insert: '- [ ] ' },
  { label: 'Table', insert: '| col | col |\n| --- | --- |\n|  |  |' },
  { label: 'Link', insert: '[text](https://)' },
  { label: 'Image', insert: '![alt](image.png)' },
  { label: 'Callout', insert: '> [!note]' },
  { label: 'Horizontal rule', insert: '---' },
  { label: 'Footnote', insert: '[^1]' },
  { label: 'Math', insert: '$$\\text{}$$' },
];

function slashSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\/[\w]*/);
  if (!word || word.from === word.to) return null;
  const before = context.state.sliceDoc(Math.max(0, word.from - 1), word.from);
  if (before && !/\s/.test(before)) return null;
  return {
    from: word.from,
    filter: false,
    validFor: /^\/[\w]*$/,
    options: SLASH.map((s) => ({
      label: s.label,
      detail: s.insert.replace('\n', ' ↵ '),
      apply: s.insert,
    })),
  };
}

const typewriterCenter = EditorView.updateListener.of((u) => {
  const sel = u.state.selection.main;
  if (u.selectionSet && sel.anchor !== u.startState.selection.main.anchor) {
    u.view.dispatch({
      effects: EditorView.scrollIntoView(sel.head, { y: 'center' }),
    });
  }
});

export function CodeEditor({
  value,
  onChange,
  apiRef,
  typewriter,
}: {
  value: string;
  onChange: (v: string) => void;
  apiRef: React.MutableRefObject<EditorApi | null>;
  typewriter: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        closeBrackets(),
        bracketMatching(),
        highlightSelectionMatches(),
        autocompletion({ override: [slashSource] }),
        search({ top: true }),
        markdown(),
        syntaxHighlighting(mdStyle),
        shortcuts,
        typewriter ? typewriterCenter : [],
        keymap.of([
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'var(--cm-font)', lineHeight: '1.6' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    apiRef.current = {
      wrap: (before, after, url) => wrap(view, before, after, url),
      insert: (text) => {
        const { from, to } = view.state.selection.main;
        const at = view.state.sliceDoc(Math.max(0, from - 1), from);
        const prefix =
          text.startsWith('#') || text.startsWith('>') || text.startsWith('-') || text.startsWith('1.')
            ? at === '\n' || at === ''
              ? ''
              : '\n'
            : '';
        view.dispatch({
          changes: { from, to, insert: `${prefix}${text}` },
          selection: { anchor: from + prefix.length + text.length },
        });
        view.focus();
      },
      scrollToLine: (line) => {
        const pos = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
        view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos) });
        view.focus();
      },
      focus: () => view.focus(),
    };
    const t = window.setTimeout(() => view.focus(), 50);
    return () => {
      window.clearTimeout(t);
      view.destroy();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="h-full w-full overflow-hidden" />;
}