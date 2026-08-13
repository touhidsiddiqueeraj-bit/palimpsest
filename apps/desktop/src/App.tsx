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
import { CodeEditor } from './CodeEditor';
import { decorateFences, wireFenceButtons } from './fences';
import { htmlToMarkdown } from './convert';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { createClient, inlineEdit, DEFAULT_PROVIDERS, type Provider } from '@palimpsest/ai';

installNetGuard();

const WORKSPACE = '.palimpsest-demo';
const INITIAL = '# Chapter one\n\nThe quick brown fox jumps over the lazy dog.\n';
const INITIAL_TS = Date.now() - 1000 * 60 * 60 * 24;

export default function App() {
  const [store, setStore] = useState<HistoryStore | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([]);
  const [kindFilter, setKindFilter] = useState<'all' | SnapshotInfo['kind']>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fenceMsg, setFenceMsg] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{
    proposed: string;
    added: number;
    removed: number;
    instruction: string;
    model: string;
  } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const snapshotTimer = useRef<number | null>(null);
  const lastLen = useRef(INITIAL.length);

  const net = useNetActivity();
  const localOnly = useLocalOnly();
  const localOnlyRef = useRef(localOnly);
  localOnlyRef.current = localOnly;

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

  const provider: Provider = {
    id: 'ollama-default',
    kind: DEFAULT_PROVIDERS[0]!.kind,
    baseUrl: DEFAULT_PROVIDERS[0]!.baseUrl,
    model: DEFAULT_PROVIDERS[0]!.model,
  };

  const onPropose = async () => {
    if (!docId || !prompt.trim() || aiBusy) return;
    setAiBusy(true);
    setAiMsg(null);
    try {
      const client = createClient(provider, { localOnly: localOnlyRef.current });
      const { proposed, diff } = await inlineEdit({
        client,
        instruction: prompt.trim(),
        document: text,
      });
      setProposal({
        proposed,
        added: diff.added,
        removed: diff.removed,
        instruction: prompt.trim(),
        model: provider.model,
      });
    } catch (e) {
      setAiMsg(`Propose failed: ${String(e)}`);
    } finally {
      setAiBusy(false);
    }
  };

  const onAccept = async () => {
    if (!store || docId === null || !proposal) return;
    setBusy(true);
    try {
      await store.capture(docId, proposal.proposed, 'ai', proposal.instruction, {
        model: proposal.model,
        instruction: proposal.instruction,
      });
      setText(proposal.proposed);
      setProposal(null);
      setPrompt('');
      await refreshSnaps(docId);
    } finally {
      setBusy(false);
    }
  };

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

  const previewHtml = useMemo(() => {
    const raw = renderMarkdown(preview ?? text).html;
    return decorateFences(raw);
  }, [preview, text]);

  useEffect(() => {
    if (!previewRef.current) return;
    return wireFenceButtons(previewRef.current, (ok, msg) => {
      setFenceMsg(ok ? `Rendered ${msg} diagram` : `Render failed: ${msg}`);
    });
  }, [previewHtml]);

  const filtered = useMemo(
    () => (kindFilter === 'all' ? snaps : snaps.filter((s) => s.kind === kindFilter)),
    [snaps, kindFilter],
  );

  const onRename = async (s: SnapshotInfo) => {
    if (!store || docId === null) return;
    const label = window.prompt('Milestone name', s.label || '');
    if (label === null || label === s.label) return;
    await store.renameSnapshot(docId, s.id, label.trim() || s.label);
    await refreshSnaps(docId);
  };

  const onExport = async () => {
    const html = renderMarkdown(text).html;
    const path = await save({
      defaultPath: 'notes.html',
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (!path) return;
    await writeTextFile(path, html);
  };

  const onImport = async () => {
    const path = await open({ filters: [{ name: 'Markdown / HTML', extensions: ['md', 'html'] }] });
    if (!path) return;
    const raw = await readTextFile(path);
    const isHtml = /\.html?$/i.test(path);
    setText(isHtml ? htmlToMarkdown(raw) : raw);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const alt = e.altKey;
      const exportKey = /Mac/.test(navigator.platform) ? 'l' : 'l';
      if (alt && e.key.toLowerCase() === exportKey) {
        e.preventDefault();
        void onExport();
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        void onImport();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const diffWords = useMemo(() => diffProse(INITIAL, text), [text]);

  if (err) {
    return (
      <div className="flex h-screen flex-col">
        <header className="border-b border-stone-200 px-4 py-2 text-sm">
          <h1 className="font-semibold">Palimpsest</h1>
        </header>
        <main className="flex flex-1 items-center justify-center text-sm text-red-700">
          Backend unavailable (run inside Tauri): {err}
        </main>
      </div>
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
          <button
            className="text-xs underline"
            onClick={() => void onImport()}
            title="Ctrl+Shift+I"
          >
            Import
          </button>
          <button className="text-xs underline" onClick={() => void onExport()} title="Alt+L">
            Export HTML
          </button>
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
            max={Math.max(0, filtered.length - 1)}
            value={
              selected === null
                ? 0
                : Math.max(
                    0,
                    filtered.findIndex((s) => s.id === selected),
                  )
            }
            onChange={(e) => {
              const s = filtered[Number(e.target.value)];
              if (s) void openPreview(s.id);
            }}
            className="w-full"
          />
          <div className="mt-2 flex flex-wrap gap-1">
            {(['all', 'auto', 'milestone', 'system', 'ai'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={`rounded px-2 py-0.5 text-xs ${
                  kindFilter === k ? 'bg-stone-300' : 'bg-stone-100 hover:bg-stone-200'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          <ul className="mt-2 space-y-1">
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => void openPreview(s.id)}
                  onDoubleClick={() => s.kind === 'milestone' && void onRename(s)}
                  title={s.kind === 'milestone' ? 'Double-click to rename' : undefined}
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
          <div className="mt-4 border-t border-stone-200 pt-3">
            <h2 className="mb-1 font-semibold">Ask AI</h2>
            <textarea
              className="w-full resize-none rounded border border-stone-300 p-2 text-xs outline-none focus:border-stone-500"
              rows={3}
              placeholder={`Ollama · ${provider.model} — edit instruction`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="mt-1 flex gap-2">
              <button
                className="rounded bg-stone-900 px-2 py-1 text-xs text-white hover:bg-stone-700 disabled:opacity-50"
                onClick={() => void onPropose()}
                disabled={aiBusy || !prompt.trim()}
              >
                {aiBusy ? 'Proposing…' : localOnly ? 'Propose (local)' : 'Propose'}
              </button>
              {proposal && (
                <>
                  <button
                    className="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600"
                    onClick={() => void onAccept()}
                    disabled={busy}
                  >
                    Accept +{proposal.added} −{proposal.removed}
                  </button>
                  <button
                    className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100"
                    onClick={() => setProposal(null)}
                  >
                    Reject
                  </button>
                </>
              )}
            </div>
            {aiMsg && <div className="mt-1 text-xs text-red-600">{aiMsg}</div>}
          </div>
        </aside>
        <main className="flex flex-1 flex-col">
          <div className="flex flex-1 overflow-hidden">
            <CodeEditor value={text} onChange={onEdit} />
            <div
              ref={previewRef}
              className="w-1/2 overflow-y-auto border-l border-stone-200 p-4 text-sm"
            >
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
              {fenceMsg && <div className="mt-2 text-xs text-stone-500">{fenceMsg}</div>}
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
