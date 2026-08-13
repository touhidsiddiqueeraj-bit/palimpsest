import { useEffect, useState } from 'react';

/**
 * Network transparency (master prompt: trust layer).
 * - Any outbound request lights the status indicator with its destination.
 * - Local-only mode blocks every non-localhost request at the wrapper.
 * - Nothing is ever logged or stored — indicator + toggle only.
 */

export interface NetActivity {
  active: boolean;
  dest: string | null;
}

let activity: NetActivity = { active: false, dest: null };
const listeners = new Set<(a: NetActivity) => void>();

export function subscribeNet(cb: (a: NetActivity) => void): () => void {
  listeners.add(cb);
  cb(activity);
  return () => listeners.delete(cb);
}

function setActive(active: boolean, dest: string | null) {
  activity = { active, dest };
  for (const cb of listeners) cb(activity);
}

const isLocal = (host: string) =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

export function hostOf(url: string): string {
  try {
    return new URL(url, window.location.href).hostname;
  } catch {
    return 'unknown';
  }
}

let localOnly = false;
const localOnlyListeners = new Set<(v: boolean) => void>();
export function setLocalOnly(v: boolean) {
  localOnly = v;
  for (const cb of localOnlyListeners) cb(v);
}
export function subscribeLocalOnly(cb: (v: boolean) => void): () => void {
  localOnlyListeners.add(cb);
  cb(localOnly);
  return () => localOnlyListeners.delete(cb);
}

function guard(url: string): void {
  if (!localOnly) return;
  const host = hostOf(url);
  if (!isLocal(host)) throw new Error(`Local-only mode: blocked request to ${host}`);
}

/** Install once at startup. Returns the original fetch for bypass (never used). */
export function installNetGuard(): void {
  if ((window as unknown as { __palimpsestNetGuard?: boolean }).__palimpsestNetGuard) return;
  (window as unknown as { __palimpsestNetGuard?: boolean }).__palimpsestNetGuard = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    guard(url);
    const host = hostOf(url);
    setActive(true, host);
    const done = () => setActive(false, host);
    return nativeFetch(input, init).then(
      (r) => {
        done();
        return r;
      },
      (e) => {
        done();
        throw e;
      },
    );
  };

  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const u = typeof url === 'string' ? url : url.href;
    guard(u);
    const host = hostOf(u);
    setActive(true, host);
    this.addEventListener('loadend', () => setActive(false, host));
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  };

  const origWS = window.WebSocket;
  (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = class extends origWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      const u = typeof url === 'string' ? url : url.href;
      guard(u);
      const host = hostOf(u);
      setActive(true, host);
      super(u, protocols);
      this.addEventListener('open', () => setActive(false, host));
      this.addEventListener('error', () => setActive(false, host));
      this.addEventListener('close', () => setActive(false, host));
    }
  };
}

/** React hook for the status bar indicator. */
export function useNetActivity() {
  const [state, setState] = useState<NetActivity>({ active: false, dest: null });
  useEffect(() => subscribeNet(setState), []);
  return state;
}

export function useLocalOnly() {
  const [v, setV] = useState(localOnly);
  useEffect(() => subscribeLocalOnly(setV), []);
  return v;
}
