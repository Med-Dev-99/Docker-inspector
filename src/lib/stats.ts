// Client-side store of live stats (fed by the WebSocket "stats" topic).
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { socket } from './ws';

export interface Sample {
  t: number; cpu: number; ncpu: number;
  mem: number; memLimit: number; memPct: number;
  rx: number; tx: number; rxRate: number; txRate: number;
  blkR: number; blkW: number; blkRRate: number; blkWRate: number;
  pids: number; pidsLimit: number;
}
/** Host-wide sample; ccpu = containers' CPU as % of the whole host, cmem = containers' memory. */
export interface HostSample { t: number; cpu: number; mem: number; memTotal: number; ccpu: number; cmem: number }

const MAX = 300;
let host: HostSample[] = [];
const containers = new Map<string, Sample[]>();
let latest: Record<string, Sample> = {};
let version = 0;
const listeners = new Set<() => void>();
let started = false;

function bump() {
  // Keep collecting while the window is hidden (tray mode) but don't re-render anything.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { pendingWhileHidden = true; return; }
  version++;
  for (const l of listeners) l();
}
let pendingWhileHidden = false;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pendingWhileHidden) { pendingWhileHidden = false; bump(); }
  });
}

function push<T extends { t: number }>(arr: T[], s: T) {
  if (arr.length && arr[arr.length - 1].t >= s.t) return;
  arr.push(s);
  if (arr.length > MAX) arr.splice(0, arr.length - MAX);
}

export async function startStats() {
  if (started) return;
  started = true;
  try {
    const h = await api<{ host: HostSample[]; containers: Record<string, Sample[]> }>('/api/stats/history');
    host = h.host;
    for (const [id, arr] of Object.entries(h.containers)) {
      containers.set(id, arr);
      if (arr.length) latest[id] = arr[arr.length - 1];
    }
    bump();
  } catch {}
  socket.subscribe('stats', (msg) => {
    push(host, msg.host);
    for (const [id, s] of Object.entries(msg.containers as Record<string, Sample>)) {
      let arr = containers.get(id);
      if (!arr) { arr = []; containers.set(id, arr); }
      push(arr, s);
    }
    latest = msg.containers;
    bump();
  });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getVersion = () => version;

export function useStatsVersion() { return useSyncExternalStore(subscribe, getVersion); }
export function useLatest(id?: string): Sample | undefined { useStatsVersion(); return id ? latest[id] : undefined; }
export function useAllLatest() { useStatsVersion(); return latest; }
export function useHistory(id?: string): Sample[] { useStatsVersion(); return (id && containers.get(id)) || []; }
export function useHostHistory(): HostSample[] { useStatsVersion(); return host; }
export function getLatest() { return latest; }
