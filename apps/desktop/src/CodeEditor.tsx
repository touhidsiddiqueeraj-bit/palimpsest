import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';

function wrap(
  view: EditorView,
  before: string,
  after = before,
  url?: (sel: string) => string,
): boolean {
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
  { key: 'Mod-k', run: (v) => wrap(v, '[', '](https://)', (sel) => sel) },
  { key: 'Mod-shift-k', run: (v) => wrap(v, '**', '**', (sel) => sel) },
]);

export function CodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        markdown(),
        shortcuts,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="h-full overflow-auto" />;
}
