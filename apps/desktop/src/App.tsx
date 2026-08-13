import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createHistoryStore,
  diffProse,
  renderMarkdown,
  snapshotDue,
  type HistoryStore,
  type SnapshotInfo,
} from '@palimpsest/core';
import { snapshotFs, sqliteDb } from './tauri';
import { installNetGuard, useLocalOnly, useNetActivity, setLocalOnly } from './netguard';

installNetGuard();

const WORKSPACE = '.palimpsest-demo';
const INITIAL = '# Chapter one\n\nThe quick brown fox jumps over the lazy dog.\n';
const INITIAL_TS = Date.now() - 1000 * 60 * 60 * 24;

export default function App() {
  const [store, setStore] = useState<HistoryStore | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const snapshotTimer = useRef<number | null>(null);
  const lastLen = useRef(INITIAL.length);

  const net = useNetActivity();
  const localOnly = useLocalOnly();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fs = snapshotFs(WORKSPACE);
        const db = await sqliteDb(`${WORKSPACE}/index.db`);
        const s = createHistoryStore(db, fs);
        await s.init();
        if (cancelled) return;
        setStore(s);
        const doc = await s.getOrCreateDoc('notes.md', 'notes.md');
        const list = await s.list(doc.id);
        if (list.length === 0) {
          await s.capture(doc.id, INITIAL, 'milestone', 'Chapter one');
          await s.capture(doc.id, INITIAL, 'auto', 'seed');
        }
        setDocId(doc.id);
        setText(INITIAL);
      } catch (e) {
        setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSnaps = async (id: number) => {
    if (!store) return;
    const list = await store.list(id);
    setSnaps(list);
    setSelected((cur) => (cur === null ? (list[0]?.id ?? null) : cur));
  };

  useEffect(() => {
    if (docId !== null) void refreshSnaps(docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, store]);

  useEffect(() => {
    if (!store || docId === null) return;
    const t = window.setInterval(async () => {
      const churn = Math.abs(text.length - lastLen.current);
      if (snapshotDue(Date.now(), INITIAL_TS, churn)) {
        await store.capture(docId, text, 'auto', 'auto');
        lastLen.current = text.length;
        await refreshSnaps(docId);
      }
    }, 5000);
    return () => window.clearInterval(t);
  }, [store, docId, text]);

  const onEdit = (v: string) => {
    setText(v);
    if (snapshotTimer.current) window.clearTimeout(snapshotTimer.current);
    snapshotTimer.current = window.setTimeout(async () => {
      const churn = Math.abs(v.length - lastLen.current);
      if (store && docId !== null && snapshotDue(Date.now(), INITIAL_TS, churn)) {
        await store.capture(docId, v, 'auto', 'auto');
        lastLen.current = v.length;
        await refreshSnaps(docId);
      }
    }, 2500);
  };

  const onRestore = async (id: number) => {
    if (!store || docId === null) return;
    setBusy(true);
    try {
      const r = await store.restore(docId, id, text, 'Manual restore');
      setText(r.text);
      setPreview(null);
      await refreshSnaps(docId);
    } finally {
      setBusy(false);
    }
  };

  const openPreview = async (id: number) => {
    if (!store || docId === null) return;
    const r = await store.get(docId, id);
    setPreview(r.text);
    setSelected(id);
  };

  const diffWords = useMemo(() => diffProse(INITIAL, text), [text]);

  if (err) {
    return (
      <main className="flex h-screen items-center justify-center text-sm text-red-700">{err}</main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-stone-200 px-4 py-2 text-sm">
        <h1 className="font-semibold">Palimpsest</h1>
        <span className="text-stone-500">notes.md</span>
        <span className="text-stone-400">
          · {diffWords.removed} removed, {diffWords.added} added vs v0
        </span>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={localOnly}
              onChange={(e) => setLocalOnly(e.target.checked)}
            />
            Local-only
          </label>
          <span
            className="rounded px-2 py-0.5 text-xs"
            title={net.dest ? `Request to ${net.dest}` : 'No network activity'}
            style={{
              background: net.active ? '#fef3c7' : '#f5f5f4',
              color: net.active ? '#b45309' : '#a8a29e',
            }}
          >
            {net.active ? `→ ${net.dest}` : 'offline'}
          </span>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-80 overflow-y-auto border-r border-stone-200 p-3 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">History</h2>
            <span className="text-xs text-stone-400">{snaps.length}</span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, snaps.length - 1)}
            value={
              selected === null
                ? 0
                : Math.max(
                    0,
                    snaps.findIndex((s) => s.id === selected),
                  )
            }
            onChange={(e) => {
              const s = snaps[Number(e.target.value)];
              if (s) void openPreview(s.id);
            }}
            className="w-full"
          />
          <ul className="mt-2 space-y-1">
            {snaps.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => void openPreview(s.id)}
                  className={`w-full rounded px-2 py-1 text-left hover:bg-stone-100 ${
                    selected === s.id ? 'bg-stone-200' : ''
                  }`}
                >
                  <span className="block truncate">
                    {s.label || s.kind}
                    {s.status === 'deleted'
                      ? ' (gone)'
                      : s.status === 'modified'
                        ? ' (changed)'
                        : ''}
                  </span>
                  <span className="block text-xs text-stone-400">
                    {new Date(s.ts).toLocaleString()} · {s.words} words · {s.kind}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="flex flex-1 flex-col">
          <div className="flex flex-1 overflow-hidden">
            <textarea
              className="w-1/2 resize-none p-4 font-mono text-sm outline-none"
              value={text}
              onChange={(e) => onEdit(e.target.value)}
            />
            <div className="w-1/2 overflow-y-auto border-l border-stone-200 p-4 text-sm">
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(preview ?? text).html }} />
              {preview !== null && (
                <div className="mt-4 border-t border-stone-200 pt-2 text-xs text-stone-400">
                  Previewing snapshot —{' '}
                  <button
                    className="underline"
                    onClick={() => selected !== null && void onRestore(selected)}
                    disabled={busy}
                  >
                    restore this version
                  </button>
                  <button className="ml-3 underline" onClick={() => setPreview(null)}>
                    back to current
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
