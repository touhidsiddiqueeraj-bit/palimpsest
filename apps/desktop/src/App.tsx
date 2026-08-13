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
import { CodeEditor, type EditorApi } from './CodeEditor';
import { decorateFences, wireFenceButtons } from './fences';
import { htmlToMarkdown } from './convert';
import { open, save } from '@tauri-apps/plugin-dialog';
import { mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { createClient, inlineEdit, DEFAULT_PROVIDERS, isLocalUrl, type Provider } from '@palimpsest/ai';

installNetGuard();

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
  const [docs, setDocs] = useState<string[]>([]);
  const [activeDoc, setActiveDoc] = useState<string>('notes.md');
  const [newDocName, setNewDocName] = useState('');
  const wsRef = useRef<string | null>(null);
  const docNamesRef = useRef(new Map<number, string>());
  const editorApiRef = useRef<EditorApi | null>(null);
  const newDocInputRef = useRef<HTMLInputElement | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('palimpsest.theme') as 'light' | 'dark') || 'light',
  );
  const [viewMode, setViewMode] = useState<'write' | 'split' | 'read'>('split');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [typewriter, setTypewriter] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ doc: string; hits: number }>>([]);
  const searchTimer = useRef<number | null>(null);
  const [links, setLinks] = useState<Array<{ from: string; to: string }>>([]);
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
  const [chat, setChat] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [usage, setUsage] = useState(0);
  const [tab, setTab] = useState<'edit' | 'chat' | 'links'>('edit');
  const [aiCfg, setAiCfg] = useState<{ baseUrl: string; model: string }>(() => {
    try {
      return JSON.parse(localStorage.getItem('palimpsest.ai') ?? '') as {
        baseUrl: string;
        model: string;
      };
    } catch {
      return { baseUrl: DEFAULT_PROVIDERS[0]!.baseUrl, model: DEFAULT_PROVIDERS[0]!.model };
    }
  });
  const [aiKey, setAiKey] = useState('');
  const [showAiCfg, setShowAiCfg] = useState(false);
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
        const workspace = await `${await appDataDir()}/palimpsest-demo`;
        wsRef.current = workspace;
        const fs = snapshotFs(workspace);
        await mkdir(workspace, { recursive: true });
        const db = await sqliteDb(`${workspace}/index.db`);
        const s = createHistoryStore(db, fs);
        await s.init();
        if (cancelled) return;
        setStore(s);
        let t = INITIAL;
        try {
          t = await readTextFile(await `${workspace}/notes.md`);
        } catch {
          await writeTextFile(await `${workspace}/notes.md`, INITIAL);
        }
        const doc = await s.getOrCreateDoc('notes.md', 'notes.md');
        docNamesRef.current.set(doc.id, 'notes.md');
        const list = await s.list(doc.id);
        if (list.length === 0) {
          await s.capture(doc.id, t, 'milestone', 'Chapter one');
          await s.capture(doc.id, t, 'auto', 'seed');
        }
        setDocId(doc.id);
        setText(t);
        lastLen.current = t.length;
        await loadDocs();
      } catch (e) {
        setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadDocs = async () => {
    if (!wsRef.current) return;
    try {
      const entries = await readDir(wsRef.current);
      setDocs(entries.filter((e) => e.name.endsWith('.md')).map((e) => e.name).sort());
    } catch {
      /* workspace not ready */
    }
  };

  const persistLive = (id: number, v: string) => {
    const name = docNamesRef.current.get(id);
    if (!name || !wsRef.current) return;
    writeTextFile(`${wsRef.current}/${name}`, v).catch(() => {});
  };

  const openDoc = async (name: string) => {
    if (!store || !wsRef.current) return;
    let t = INITIAL;
    try {
      t = await readTextFile(`${wsRef.current}/${name}`);
    } catch {
      /* freshly created doc */
    }
    const doc = await store.getOrCreateDoc(name, name);
    docNamesRef.current.set(doc.id, name);
    lastLen.current = t.length;
    setActiveDoc(name);
    setSelected(null);
    setPreview(null);
    setDocId(doc.id);
    setText(t);
    await refreshSnaps(doc.id);
  };

  const createDoc = async () => {
    const raw = newDocName.trim();
    if (!raw || !store || !wsRef.current) return;
    let name = raw.endsWith('.md') ? raw : `${raw}.md`;
    if (name.includes('/')) name = name.split('/').pop() ?? name;
    const exists = await readTextFile(`${wsRef.current}/${name}`).catch(() => null);
    setNewDocName('');
    if (exists !== null) return openDoc(name);
    await writeTextFile(`${wsRef.current}/${name}`, INITIAL);
    await openDoc(name);
    await loadDocs();
  };

  const createMilestone = async () => {
    if (!store || docId === null) return;
    const label = window.prompt('Name this moment', new Date().toLocaleString());
    if (!label) return;
    await store.capture(docId, text, 'milestone', label);
    persistLive(docId, text);
    lastLen.current = text.length;
    await refreshSnaps(docId);
  };

  const onPrintPdf = () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
      activeDoc +
      '</title><style>body{font-family:Georgia,serif;max-width:42rem;margin:2.5rem auto;line-height:1.7;color:#1a1a1a}h1,h2,h3{line-height:1.25}code{font-family:ui-monospace,monospace;font-size:.9em}pre{background:#f4f4f4;padding:1rem;overflow:auto}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3rem .6rem}</style></head><body>' +
      previewHtml +
      '</body></html>';
    try {
      const w = window.open('', '_blank');
      if (!w) throw new Error('popup blocked');
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
    } catch {
      setFenceMsg('Popup blocked — use Export HTML and print from a browser.');
    }
  };

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = () =>
    setTheme((t) => {
      const n = t === 'light' ? 'dark' : 'light';
      localStorage.setItem('palimpsest.theme', n);
      return n;
    });

  const onSearch = (q: string) => {
    setSearchQuery(q);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(async () => {
      const t = q.trim().toLowerCase();
      if (!t || !wsRef.current) {
        setSearchResults([]);
        return;
      }
      const res: Array<{ doc: string; hits: number }> = [];
      for (const d of docs) {
        try {
          const txt = await readTextFile(`${wsRef.current}/${d}`);
          const hits = txt.toLowerCase().split(t).length - 1;
          if (hits > 0) res.push({ doc: d, hits });
        } catch {
          /* skip */
        }
      }
      setSearchResults(res);
    }, 250);
  };

  const loadLinks = async () => {
    if (!wsRef.current) return;
    const found: Array<{ from: string; to: string }> = [];
    for (const d of docs) {
      try {
        const txt = await readTextFile(`${wsRef.current}/${d}`);
        for (const m of txt.matchAll(/\[\[([^\]|#!]+)/g)) found.push({ from: d, to: (m[1] ?? '').trim() });
      } catch {
        /* skip */
      }
    }
    setLinks(found);
  };

  useEffect(() => {
    void loadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  const outline = useMemo(() => {
    const out: Array<{ level: number; text: string; line: number }> = [];
    let line = 0;
    for (const ln of text.split('\n')) {
      line++;
      const m = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) out.push({ level: m[1]?.length ?? 1, text: m[2] ?? '', line });
    }
    return out;
  }, [text]);

  const words = useMemo(() => (text.trim() ? text.trim().split(/\s+/).length : 0), [text]);

  const incomingLinks = useMemo(
    () =>
      links
        .filter((l) => l.to === activeDoc.replace(/\.md$/, '') || l.to === activeDoc)
        .map((l) => l.from),
    [links, activeDoc],
  );

  const paletteItems = useMemo(() => {
    const items: Array<{ label: string; hint?: string; run: () => void }> = [
      ...docs.map((d) => ({ label: 'Open ' + d, run: () => void openDoc(d) })),
      {
        label: 'New document',
        run: () => {
          setViewMode('write');
          newDocInputRef.current?.focus();
        },
      },
      {
        label: viewMode === 'split' ? 'Write only' : viewMode === 'write' ? 'Split view' : 'Write view',
        hint: 'view',
        run: () => setViewMode(viewMode === 'split' ? 'write' : 'split'),
      },
      { label: 'Read mode', hint: 'view', run: () => setViewMode('read') },
      { label: 'Toggle theme', hint: theme, run: toggleTheme },
      { label: 'Close', hint: 'esc', run: () => setPaletteOpen(false) },
      { label: 'Record milestone', run: () => void createMilestone() },
      { label: 'Export HTML', run: () => void onExport() },
      { label: 'Print / PDF', run: onPrintPdf },
      { label: 'Import markdown', run: () => void onImport() },
    ];
    const q = paletteQuery.trim().toLowerCase();
    return q ? items.filter((c) => c.label.toLowerCase().includes(q)) : items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, viewMode, theme, paletteQuery, activeDoc]);

  const toolbar = [
    ['B', () => editorApiRef.current?.wrap('**')],
    ['I', () => editorApiRef.current?.wrap('*')],
    ['S', () => editorApiRef.current?.wrap('~~')],
    ['`', () => editorApiRef.current?.wrap('`')],
    ['Link', () => editorApiRef.current?.wrap('[', '](https://)', (sel) => sel)],
    ['H1', () => editorApiRef.current?.insert('# ')],
    ['H2', () => editorApiRef.current?.insert('## ')],
    ['H3', () => editorApiRef.current?.insert('### ')],
    ['Quote', () => editorApiRef.current?.insert('> ')],
    ['• List', () => editorApiRef.current?.insert('- ')],
    ['1. List', () => editorApiRef.current?.insert('1. ')],
    ['☑ Task', () => editorApiRef.current?.insert('- [ ] ')],
    ['Table', () => editorApiRef.current?.insert('| col | col |\n| --- | --- |\n|  |  |')],
    ['÷ Rule', () => editorApiRef.current?.insert('---')],
    ['Note', () => editorApiRef.current?.insert('> [!note]')],
  ] as const;

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
        persistLive(docId, text);
        lastLen.current = text.length;
        await refreshSnaps(docId);
      }
    }, 5000);
    return () => window.clearInterval(t);
  }, [store, docId, text]);

  const provider: Provider = {
    id: aiCfg.baseUrl,
    kind: isLocalUrl(aiCfg.baseUrl) ? 'ollama' : 'openai',
    baseUrl: aiCfg.baseUrl,
    model: aiCfg.model,
    apiKey: aiKey || undefined,
  };

  const friendlyAiError = (e: unknown) => {
    const s = String(e);
    return /refused|ECONNREFUSED|Failed to fetch|network|NetworkError/i.test(s)
      ? `Can't reach ${aiCfg.baseUrl}. Start a local model server (Ollama / LM Studio), or open AI settings and enter another address${isLocalUrl(aiCfg.baseUrl) || aiKey ? '' : ' and API key'}. (${s})`
      : s.startsWith('Propose failed:')
        ? s
        : s;
  };

  const saveAiCfg = () => {
    localStorage.setItem('palimpsest.ai', JSON.stringify(aiCfg));
    setShowAiCfg(false);
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
      setAiMsg(friendlyAiError(e));
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
      persistLive(docId, proposal.proposed);
      setProposal(null);
      setPrompt('');
      await refreshSnaps(docId);
    } finally {
      setBusy(false);
    }
  };

  const onSend = async () => {
    if (!store || docId === null || !chatInput.trim() || chatBusy) return;
    const q = chatInput.trim();
    setChatInput('');
    setChatBusy(true);
    setChat((c) => [...c, { role: 'user', content: q }]);
    try {
      const client = createClient(provider, { localOnly: localOnlyRef.current });
      const bundle = await store.recall(q, 4096, { scope: [String(docId)] });
      const budgeted = bundle.results
        .map(
          (h) =>
            `[${h.status} · ${h.kind === 'history' ? 'history' : 'doc'}] ${h.text.slice(0, 400)}`,
        )
        .join('\n');
      const sys = [
        'You are an assistant inside Palimpsest, a revision-aware Markdown editor.',
        'Below are recalled memory snippets from the document history',
        '(status: current / modified / deleted). Answer using them when relevant.',
        'Be concise. Never claim to have changed anything.',
      ].join(' ');
      const answer = await client.complete([
        { role: 'system', content: sys },
        { role: 'user', content: `Memory:\n${budgeted}\n\nQuestion: ${q}` },
      ]);
      setChat((c) => [...c, { role: 'assistant', content: answer }]);
      setUsage((u) => u + q.length + answer.length);
    } catch (e) {
      setChat((c) => [...c, { role: 'assistant', content: `Error: ${friendlyAiError(e)}` }]);
    } finally {
      setChatBusy(false);
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
      persistLive(docId ?? -1, v);
    }, 2500);
  };

  const onRestore = async (id: number) => {
    if (!store || docId === null) return;
    setBusy(true);
    try {
      const r = await store.restore(docId, id, text, 'Manual restore');
      setText(r.text);
      persistLive(docId, r.text);
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
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'p') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && e.shiftKey && k === 'm') {
        e.preventDefault();
        void createMilestone();
        return;
      }
      if (mod && k === 's') {
        e.preventDefault();
        if (docId !== null) {
          persistLive(docId, text);
          setSavedAt(Date.now());
        }
        return;
      }
      if (e.altKey && k === 'l') {
        e.preventDefault();
        void onExport();
      }
      if (e.ctrlKey && e.shiftKey && k === 'i') {
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
        <button
          className="border-t border-stone-200 px-4 py-2 text-sm text-stone-600 hover:text-stone-900"
          onClick={() => setErr(null)}
        >
          Continue without history (editor only)
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col" data-theme={theme}>
      <header className="flex items-center gap-4 border-b border-stone-200 px-4 py-2 text-sm">
        <h1 className="font-semibold">Palimpsest</h1>
        <span className="text-stone-500">{activeDoc}</span>
        <span className="text-stone-400">
          · {diffWords.removed} removed, {diffWords.added} added vs v0
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-stone-300 text-xs">
            {(['write', 'split', 'read'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-2 py-0.5 ${viewMode === m ? 'bg-stone-900 text-white' : 'hover:bg-stone-100'}`}
              >
                {m}
              </button>
            ))}
          </div>
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
          <button
            className="text-xs underline"
            onClick={onPrintPdf}
            title="Print or save as PDF"
          >
            Print
          </button>
          <button className="text-xs underline" onClick={toggleTheme} title="Toggle theme">
            {theme === 'light' ? 'Dark' : 'Light'}
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
        <aside className="w-44 shrink-0 overflow-y-auto border-r border-stone-200 p-3 text-sm">
          <h2 className="mb-2 font-semibold">Docs</h2>
          <ul className="space-y-1">
            {docs.map((d) => (
              <li key={d}>
                <button
                  onClick={() => void openDoc(d)}
                  className={
                    activeDoc === d
                      ? 'w-full rounded bg-stone-200 px-2 py-1 text-left'
                      : 'w-full rounded px-2 py-1 text-left hover:bg-stone-100'
                  }
                >
                  {d}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-1">
            <input
              value={newDocName}
              ref={newDocInputRef}
              onChange={(e) => setNewDocName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createDoc();
              }}
              placeholder="new file"
              className="w-full min-w-0 rounded border border-stone-300 px-1.5 py-0.5 text-xs"
            />
            <button
              onClick={() => void createDoc()}
              className="rounded border border-stone-300 px-2 text-xs hover:bg-stone-100"
              title="New document"
            >
              +
            </button>
          </div>
          <div className="mt-3 border-t border-stone-200 pt-2">
            <input
              value={searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="search notes…"
              className="w-full rounded border border-stone-300 px-1.5 py-0.5 text-xs outline-none focus:border-stone-500"
            />
            {searchResults.length > 0 && (
              <ul className="mt-1 space-y-1">
                {searchResults.map((r) => (
                  <li key={r.doc}>
                    <button
                      onClick={() => void openDoc(r.doc)}
                      className="w-full rounded px-1.5 py-0.5 text-left text-xs hover:bg-stone-100"
                    >
                      <span className="truncate">{r.doc}</span>{' '}
                      <span className="text-stone-400">{r.hits}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {outline.length > 0 && (
            <div className="mt-3 border-t border-stone-200 pt-2">
              <h3 className="mb-1 text-xs font-semibold text-stone-500">Outline</h3>
              <ul className="space-y-0.5">
                {outline.map((o, i) => (
                  <li key={i}>
                    <button
                      onClick={() => editorApiRef.current?.scrollToLine(o.line)}
                      className="w-full truncate rounded px-1.5 py-0.5 text-left text-xs hover:bg-stone-100"
                      style={{ paddingLeft: 6 + o.level * 8 }}
                      title={o.text}
                    >
                      {o.text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
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
            <div className="mb-2 flex gap-1">
              {(['edit', 'chat', 'links'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded px-2 py-0.5 text-xs ${tab === t ? 'bg-stone-300' : 'bg-stone-100 hover:bg-stone-200'}`}
                >
                  {t === 'edit' ? 'Edit' : t === 'chat' ? 'Chat' : 'Links'}
                </button>
              ))}
            </div>
            {tab === 'edit' ? (
              <>
                <h2 className="mb-1 font-semibold">
                  Ask AI
                  <button
                    className="ml-2 rounded border border-stone-300 px-1.5 py-0.5 text-[10px] font-normal hover:bg-stone-100"
                    onClick={() => setShowAiCfg((v) => !v)}
                  >
                    {showAiCfg ? 'Done' : 'Settings'}
                  </button>
                </h2>
                {showAiCfg ? (
                  <div className="mb-2 rounded border border-stone-300 p-2 text-xs">
                    <label className="block">
                      <span className="text-stone-500">Server URL</span>
                      <input
                        className="mt-0.5 w-full rounded border border-stone-300 px-2 py-1 outline-none focus:border-stone-500"
                        value={aiCfg.baseUrl}
                        onChange={(e) => setAiCfg((c) => ({ ...c, baseUrl: e.target.value }))}
                        placeholder="http://127.0.0.1:11434 (Ollama) or https://…/v1"
                      />
                    </label>
                    <label className="mt-1 block">
                      <span className="text-stone-500">Model</span>
                      <input
                        className="mt-0.5 w-full rounded border border-stone-300 px-2 py-1 outline-none focus:border-stone-500"
                        value={aiCfg.model}
                        onChange={(e) => setAiCfg((c) => ({ ...c, model: e.target.value }))}
                        placeholder="llama3.2 / gpt-4o-mini / local-model"
                      />
                    </label>
                    <label className="mt-1 block">
                      <span className="text-stone-500">
                        API key {isLocalUrl(aiCfg.baseUrl) ? '(not needed for local servers)' : ''}
                      </span>
                      <input
                        type="password"
                        className="mt-0.5 w-full rounded border border-stone-300 px-2 py-1 outline-none focus:border-stone-500"
                        value={aiKey}
                        onChange={(e) => setAiKey(e.target.value)}
                        placeholder={isLocalUrl(aiCfg.baseUrl) ? 'leave empty' : 'sk-…'}
                      />
                    </label>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        className="rounded bg-stone-900 px-2 py-1 text-white hover:bg-stone-700"
                        onClick={saveAiCfg}
                      >
                        Save
                      </button>
                      <span className="text-[10px] text-stone-400">
                        URL & model stay on this device; the key is kept in memory for this
                        session only and never written to disk.
                      </span>
                    </div>
                  </div>
                ) : (
                  <span className="mb-1 block text-[10px] text-stone-400">
                    {aiCfg.baseUrl} · {aiCfg.model}
                    {aiKey ? ' · key set (memory only)' : ''}
                  </span>
                )}
                <textarea
                  className="w-full resize-none rounded border border-stone-300 p-2 text-xs outline-none focus:border-stone-500"
                  rows={3}
                  placeholder={`Ask AI · ${provider.model} — edit instruction`}
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
              </>
            ) : (
              <>
                <div className="max-h-64 overflow-y-auto rounded border border-stone-200 p-2 text-xs">
                  {chat.length === 0 && (
                    <div className="text-stone-400">
                      Ask about this document — answers get recalled history context.
                    </div>
                  )}
                  {chat.map((m, i) => (
                    <div
                      key={i}
                      className={`mb-1 ${m.role === 'user' ? 'text-stone-800' : 'text-stone-600'}`}
                    >
                      <span className="font-semibold">{m.role === 'user' ? 'You' : 'AI'}:</span>{' '}
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex gap-1">
                  <input
                    className="flex-1 rounded border border-stone-300 px-2 py-1 text-xs outline-none focus:border-stone-500"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void onSend()}
                    placeholder={`Ask AI · ${provider.model}`}
                  />
                  <button
                    className="rounded bg-stone-900 px-2 py-1 text-xs text-white hover:bg-stone-700 disabled:opacity-50"
                    onClick={() => void onSend()}
                    disabled={chatBusy || !chatInput.trim()}
                  >
                    Send
                  </button>
                </div>
                {usage > 0 && (
                  <div className="mt-1 text-[10px] text-stone-400">
                    {usage.toLocaleString()} chars exchanged this session
                  </div>
                )}
              </>
            )}
            {tab === 'links' && (
              <div className="text-xs">
                <h2 className="mb-1 font-semibold">Backlinks</h2>
                {incomingLinks.length === 0 ? (
                  <p className="text-stone-400">
                    Nothing links to this note yet. Use [[wikilinks]] in other notes to connect
                    them here.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {incomingLinks.map((f) => (
                      <li key={f}>
                        <button
                          onClick={() => void openDoc(f)}
                          className="w-full rounded px-2 py-1 text-left hover:bg-stone-100"
                        >
                          {f}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 border-t border-stone-200 pt-2 text-stone-400">
                  {links.length} links across {docs.length} notes
                </div>
              </div>
            )}
          </div>
        </aside>
        <main className="flex min-h-0 flex-1 flex-col">
          {viewMode !== 'read' && (
            <div className="flex flex-wrap items-center gap-1 border-b border-stone-200 px-2 py-1">
              {toolbar.map(([label, run]) => (
                <button
                  key={label}
                  onClick={run}
                  className="rounded border border-stone-300 px-1.5 py-0.5 text-xs hover:bg-stone-100"
                  title={String(label)}
                >
                  {label}
                </button>
              ))}
              <label className="ml-auto flex items-center gap-1 text-xs text-stone-500">
                <input
                  type="checkbox"
                  checked={typewriter}
                  onChange={(e) => setTypewriter(e.target.checked)}
                />
                Typewriter
              </label>
            </div>
          )}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {viewMode !== 'read' && (
              <div className={viewMode === 'split' ? 'w-1/2 min-w-0' : 'flex-1 min-w-0'}>
                <CodeEditor
                  key={`${activeDoc}:${theme}`}
                  value={text}
                  onChange={onEdit}
                  apiRef={editorApiRef}
                  typewriter={typewriter}
                />
              </div>
            )}
            {viewMode !== 'write' && (
              <div
                ref={previewRef}
                className={
                  viewMode === 'split'
                    ? 'w-1/2 overflow-y-auto border-l border-stone-200 p-4 text-sm'
                    : 'flex-1 overflow-y-auto p-4 text-sm'
                }
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
            )}
          </div>
          <footer className="flex items-center gap-3 border-t border-stone-200 px-3 py-1 text-xs text-stone-400">
            <span>
              {words} words · {text.length} chars · {Math.max(1, Math.round(words / 200))} min read
            </span>
            <span className="ml-auto">{activeDoc}</span>
            <span title={`${snaps.length} snapshots recorded`}>{snaps.length} snapshots</span>
            <span title="Ctrl+S to save now">
              {savedAt ? `saved ${new Date(savedAt).toLocaleTimeString()}` : 'unsaved'}
            </span>
          </footer>
        </main>
      </div>
      {paletteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
          onClick={() => setPaletteOpen(false)}
        >
          <div
            className="w-96 rounded-lg border border-stone-300 bg-white shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const first = paletteItems[0];
                  if (first) {
                    setPaletteOpen(false);
                    first.run();
                  }
                } else if (e.key === 'Escape') {
                  setPaletteOpen(false);
                }
              }}
              placeholder="Commands or files…  (Ctrl+P)"
              className="w-full rounded-t-lg border-b border-stone-200 px-3 py-2 text-sm outline-none"
            />
            <ul className="max-h-72 overflow-y-auto p-1 text-sm">
              {paletteItems.map((c, i) => (
                <li key={i}>
                  <button
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-stone-100"
                    onClick={() => {
                      setPaletteOpen(false);
                      c.run();
                    }}
                  >
                    <span className="truncate">{c.label}</span>
                    {c.hint && <span className="ml-3 shrink-0 text-xs text-stone-400">{c.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
