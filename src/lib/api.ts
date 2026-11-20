// HTTP client for the local backend. Every call carries the per-launch token.

function readToken(): string {
  let t = '';
  try {
    const u = new URL(location.href);
    t = u.searchParams.get('t') || '';
    if (t) {
      try { sessionStorage.setItem('di.token', t); } catch {}
      u.searchParams.delete('t');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } else {
      try { t = sessionStorage.getItem('di.token') || ''; } catch {}
    }
  } catch {}
  if (!t && import.meta.env.DEV) t = 'dev-token-dev-token-dev-token-dev-token-dev-token';
  return t;
}

export const TOKEN = readToken();

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function handle(res: Response): Promise<any> {
  if (res.status === 304 || res.status === 204) return null;
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const t = await res.text();
      try { msg = JSON.parse(t).message || t; } catch { msg = t || msg; }
    } catch {}
    throw new ApiError(res.status, String(msg).trim());
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return res.json();
  return res.text();
}

export function apiFetch(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'X-DI-Token': TOKEN };
  if (typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  return fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  return handle(await apiFetch(path, init));
}

export const engine = {
  get: <T = any>(p: string) => api<T>(`/api/engine${p}`),
  post: <T = any>(p: string, body?: unknown) =>
    api<T>(`/api/engine${p}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T = any>(p: string) => api<T>(`/api/engine${p}`, { method: 'DELETE' }),
};

/** Read an NDJSON streaming response (e.g. image pull progress). */
export async function streamNdjson(path: string, init: RequestInit, onObject: (o: any) => void, signal?: AbortSignal) {
  const res = await apiFetch(path, { ...init, signal });
  if (!res.ok) await handle(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onObject(JSON.parse(line)); } catch {}
    }
  }
  if (buf.trim()) try { onObject(JSON.parse(buf)); } catch {}
}

/** Trigger a browser download of an engine resource (e.g. a tar archive). */
export async function downloadEngine(path: string, filename: string) {
  const res = await apiFetch(`/api/engine${path}`);
  if (!res.ok) await handle(res);
  const blob = await res.blob();
  saveBlob(blob, filename);
}

export function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const q = (o: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

export const filters = (f: Record<string, string[]>) => encodeURIComponent(JSON.stringify(f));
