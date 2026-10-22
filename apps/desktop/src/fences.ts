/**
 * Code-fence rendering (spec: render to SVG). Text langs render as-is;
 * diagram langs (ditaa, mermaid, …) get a "render diagram" button that POSTs
 * the source to a diagram server. Any request flows through the netguard —
 * Local-only mode blocks it visibly.
 */

const TEXT_LANGS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'javascript',
  'typescript',
  'md',
  'markdown',
  'bash',
  'sh',
  'zsh',
  'python',
  'py',
  'go',
  'rust',
  'rs',
  'java',
  'c',
  'cpp',
  'csharp',
  'sql',
  'html',
  'css',
  'yaml',
  'yml',
  'toml',
  'json',
  'jsonc',
  'ini',
  'diff',
  'plaintext',
  'text',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'r',
  'lua',
  'perl',
  'scala',
  'd',
  'zig',
  'nim',
  'elixir',
  'erlang',
  'nginx',
  'makefile',
  'dockerfile',
  'xml',
  'svg',
  'http',
  'graphql',
  'proto',
  'powershell',
  'ps1',
  'csv',
  'tsv',
  'groovy',
  'julia',
  'lisp',
  'scheme',
  'vim',
  'vb',
  'vba',
  'dart',
  'ejs',
  'hbs',
  'handlebars',
  'twig',
  'erb',
  'jinja',
  'jl',
  'clojure',
  'haskell',
  'ex',
  'exs',
  'fish',
  'bat',
  'cmake',
]);

const DIAGRAM_LANGS = new Set([
  'ditaa',
  'mermaid',
  'plantuml',
  'graphviz',
  'dot',
  'blockdiag',
  'seqdiag',
  'actdiag',
  'nwdiag',
  'c4plantuml',
  'bpmn',
  'bytefield',
  'erd',
  'nomnoml',
  'pikchr',
  'structurizr',
  'svgbob',
  'umlet',
  'vega',
  'vegalite',
  'wavedrom',
]);

const UNESCAPE: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESCAPE[m] ?? m);
}

/** UTF-8-safe base64 (the deprecated escape/unescape trick breaks on non-Latin1).
 * Chunked: spreading a large Uint8Array into String.fromCharCode blows the
 * argument limit (~125k) with a RangeError on big diagram sources. */
const encodeB64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
};
const decodeB64 = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/**
 * Replaces diagram-lang <pre data-lang="x"><code>…</code></pre> with
 * placeholder divs carrying the base64 source. Returns the new HTML.
 */
export function decorateFences(html: string): string {
  return html.replace(
    /<pre data-lang="([^"]+)"><code>([\s\S]*?)<\/code><\/pre>/g,
    (whole, lang: string, codeHtml: string) => {
      if (!DIAGRAM_LANGS.has(lang.toLowerCase()) || TEXT_LANGS.has(lang.toLowerCase())) {
        return whole;
      }
      const code = decode(codeHtml);
      const b64 = encodeB64(code);
      return (
        `<div class="fence-svg" data-lang="${lang}" data-code="${b64}">` +
        `<button class="fence-render">Render diagram (${lang})</button></div>`
      );
    },
  );
}

/** Attaches render handlers; returns a cleanup fn. Call after HTML is in DOM. */
export function wireFenceButtons(
  root: HTMLElement,
  onRequest: (ok: boolean, msg: string) => void,
): () => void {
  const els = Array.from(root.querySelectorAll<HTMLButtonElement>('button.fence-render'));
  const subs: Array<{ el: HTMLElement; cb: () => void }> = [];
  const objectUrls: string[] = [];
  for (const btn of els) {
    const box = btn.closest<HTMLElement>('.fence-svg');
    if (!box) continue;
    const lang = box.dataset.lang ?? '';
    const code = decodeB64(box.dataset.code ?? '');
    const cb = async () => {
      btn.disabled = true;
      btn.textContent = 'Rendering…';
      try {
        const r = await fetch(`https://kroki.io/${lang}/svg`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: code,
        });
        if (!r.ok) throw new Error(`kroki: HTTP ${r.status}`);
        const svg = await r.blob();
        const url = URL.createObjectURL(svg);
        objectUrls.push(url);
        box.innerHTML = `<img src="${url}" alt="rendered ${lang} diagram">`;
        onRequest(true, lang);
      } catch (e) {
        box.innerHTML = `<span class="text-xs text-red-600">${String(e)}</span>`;
        onRequest(false, String(e));
      }
    };
    btn.addEventListener('click', cb);
    subs.push({ el: btn, cb });
  }
  return () => {
    for (const s of subs) s.el.removeEventListener('click', s.cb);
    // Rendered diagrams are re-created on every preview re-render; without
    // revoking, each render leaked its blob URL for the session.
    for (const url of objectUrls) URL.revokeObjectURL(url);
  };
}
