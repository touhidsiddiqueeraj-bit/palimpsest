import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  StickyNote,
  Strikethrough,
  Table2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  createHistoryStore,
  diffProse,
  listMarkdownDocs,
  renderMarkdown,
  snapshotDue,
  type DirEntry,
  type HistoryStore,
  type SearchHit,
  type SnapshotInfo,
} from '@palimpsest/core';
import { snapshotFs, sqliteDb } from './tauri';
import { installNetGuard, useLocalOnly, useNetActivity, setLocalOnly } from './netguard';
import { CodeEditor, type EditorApi } from './CodeEditor';
import { decorateFences, wireFenceButtons } from './fences';
import { htmlToMarkdown } from './convert';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { appDataDir, basename, dirname } from '@tauri-apps/api/path';
import {
  createClient,
  inlineEdit,
  DEFAULT_PROVIDERS,
  isLocalUrl,
  type Provider,
} from '@palimpsest/ai';

installNetGuard();

const INITIAL = '# Chapter one\n\nThe quick brown fox jumps over the lazy dog.\n';
const INITIAL_TS = Date.now() - 1000 * 60 * 60 * 24;

/** tauri plugin-fs readDir behind core's DirEntry shape. */
async function workspaceEntries(dir: string): Promise<DirEntry[]> {
  try {
    const entries = await readDir(dir);
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory }));
  } catch {
    return [];
  }
}

export default function App() {
  const [store, setStore] = useState<HistoryStore | null>(null);
  const storeRef = useRef<HistoryStore | null>(null);
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('palimpsest.theme') as 'light' | 'dark') || 'light',
  );
  const [viewMode, setViewMode] = useState<'write' | 'split' | 'read'>('split');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [typewriter, setTypewriter] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const searchTimer = useRef<number | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [fileResults, setFileResults] = useState<SearchHit[]>([]);
  const fileSearchTimer = useRef<number | null>(null);
  const fileSearchRef = useRef<HTMLInputElement | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    const def = { docs: false, hist: true };
    try {
      const stored = JSON.parse(localStorage.getItem('palimpsest.panels') ?? '{}') as {
        docs?: boolean;
      };
      return { ...def, docs: stored.docs ?? false };
    } catch {
      return def;
    }
  });
  const [diffA, setDiffA] = useState<number | null>(null);
  const [diffB, setDiffB] = useState<number | 'current'>('current');
  const [diff, setDiff] = useState<{
    fromLabel: string;
    toLabel: string;
    added: number;
    removed: number;
    html: string;
  } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [splitPct, setSplitPct] = useState(() => {
    const n = Number(localStorage.getItem('palimpsest.split'));
    return Number.isFinite(n) && n > 20 && n < 80 ? n : 50;
  });
  const panesRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startPct: number;
  } | null>(null);
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
    // Guard against partially-written or legacy stored config: a valid-JSON
    // object missing baseUrl/model used to leave the AI panel with undefined
    // fields and an unusable provider.
    const fallback = {
      baseUrl: DEFAULT_PROVIDERS[0]!.baseUrl,
      model: DEFAULT_PROVIDERS[0]!.model,
    };
    try {
      const parsed = JSON.parse(localStorage.getItem('palimpsest.ai') ?? '') as {
        baseUrl?: string;
        model?: string;
      };
      if (typeof parsed?.baseUrl === 'string' && typeof parsed?.model === 'string') {
        return { baseUrl: parsed.baseUrl, model: parsed.model };
      }
    } catch {
      /* fall through to defaults */
    }
    return fallback;
  });
  const [aiKey, setAiKey] = useState('');
  const [showAiCfg, setShowAiCfg] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const snapshotTimer = useRef<number | null>(null);
  const lastLen = useRef(INITIAL.length);
  /** Timestamp of the last snapshot — snapshotDue()'s idle gate is measured
   * from here, not from a fixed module-load constant (which made the gate
   * always pass and auto-snapshots fire on every debounce). */
  const lastSnapTs = useRef(INITIAL_TS);
  /** Latest editor text + doc id for timers/intervals that must not be reset
   * on every keystroke. */
  const textRef = useRef('');
  const docIdRef = useRef<number | null>(null);
  textRef.current = text;
  docIdRef.current = docId;
  /** Monotonic ids so stale debounced search responses can't clobber newer ones. */
  const searchSeq = useRef(0);
  const fileSearchSeq = useRef(0);
  const [dragging, setDragging] = useState(false);

  const net = useNetActivity();
  const localOnly = useLocalOnly();
  const localOnlyRef = useRef(localOnly);
  localOnlyRef.current = localOnly;

  const openWorkspace = async (workspace: string) => {
    wsRef.current = workspace;
    docNamesRef.current.clear(); // ids are per-workspace; stale mappings would
    // misroute persistLive after a workspace switch
    const fs = snapshotFs(workspace);
    await mkdir(workspace, { recursive: true });
    await mkdir(`${workspace}/.palimpsest`, { recursive: true });
    const db = await sqliteDb(`${workspace}/.palimpsest/index.db`);
    const s = createHistoryStore(db, fs);
    await s.init();
    setStore(s);
    storeRef.current = s;
    const mds = await listMarkdownDocs(workspace, workspaceEntries);
    let name: string;
    if (mds.length > 0) {
      name = mds[0]!;
    } else {
      name = 'notes.md';
      await writeTextFile(`${workspace}/notes.md`, INITIAL);
    }
    let t = INITIAL;
    try {
      t = await readTextFile(`${workspace}/${name}`);
    } catch {
      /* freshly created doc */
    }
    const doc = await s.getOrCreateDoc(name, name);
    docNamesRef.current.set(doc.id, name);
    const list = await s.list(doc.id);
    if (list.length === 0 && mds.length === 0) {
      await s.capture(doc.id, t, 'milestone', 'Chapter one');
      await s.capture(doc.id, t, 'auto', 'seed');
    }
    setDocId(doc.id);
    setActiveDoc(name);
    setText(t);
    lastLen.current = t.length;
    lastSnapTs.current = list[0]?.ts ?? Date.now();
    await loadDocs();
    await refreshSnaps(doc.id);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opened = await invoke<[string, string] | null>('initial_open');
        if (opened) {
          await openWorkspace(opened[0]);
          await openDoc(opened[1]);
          return;
        }
        const saved = await invoke<string | null>('get_workspace');
        const workspace = saved ?? (await `${await appDataDir()}/palimpsest-demo`);
        await openWorkspace(workspace);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const docsListRef = useRef('');
  const loadDocs = async () => {
    if (!wsRef.current) return;
    const list = await listMarkdownDocs(wsRef.current, workspaceEntries);
    const key = list.join('\n');
    if (key === docsListRef.current) return;
    docsListRef.current = key;
    setDocs(list);
  };

  const persistLive = (id: number, v: string) => {
    const name = docNamesRef.current.get(id);
    if (!name || !wsRef.current) return;
    writeTextFile(`${wsRef.current}/${name}`, v).catch(() => {});
  };

  const clearDiff = () => {
    setDiff(null);
    setDiffA(null);
    setDiffB('current');
  };

  /** Open a standalone .md file anywhere: workspace becomes its folder, edits save in place. */
  const openFile = async () => {
    const path = await open({ filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return;
    const dir = await dirname(path);
    const name = await basename(path);
    await openWorkspace(dir);
    await openDoc(name);
  };

  const openDoc = async (name: string) => {
    const s = storeRef.current;
    if (!s || !wsRef.current) return;
    let t = INITIAL;
    try {
      t = await readTextFile(`${wsRef.current}/${name}`);
    } catch {
      /* freshly created doc */
    }
    const doc = await s.getOrCreateDoc(name, name);
    docNamesRef.current.set(doc.id, name);
    await s.reconcile(doc.id, t);
    lastLen.current = t.length;
    // A pending debounce from the previous doc must not fire after the switch:
    // it would re-capture the old text under a stale closure.
    if (snapshotTimer.current) {
      window.clearTimeout(snapshotTimer.current);
      snapshotTimer.current = null;
    }
    setActiveDoc(name);
    setSelected(null);
    setPreview(null);
    clearDiff();
    setDocId(doc.id);
    setText(t);
    await refreshSnaps(doc.id);
    // Measure the idle gate from the latest snapshot (or now, for a doc with
    // no history yet) instead of leaving a stale timestamp from the old doc.
    const list = await s.list(doc.id);
    lastSnapTs.current = list[0]?.ts ?? Date.now();
  };

  const createDoc = async () => {
    const raw = newDocName.trim();
    if (!raw || !store || !wsRef.current) return;
    let name = raw.endsWith('.md') ? raw : `${raw}.md`;
    const slash = name.lastIndexOf('/');
    if (slash > 0) await mkdir(`${wsRef.current}/${name.slice(0, slash)}`, { recursive: true });
    const exists = await readTextFile(`${wsRef.current}/${name}`).catch(() => null);
    setNewDocName('');
    if (exists !== null) return openDoc(name);
    await writeTextFile(`${wsRef.current}/${name}`, INITIAL);
    await openDoc(name);
    await loadDocs();
  };

  const changeWorkspace = async () => {
    try {
      const picked = await invoke<string | null>('pick_workspace');
      if (!picked) return;
      setSelected(null);
      setPreview(null);
      setSearchQuery('');
      setSearchResults([]);
      clearDiff();
      await openWorkspace(picked);
    } catch (e) {
      setErr(String(e));
    }
  };

  const createMilestone = async () => {
    if (!store || docId === null) return;
    const label = window.prompt('Name this moment', new Date().toLocaleString());
    if (!label) return;
    const external = await store.reconcile(docId, text);
    const latest = snaps[0];
    if (latest && external === null && (await store.get(docId, latest.id)).text === text) {
      alert('No changes since the last snapshot — milestone not recorded.');
      return;
    }
    await store.capture(docId, text, 'milestone', label);
    persistLive(docId, text);
    lastLen.current = text.length;
    lastSnapTs.current = Date.now();
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
    const seq = ++searchSeq.current;
    searchTimer.current = window.setTimeout(async () => {
      if (!q.trim() || !store) {
        setSearchResults([]);
        return;
      }
      try {
        const hits = await store.search(q, 30, true);
        if (searchSeq.current === seq) setSearchResults(hits);
      } catch {
        if (searchSeq.current === seq) setSearchResults([]);
      }
    }, 250);
  };

  const onSearchOpen = async (r: (typeof searchResults)[number]) => {
    if (r.source === 'history' && r.snapshotId && r.docId) {
      clearDiff();
      setSelected(r.snapshotId);
      if (viewMode === 'write') setViewMode('split');
      const snap = await store!.get(r.docId, r.snapshotId);
      setPreview(snap.text);
    } else {
      await openDoc(r.docName);
    }
  };

  useEffect(() => {
    localStorage.setItem('palimpsest.panels', JSON.stringify(collapsed));
  }, [collapsed]);

  const togglePane = (k: 'docs' | 'hist') => () => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  const onFileSearch = (q: string) => {
    setFileQuery(q);
    if (fileSearchTimer.current) window.clearTimeout(fileSearchTimer.current);
    const seq = ++fileSearchSeq.current;
    fileSearchTimer.current = window.setTimeout(async () => {
      const name = docId !== null ? docNamesRef.current.get(docId) : undefined;
      if (!q.trim() || !store || !name) {
        setFileResults([]);
        return;
      }
      try {
        // SQL-level doc scoping: a plain workspace-wide search could fill its
        // LIMIT with other docs' hits and miss matches in the current file.
        const hits = await store.search(q, 30, true, { doc: name });
        if (fileSearchSeq.current === seq) setFileResults(hits);
      } catch {
        if (fileSearchSeq.current === seq) setFileResults([]);
      }
    }, 250);
  };

  const loadDiff = async () => {
    if (!store || docId === null || diffA === null) {
      setDiff(null);
      return;
    }
    const label = (id: number | 'current') =>
      id === 'current' ? 'current' : (filtered.find((s) => s.id === id)?.label ?? `#${id}`);
    const r = await store.diff(docId, diffA, diffB, text);
    setDiff({
      fromLabel: label(diffA),
      toLabel: label(diffB),
      added: r.added,
      removed: r.removed,
      html: r.html,
    });
  };

  useEffect(() => {
    void loadDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffA, diffB, docId]);

  useEffect(() => {
    if (diff && diffB === 'current') void loadDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const onRestoreDiff = async () => {
    if (!store || docId === null || diffB === 'current' || !diff) return;
    setBusy(true);
    try {
      const r = await store.restore(docId, diffB as number, text, `Diff restore → ${diff.toLabel}`);
      setText(r.text);
      persistLive(docId, r.text);
      lastLen.current = r.text.length;
      lastSnapTs.current = Date.now();
      setSavedAt(Date.now());
      setDiff(null);
      setPreview(null);
      await refreshSnaps(docId);
    } finally {
      setBusy(false);
    }
  };

  const loadLinks = async () => {
    if (!wsRef.current) return;
    // Read all docs concurrently — the sequential loop made the backlinks
    // panel wait on every file in the workspace one after another.
    const texts = await Promise.all(
      docs.map((d) => readTextFile(`${wsRef.current}/${d}`).catch(() => null)),
    );
    const found: Array<{ from: string; to: string }> = [];
    docs.forEach((d, i) => {
      const txt = texts[i];
      if (!txt) return;
      for (const m of txt.matchAll(/\[\[([^\]|#!]+)/g))
        found.push({ from: d, to: (m[1] ?? '').trim() });
    });
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
        label: 'Open file…',
        hint: 'ctrl+o',
        run: () => void openFile(),
      },
      {
        label: 'New document',
        run: () => {
          setViewMode('write');
          newDocInputRef.current?.focus();
        },
      },
      {
        label:
          viewMode === 'split' ? 'Write only' : viewMode === 'write' ? 'Split view' : 'Write view',
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

  const toolbar: Array<{ Icon: LucideIcon; title: string; group: number; run: () => void }> = [
    { Icon: Bold, title: 'Bold', group: 0, run: () => editorApiRef.current?.wrap('**') },
    { Icon: Italic, title: 'Italic', group: 0, run: () => editorApiRef.current?.wrap('*') },
    {
      Icon: Strikethrough,
      title: 'Strikethrough',
      group: 0,
      run: () => editorApiRef.current?.wrap('~~'),
    },
    { Icon: Code2, title: 'Inline code', group: 0, run: () => editorApiRef.current?.wrap('`') },
    {
      Icon: Link2,
      title: 'Link',
      group: 1,
      run: () => editorApiRef.current?.wrap('[', '](https://)', (sel) => sel),
    },
    { Icon: Heading1, title: 'Heading 1', group: 1, run: () => editorApiRef.current?.insert('# ') },
    {
      Icon: Heading2,
      title: 'Heading 2',
      group: 1,
      run: () => editorApiRef.current?.insert('## '),
    },
    {
      Icon: Heading3,
      title: 'Heading 3',
      group: 1,
      run: () => editorApiRef.current?.insert('### '),
    },
    { Icon: Quote, title: 'Quote', group: 1, run: () => editorApiRef.current?.insert('> ') },
    { Icon: List, title: 'Bullet list', group: 1, run: () => editorApiRef.current?.insert('- ') },
    {
      Icon: ListOrdered,
      title: 'Numbered list',
      group: 1,
      run: () => editorApiRef.current?.insert('1. '),
    },
    {
      Icon: ListTodo,
      title: 'Task list',
      group: 1,
      run: () => editorApiRef.current?.insert('- [ ] '),
    },
    {
      Icon: Table2,
      title: 'Table',
      group: 2,
      run: () => editorApiRef.current?.insert('| col | col |\n| --- | --- |\n|  |  |'),
    },
    {
      Icon: Minus,
      title: 'Horizontal rule',
      group: 2,
      run: () => editorApiRef.current?.insert('---'),
    },
    {
      Icon: StickyNote,
      title: 'Callout',
      group: 2,
      run: () => editorApiRef.current?.insert('> [!note]'),
    },
  ];

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
    // Refs, not state deps: depending on `text` tore the interval down and
    // recreated it on every keystroke, so during continuous typing it never
    // fired — auto-snapshots and external-change polling only ever ran after
    // a pause. Reading textRef/docIdRef keeps one stable interval per doc.
    const t = window.setInterval(async () => {
      void loadDocs();
      const curText = textRef.current;
      const curDocId = docIdRef.current;
      if (curDocId === null) return;
      const churn = Math.abs(curText.length - lastLen.current);
      if (snapshotDue(Date.now(), lastSnapTs.current, churn)) {
        await store.capture(curDocId, curText, 'auto', 'auto');
        persistLive(curDocId, curText);
        lastLen.current = curText.length;
        lastSnapTs.current = Date.now();
        await refreshSnaps(curDocId);
      }
    }, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, docId]);

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
      lastLen.current = proposal.proposed.length;
      lastSnapTs.current = Date.now();
      setSavedAt(Date.now());
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
      // RecallOptions.document/scope match on the doc NAME. The old call passed
      // String(docId), which never matched anything — chat always ran with an
      // empty memory bundle.
      const bundle = await store.recall(q, 4096, { document: activeDoc });
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
      if (store && docId !== null && snapshotDue(Date.now(), lastSnapTs.current, churn)) {
        await store.capture(docId, v, 'auto', 'auto');
        lastLen.current = v.length;
        lastSnapTs.current = Date.now();
        await refreshSnaps(docId);
      }
      if (docId !== null) {
        persistLive(docId, v);
        setSavedAt(Date.now());
      }
    }, 2500);
  };

  const onRestore = async (id: number) => {
    if (!store || docId === null) return;
    setBusy(true);
    try {
      const r = await store.restore(docId, id, text, 'Manual restore');
      setText(r.text);
      persistLive(docId, r.text);
      lastLen.current = r.text.length;
      lastSnapTs.current = Date.now();
      setSavedAt(Date.now());
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

  const previewSnap = selected !== null ? snaps.find((s) => s.id === selected) : undefined;

  const grouped = useMemo(() => {
    const groups: Array<{ day: string; items: SnapshotInfo[] }> = [];
    for (const s of filtered) {
      const day = new Date(s.ts).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(s);
      else groups.push({ day, items: [s] });
    }
    return groups;
  }, [filtered]);

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
    const imported = isHtml ? htmlToMarkdown(raw) : raw;
    if (imported === text) return;
    // An import replaces the live document, so treat it like a restore:
    // preserve the pre-import state, then persist and record the new text.
    // The old code only called setText — the file on disk kept the old content
    // until the next keystroke, and lastLen went stale.
    if (store && docId !== null) {
      await store.capture(docId, text, 'system', 'Before import');
      await store.capture(docId, imported, 'auto', `Import · ${await basename(path)}`);
      lastLen.current = imported.length;
      lastSnapTs.current = Date.now();
      persistLive(docId, imported);
      setSavedAt(Date.now());
      await refreshSnaps(docId);
    }
    setText(imported);
  };

  // One window-level keydown listener for the app's lifetime: re-registering it
  // on every render (the old dependency-less effect) churned the DOM on each
  // keystroke. The handler lives in a ref so it still sees fresh state.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'p') {
      e.preventDefault();
      setPaletteOpen((v) => !v);
      return;
    }
    if (mod && k === 'o') {
      e.preventDefault();
      void openFile();
      return;
    }
    if (e.key === 'Escape' && diff) {
      clearDiff();
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
    if (e.ctrlKey && e.shiftKey && k === 'f') {
      e.preventDefault();
      fileSearchRef.current?.focus();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const diffWords = useMemo(() => {
    const r = diffProse(preview ?? INITIAL, text);
    return {
      removed: r.removed,
      added: r.added,
      base: preview !== null ? 'vs snapshot' : 'vs baseline',
    };
  }, [text, preview]);

  /** makeSnippet marks the first match as [term] — render it as <mark>. */
  const renderSnippet = (snippet: string): ReactNode => {
    const m = snippet.match(/\[([^\]]*)\]/);
    if (!m || m.index === undefined) return snippet;
    return (
      <>
        {snippet.slice(0, m.index)}
        <mark>{m[1]}</mark>
        {snippet.slice(m.index + m[0].length)}
      </>
    );
  };

  const statusChip = (status: string | undefined): { cls: string; label: string } | null =>
    status === 'modified'
      ? { cls: 'chip-mod', label: 'changed' }
      : status === 'deleted'
        ? { cls: 'chip-del', label: 'gone' }
        : null;

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
        <div className="relative">
          <button
            className="rounded border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-100"
            onClick={() => setMoreOpen((v) => !v)}
            title="Menu"
          >
            …
          </button>
          {moreOpen && (
            <div
              className="absolute left-0 top-full z-40 mt-1 w-44 rounded border border-stone-200 bg-white p-1 text-xs shadow-lg"
              onMouseLeave={() => setMoreOpen(false)}
            >
              {(
                [
                  ['Open file…', () => void openFile(), 'Ctrl+O'],
                  ['Import', () => void onImport(), 'Ctrl+Shift+I'],
                  ['Export HTML', () => void onExport(), 'Alt+L'],
                  ['Print / PDF', onPrintPdf, ''],
                ] as const
              ).map(([label, run, hint]) => (
                <button
                  key={label}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-stone-100"
                  onClick={() => {
                    setMoreOpen(false);
                    run();
                  }}
                >
                  <span>{label}</span>
                  {hint && <span className="text-[10px] text-stone-400">{hint}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <h1 className="font-semibold">Palimpsest</h1>
        <span className="text-stone-500">{activeDoc}</span>
        <span className="tabular-nums text-stone-400">
          · {diffWords.base}: <span className="d-del">−{diffWords.removed}</span>{' '}
          <span className="d-add">+{diffWords.added}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <input
              ref={fileSearchRef}
              value={fileQuery}
              onChange={(e) => onFileSearch(e.target.value)}
              onBlur={() => setTimeout(() => setFileResults([]), 150)}
              placeholder={`search ${activeDoc}…`}
              title="Search current file + its history (Ctrl+Shift+F)"
              className="w-52 rounded border border-stone-300 px-2 py-0.5 text-xs outline-none"
            />
            {(fileResults.length > 0 || (fileQuery.trim() && fileResults.length === 0)) && (
              <ul className="absolute right-0 top-full z-40 mt-1 max-h-72 w-96 overflow-y-auto rounded border border-stone-200 bg-white p-1 text-xs shadow-lg">
                {fileResults.length === 0 && (
                  <li className="px-2 py-1 text-stone-400">No matches in {activeDoc}</li>
                )}
                {fileResults.map((r, i) => (
                  <li key={`${r.docName}-${i}`}>
                    <button
                      onClick={() => void onSearchOpen(r)}
                      className="w-full rounded px-2 py-1 text-left hover:bg-stone-100"
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="block flex-1 truncate">
                          {r.source === 'history' ? `snapshot ${r.snapshotId}` : r.docName}
                        </span>
                        {r.status !== 'current' && statusChip(r.status) && (
                          <span className={`chip ${statusChip(r.status)!.cls}`}>
                            {statusChip(r.status)!.label}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[10px] text-stone-500">
                        {renderSnippet(r.snippet)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center gap-1 text-xs">
            {(['write', 'split', 'read'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-2 py-0.5 ${viewMode === m ? 'seg-active' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <button className="text-xs underline" onClick={toggleTheme} title="Toggle theme">
            {theme === 'light' ? 'Dark' : 'Light'}
          </button>
          <label className="flex items-center gap-1" title="Block any non-local AI request">
            <input
              type="checkbox"
              checked={localOnly}
              onChange={(e) => setLocalOnly(e.target.checked)}
            />
            Local-only
          </label>
          <span
            className={`net-dot ${net.active ? 'active' : 'idle'}`}
            title={net.active ? `Request to ${net.dest}` : 'No network activity'}
          />
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        {collapsed.docs ? (
          <aside className="flex w-8 shrink-0 flex-col items-center bg-[var(--bg2)] py-2">
            <button
              onClick={togglePane('docs')}
              title="Show docs"
              className="text-stone-400 hover:text-stone-700"
            >
              »
            </button>
          </aside>
        ) : (
          <aside className="w-44 shrink-0 overflow-y-auto p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Docs</h2>
              <div className="flex items-center gap-2">
                <button
                  className="text-xs text-stone-400 underline hover:text-stone-600"
                  onClick={() => void changeWorkspace()}
                  title="Choose a different workspace folder"
                >
                  change…
                </button>
                <button
                  onClick={togglePane('docs')}
                  title="Hide docs"
                  className="text-stone-400 hover:text-stone-700"
                >
                  «
                </button>
              </div>
            </div>
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
            {docs.length === 0 && (
              <p className="text-xs text-stone-400">
                No markdown files here — create one above or use Open file… (Ctrl+O).
              </p>
            )}
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
                className="rounded px-2 text-xs hover:bg-stone-100"
                title="New document"
              >
                +
              </button>
            </div>
            <div className="mt-4">
              <input
                value={searchQuery}
                ref={searchInputRef}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="search notes…"
                className="w-full rounded border border-stone-300 px-1.5 py-0.5 text-xs outline-none"
              />
              {searchResults.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {searchResults.map((r, i) => (
                    <li key={`${r.docName}-${i}`}>
                      <button
                        onClick={() => void onSearchOpen(r)}
                        className="w-full rounded px-1.5 py-0.5 text-left hover:bg-stone-100"
                        title={r.snippet}
                      >
                        <span className="flex items-center gap-1 truncate text-xs">
                          <span className="flex-1 truncate">{r.docName}</span>
                          {r.status !== 'current' && statusChip(r.status) && (
                            <span className={`chip ${statusChip(r.status)!.cls}`}>
                              {statusChip(r.status)!.label}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[10px] text-stone-500">
                          {renderSnippet(r.snippet)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {searchQuery.trim() && searchResults.length === 0 && (
                <p className="mt-1 text-[10px] text-stone-400">No matches in workspace</p>
              )}
            </div>
            {outline.length > 0 && (
              <div className="mt-4">
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
        )}
        {collapsed.hist ? (
          <aside className="flex w-8 shrink-0 flex-col items-center bg-[var(--bg2)] py-2">
            <button
              onClick={togglePane('hist')}
              title="Show history"
              className="text-stone-400 hover:text-stone-700"
            >
              »
            </button>
          </aside>
        ) : (
          <aside className="w-80 shrink-0 overflow-y-auto p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">History</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">{snaps.length}</span>
                <button
                  onClick={togglePane('hist')}
                  title="Hide history"
                  className="text-stone-400 hover:text-stone-700"
                >
                  «
                </button>
              </div>
            </div>
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
            <div className="mt-2 flex items-center gap-1 text-xs">
              <span className="shrink-0 text-stone-400">diff</span>
              <select
                value={diffA ?? ''}
                onChange={(e) => setDiffA(e.target.value ? Number(e.target.value) : null)}
                className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1 py-0.5 text-xs outline-none"
                title="Base snapshot"
              >
                <option value="">A…</option>
                {filtered.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label || s.kind} · {new Date(s.ts).toLocaleTimeString()}
                  </option>
                ))}
              </select>
              <span className="text-stone-400">→</span>
              <select
                value={diffB === 'current' ? 'current' : (diffB ?? '')}
                onChange={(e) =>
                  setDiffB(e.target.value === 'current' ? 'current' : Number(e.target.value))
                }
                className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1 py-0.5 text-xs outline-none"
                title="Target snapshot"
              >
                <option value="current">current</option>
                {filtered.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label || s.kind} · {new Date(s.ts).toLocaleTimeString()}
                  </option>
                ))}
              </select>
            </div>
            {diff && (
              <div className="mt-1 text-[10px] text-stone-500">
                +{diff.added} added · −{diff.removed} removed
              </div>
            )}
            <div className="mt-2 space-y-2">
              {snaps.length === 0 && (
                <p className="text-xs text-stone-400">
                  No history yet — Palimpsest snapshots automatically as you write.
                </p>
              )}
              {grouped.map((g) => (
                <div key={g.day} className="day-group">
                  <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                    {g.day}
                  </h3>
                  <ul className="timeline space-y-1">
                    {g.items.map((s) => {
                      const chip = statusChip(s.status);
                      return (
                        <li
                          key={s.id}
                          className={`timeline-item ${selected === s.id ? 'selected' : ''}`}
                        >
                          <button
                            onClick={() => {
                              clearDiff();
                              if (viewMode === 'write') setViewMode('split');
                              void openPreview(s.id);
                            }}
                            onDoubleClick={() => s.kind === 'milestone' && void onRename(s)}
                            title={s.kind === 'milestone' ? 'Double-click to rename' : undefined}
                            className={`w-full rounded px-2 py-1 text-left hover:bg-stone-100 ${
                              selected === s.id ? 'bg-stone-200' : ''
                            }`}
                          >
                            <span className="flex items-center gap-1.5">
                              <span className={`tl-dot tl-dot-${s.kind}`} />
                              <span
                                className={`block flex-1 truncate ${
                                  s.kind === 'milestone' ? 'font-semibold' : ''
                                }`}
                              >
                                {s.label || s.kind}
                              </span>
                              {chip && <span className={`chip ${chip.cls}`}>{chip.label}</span>}
                            </span>
                            <span className="block text-[11px] tabular-nums text-stone-400">
                              {new Date(s.ts).toLocaleTimeString()} · {s.words}w · {s.kind}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
            <div className="mt-5">
              <div className="mt-4 flex gap-1">
                {(['edit', 'chat', 'links'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-2 py-0.5 text-xs ${tab === t ? 'seg-active' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'}`}
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
                      className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-normal hover:bg-stone-100"
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
                          className="mt-0.5 w-full rounded border border-stone-300 px-2 py-1 outline-none"
                          value={aiCfg.baseUrl}
                          onChange={(e) => setAiCfg((c) => ({ ...c, baseUrl: e.target.value }))}
                          placeholder="http://127.0.0.1:11434 (Ollama) or https://…/v1"
                        />
                      </label>
                      <label className="mt-1 block">
                        <span className="text-stone-500">Model</span>
                        <input
                          className="mt-0.5 w-full rounded border border-stone-300 px-2 py-1 outline-none"
                          value={aiCfg.model}
                          onChange={(e) => setAiCfg((c) => ({ ...c, model: e.target.value }))}
                          placeholder="llama3.2 / gpt-4o-mini / local-model"
                        />
                      </label>
                      <label className="mt-1 block">
                        <span className="text-stone-500">
                          API key{' '}
                          {isLocalUrl(aiCfg.baseUrl) ? '(not needed for local servers)' : ''}
                        </span>
                        <input
                          type="password"
                          className="mt-0.5 w-full rounded border border-stone-300 px-2 py-1 outline-none"
                          value={aiKey}
                          onChange={(e) => setAiKey(e.target.value)}
                          placeholder={isLocalUrl(aiCfg.baseUrl) ? 'leave empty' : 'sk-…'}
                        />
                      </label>
                      <div className="mt-2 flex items-center gap-2">
                        <button className="btn-primary" onClick={saveAiCfg}>
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
                    className="w-full resize-none rounded border border-stone-300 p-2 text-xs outline-none"
                    rows={3}
                    placeholder={`Ask AI · ${provider.model} — edit instruction`}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <div className="mt-1 flex gap-2">
                    <button
                      className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100 disabled:opacity-50"
                      onClick={() => void onPropose()}
                      disabled={aiBusy || !prompt.trim()}
                    >
                      {aiBusy ? 'Proposing…' : localOnly ? 'Propose (local)' : 'Propose'}
                    </button>
                    {proposal && (
                      <>
                        <button
                          className="btn-primary"
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
                      className="flex-1 rounded border border-stone-300 px-2 py-1 text-xs outline-none"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void onSend()}
                      placeholder={`Ask AI · ${provider.model}`}
                    />
                    <button
                      className="btn-primary"
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
                  <div className="mt-4 text-stone-400">
                    {links.length} links across {docs.length} notes
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
        <main className="flex min-h-0 flex-1 flex-col">
          {viewMode !== 'read' && (
            <div className="flex flex-wrap items-center px-2 py-1.5">
              {toolbar.map((t, i) => (
                <Fragment key={t.title}>
                  {i > 0 && t.group !== toolbar[i - 1]!.group && (
                    <div className="mx-1.5 h-4 w-px bg-[var(--line)]" />
                  )}
                  <button
                    type="button"
                    onClick={t.run}
                    title={t.title}
                    className="rounded p-1 text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                  >
                    <t.Icon size={15} strokeWidth={1.75} />
                  </button>
                </Fragment>
              ))}
            </div>
          )}
          <div
            ref={panesRef}
            className="flex min-h-0 flex-1 overflow-hidden"
            onPointerMove={(e) => {
              if (!dragRef.current || !panesRef.current) return;
              const rect = panesRef.current.getBoundingClientRect();
              const pct = ((e.clientX - rect.left) / rect.width) * 100;
              setSplitPct(Math.min(80, Math.max(20, pct)));
            }}
            onPointerUp={() => {
              if (!dragRef.current) return;
              dragRef.current = null;
              setDragging(false);
              localStorage.setItem('palimpsest.split', String(splitPct));
            }}
          >
            {viewMode !== 'read' && (
              <div
                className={viewMode === 'split' ? 'min-w-0' : 'flex-1 min-w-0'}
                style={viewMode === 'split' ? { width: `${splitPct}%` } : undefined}
              >
                <CodeEditor
                  key={`${activeDoc}:${theme}`}
                  value={text}
                  onChange={onEdit}
                  apiRef={editorApiRef}
                  typewriter={typewriter}
                />
              </div>
            )}
            {viewMode === 'split' && (
              <div
                className={`split-divider ${dragging ? 'dragging' : ''}`}
                title="Drag to resize"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  dragRef.current = { startX: e.clientX, startPct: splitPct };
                  setDragging(true);
                }}
              />
            )}
            {viewMode !== 'write' && (
              <div
                ref={previewRef}
                className={
                  viewMode === 'split'
                    ? 'min-w-0 flex-1 overflow-y-auto border-l border-stone-200 p-4'
                    : 'flex-1 overflow-y-auto p-4'
                }
              >
                <div className={`preview-pane ${diff ? 'diff-view' : ''}`}>
                  {diff ? (
                    <>
                      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-stone-200 bg-stone-50 p-2 text-xs">
                        <span className="text-stone-500">
                          Diff: <b className="text-stone-800">{diff.fromLabel}</b> →{' '}
                          <b className="text-stone-800">{diff.toLabel}</b>
                        </span>
                        <span className="d-add">+{diff.added}</span>
                        <span className="d-del">−{diff.removed}</span>
                        {diffB !== 'current' && (
                          <button
                            className="underline hover:text-stone-900"
                            onClick={() => void onRestoreDiff()}
                            disabled={busy}
                          >
                            restore → {diff.toLabel}
                          </button>
                        )}
                        {diffB !== 'current' && (
                          <button
                            className="underline hover:text-stone-900"
                            onClick={() => {
                              const a = diffA;
                              setDiffA(diffB as number);
                              setDiffB(a!);
                            }}
                          >
                            swap
                          </button>
                        )}
                        <button className="btn-primary ml-auto" onClick={clearDiff} title="Esc">
                          Back to document
                        </button>
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: diff.html }} />
                    </>
                  ) : (
                    <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  )}
                </div>
                {fenceMsg && <div className="mt-2 text-xs text-stone-500">{fenceMsg}</div>}
                {preview !== null && (
                  <div className="mt-4 border-t border-stone-200 pt-2 text-xs text-stone-400">
                    <span>
                      Previewing snapshot
                      {previewSnap
                        ? ` · ${new Date(previewSnap.ts).toLocaleTimeString()} · ${previewSnap.words}w`
                        : ''}
                      {preview === text ? ' · identical to current' : ''}
                    </span>{' '}
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
          <footer className="flex items-center gap-3 px-3 py-1.5 text-xs text-stone-400">
            <label
              className="flex items-center gap-1 text-stone-500"
              title="Cursor stays centered while typing"
            >
              <input
                type="checkbox"
                checked={typewriter}
                onChange={(e) => setTypewriter(e.target.checked)}
              />
              Typewriter
            </label>
            <span className="tabular-nums">
              {words} words · {text.length} chars · {Math.max(1, Math.round(words / 200))} min read
            </span>
            <span className="ml-auto">{activeDoc}</span>
            <span title={`${snaps.length} snapshots recorded`}>{snaps.length} snapshots</span>
            <span className="flex items-center gap-1" title="Ctrl+S to save now">
              <span className={`status-dot ${savedAt ? 'saved' : 'dirty'}`} />
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
                    {c.hint && (
                      <span className="ml-3 shrink-0 text-xs text-stone-400">{c.hint}</span>
                    )}
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
