// Tiny hash router: #/containers/<id>/<tab>?path=/etc
import { useSyncExternalStore } from 'react';

function read() {
  const raw = location.hash.slice(1) || '/';
  const [path, search = ''] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(search), raw };
}

let current = read();
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = read();
  for (const l of listeners) l();
});

export function useRoute() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current,
  );
}

export function navigate(to: string, replace = false) {
  const hash = '#' + to;
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash), window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = to;
}

export const link = (...parts: (string | undefined)[]) =>
  '/' + parts.filter(Boolean).map((p) => encodeURIComponent(p!)).join('/');
