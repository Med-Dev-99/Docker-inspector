// Docker types, react-query hooks and domain helpers.
import { useEffect } from 'react';
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, engine } from './api';
import { socket } from './ws';

// ------------------------------------------------------------------ types
export interface Port { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }
export interface ContainerSummary {
  Id: string; Names: string[]; Image: string; ImageID: string; Command: string; Created: number;
  Ports: Port[]; Labels: Record<string, string>; State: string; Status: string;
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, any> };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean; Mode?: string }[];
  SizeRw?: number; SizeRootFs?: number;
}
export interface ImageSummary {
  Id: string; ParentId: string; RepoTags: string[] | null; RepoDigests: string[] | null; Created: number;
  Size: number; SharedSize: number; VirtualSize?: number; Labels: Record<string, string> | null; Containers: number;
}
export interface Volume {
  Name: string; Driver: string; Mountpoint: string; CreatedAt?: string; Labels: Record<string, string> | null;
  Scope: string; Options: Record<string, string> | null; UsageData?: { Size: number; RefCount: number };
}
export interface Network {
  Name: string; Id: string; Created: string; Scope: string; Driver: string; EnableIPv6: boolean; EnableIPv4?: boolean;
  IPAM: { Driver: string; Options: any; Config: { Subnet?: string; Gateway?: string; IPRange?: string }[] | null };
  Internal: boolean; Attachable: boolean; Ingress: boolean; ConfigOnly?: boolean;
  Containers?: Record<string, { Name: string; EndpointID: string; MacAddress: string; IPv4Address: string; IPv6Address: string }>;
  Options: Record<string, string>; Labels: Record<string, string>;
}
export interface DockerEvent {
  id: string; time: number; type: string; action: string; actorId: string; attributes: Record<string, string>; scope?: string;
}
export interface SystemDf {
  LayersSize: number;
  Images: ImageSummary[];
  Containers: ContainerSummary[];
  Volumes: Volume[];
  BuildCache: { ID: string; Type: string; Description: string; InUse: boolean; Shared: boolean; Size: number; CreatedAt: string; LastUsedAt: string; UsageCount: number }[];
}
export interface Host {
  hostname: string; os: string; kernel: string; arch: string; uptime: number; cpus: number; cpuModel: string;
  loadavg: number[]; mem: { total: number; used: number; swapTotal: number; swapUsed: number };
  disk: { path: string; total: number; free: number; used: number } | null;
}
export interface Meta { app: { name: string; version: string }; socket: string; apiVersion: string; engine: any }

// ------------------------------------------------------------------ query client
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 3000, refetchOnWindowFocus: false, retry: 1 },
  },
});

export const useContainers = () =>
  useQuery({ queryKey: ['containers'], queryFn: () => engine.get<ContainerSummary[]>('/containers/json?all=1'), refetchInterval: 15000 });
export const useContainer = (id?: string) =>
  useQuery({ queryKey: ['container', id], queryFn: () => engine.get<any>(`/containers/${id}/json`), enabled: !!id, refetchInterval: 10000 });
export const useContainerSize = (id?: string) =>
  useQuery({ queryKey: ['container-size', id], queryFn: () => engine.get<any>(`/containers/${id}/json?size=1`), enabled: !!id, staleTime: 60000 });
export const useImages = () =>
  useQuery({ queryKey: ['images'], queryFn: () => engine.get<ImageSummary[]>('/images/json?all=0'), refetchInterval: 30000 });
export const useImage = (id?: string) =>
  useQuery({ queryKey: ['image', id], queryFn: () => engine.get<any>(`/images/${id}/json`), enabled: !!id });
export const useImageHistory = (id?: string) =>
  useQuery({ queryKey: ['image-history', id], queryFn: () => engine.get<any[]>(`/images/${id}/history`), enabled: !!id });
export const useVolumes = () =>
  useQuery({ queryKey: ['volumes'], queryFn: async () => (await engine.get<{ Volumes: Volume[] }>('/volumes')).Volumes || [], refetchInterval: 30000 });
export const useNetworks = () =>
  useQuery({ queryKey: ['networks'], queryFn: () => engine.get<Network[]>('/networks'), refetchInterval: 30000 });
export const useNetwork = (id?: string) =>
  useQuery({ queryKey: ['network', id], queryFn: () => engine.get<Network>(`/networks/${id}?verbose=false`), enabled: !!id, refetchInterval: 15000 });
export const useDf = () =>
  useQuery({ queryKey: ['df'], queryFn: () => engine.get<SystemDf>('/system/df'), staleTime: 20000, refetchInterval: 60000 });
export const useInfo = () => useQuery({ queryKey: ['info'], queryFn: () => engine.get<any>('/info'), staleTime: 30000 });
export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/api/meta'), staleTime: Infinity });
export const useHost = () => useQuery({ queryKey: ['host'], queryFn: () => api<Host>('/api/host'), refetchInterval: 5000 });
export const useEvents = () =>
  useQuery({ queryKey: ['events'], queryFn: () => api<DockerEvent[]>('/api/events/recent'), staleTime: Infinity });

// ------------------------------------------------------------------ live invalidation
/** Events generated by inspection itself (exec sessions, `top`, file browsing) — not state changes. */
export const isNoiseEvent = (e: DockerEvent) =>
  e.action.startsWith('exec_') || ['top', 'attach', 'resize', 'archive-path', 'extract-to-dir', 'export', 'copy'].includes(e.action);

let timers: Record<string, number> = {};
function debounced(key: string, fn: () => void, ms = 400) {
  clearTimeout(timers[key]);
  timers[key] = window.setTimeout(fn, ms);
}

export function prefs() {
  try { return JSON.parse(localStorage.getItem('di.prefs') || '{}'); } catch { return {}; }
}

export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => socket.subscribe('events', ({ event }: { event: DockerEvent }) => {
    qc.setQueryData<DockerEvent[]>(['events'], (old) => [...(old || []), event].slice(-1000));
    const inv = (key: unknown[]) => debounced(JSON.stringify(key), () => qc.invalidateQueries({ queryKey: key }));
    // `system df` is slow (~1s+): refresh it only for events that change disk usage.
    const invDf = () => debounced('df', () => qc.invalidateQueries({ queryKey: ['df'] }), 3000);
    if (isNoiseEvent(event)) return;
    if (event.action.startsWith('health_status')) { inv(['containers']); inv(['container', event.actorId]); return; }
    switch (event.type) {
      case 'container':
        inv(['containers']);
        inv(['container', event.actorId]);
        if (event.action === 'create' || event.action === 'destroy' || event.action === 'commit') invDf();
        if (event.action === 'destroy') inv(['images']), inv(['volumes']);
        break;
      case 'image':
        inv(['images']);
        if (event.action !== 'tag' && event.action !== 'untag') invDf();
        break;
      case 'volume':
        if (event.action === 'mount' || event.action === 'unmount') return;
        inv(['volumes']); invDf();
        break;
      case 'network': inv(['networks']); inv(['network', event.actorId]); inv(['containers']); break;
      case 'builder': invDf(); break;
    }
  }), [qc]);
}

// ------------------------------------------------------------------ helpers
export const cName = (c?: { Names?: string[]; Name?: string } | null) =>
  (c?.Names?.[0] || c?.Name || '').replace(/^\//, '');

export const project = (labels?: Record<string, string> | null) => labels?.['com.docker.compose.project'];
export const service = (labels?: Record<string, string> | null) => labels?.['com.docker.compose.service'];

export type State = 'running' | 'paused' | 'restarting' | 'exited' | 'created' | 'dead' | 'removing' | string;

export function stateColor(state: State, status?: string): 'green' | 'orange' | 'red' | 'gray' | 'yellow' | 'blue' {
  if (state === 'running') {
    if (status?.includes('unhealthy')) return 'orange';
    if (status?.includes('health: starting')) return 'yellow';
    return 'green';
  }
  if (state === 'paused') return 'yellow';
  if (state === 'restarting') return 'orange';
  if (state === 'dead') return 'red';
  if (state === 'exited') {
    const m = status?.match(/Exited \((\d+)\)/);
    if (m && m[1] !== '0' && m[1] !== '143' && m[1] !== '137') return 'red';
  }
  if (state === 'created') return 'blue';
  return 'gray';
}

export function stateLabel(state: State) {
  return ({ running: 'Running', paused: 'Paused', restarting: 'Restarting', exited: 'Stopped', created: 'Created', dead: 'Dead', removing: 'Removing' } as Record<string, string>)[state] || state;
}

export function healthOf(status?: string) {
  if (!status) return null;
  if (status.includes('(healthy)')) return 'healthy';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  if (status.includes('health: starting')) return 'starting';
  return null;
}

export function imageName(img: ImageSummary) {
  const tag = img.RepoTags?.find((t) => t !== '<none>:<none>');
  if (tag) return tag;
  const dig = img.RepoDigests?.[0];
  if (dig) return dig.split('@')[0] + ':<none>';
  return '<none>';
}

export function splitRepoTag(ref: string) {
  const at = ref.indexOf('@');
  if (at > 0) return { repo: ref.slice(0, at), tag: ref.slice(at + 1) };
  const i = ref.lastIndexOf(':');
  if (i > 0 && !ref.slice(i).includes('/')) return { repo: ref.slice(0, i), tag: ref.slice(i + 1) };
  return { repo: ref, tag: 'latest' };
}

export const isDangling = (img: ImageSummary) => !img.RepoTags?.some((t) => t !== '<none>:<none>');
export const isAnonymousVolume = (name: string) => /^[0-9a-f]{64}$/.test(name);
export const SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none']);

export function portLabel(p: Port) {
  return p.PublicPort ? `${p.PublicPort} → ${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`;
}

export function uniquePorts(ports: Port[]) {
  const seen = new Set<string>();
  return ports
    .filter((p) => { const k = `${p.PublicPort}-${p.PrivatePort}-${p.Type}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.PublicPort || 0) - (b.PublicPort || 0) || a.PrivatePort - b.PrivatePort);
}

/** Reclaimable-space computations, mirroring `docker system df`. */
export function dfSummary(df?: SystemDf) {
  if (!df) return null;
  const images = { count: df.Images.length, active: 0, size: df.LayersSize, reclaimable: 0 };
  for (const i of df.Images) {
    if (i.Containers > 0) images.active++;
    else images.reclaimable += i.SharedSize > 0 ? i.Size - i.SharedSize : i.Size;
  }
  images.reclaimable = Math.min(images.reclaimable, images.size);
  const containers = { count: df.Containers.length, active: 0, size: 0, reclaimable: 0 };
  for (const c of df.Containers) {
    containers.size += c.SizeRw || 0;
    if (c.State === 'running' || c.State === 'paused') containers.active++;
    else containers.reclaimable += c.SizeRw || 0;
  }
  const volumes = { count: df.Volumes.length, active: 0, size: 0, reclaimable: 0 };
  for (const v of df.Volumes) {
    const s = Math.max(0, v.UsageData?.Size ?? 0);
    volumes.size += s;
    if ((v.UsageData?.RefCount ?? 0) > 0) volumes.active++;
    else volumes.reclaimable += s;
  }
  const cache = { count: df.BuildCache?.length || 0, active: 0, size: 0, reclaimable: 0 };
  for (const b of df.BuildCache || []) {
    if (b.Shared) continue;
    cache.size += b.Size;
    if (b.InUse) cache.active++;
    else cache.reclaimable += b.Size;
  }
  const total = images.size + containers.size + volumes.size + cache.size;
  const reclaimable = images.reclaimable + containers.reclaimable + volumes.reclaimable + cache.reclaimable;
  return { images, containers, volumes, cache, total, reclaimable };
}

export async function containerAction(id: string, action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill') {
  await engine.post(`/containers/${id}/${action}`);
  queryClient.invalidateQueries({ queryKey: ['containers'] });
  queryClient.invalidateQueries({ queryKey: ['container', id] });
}

export interface DesktopSettings { runInBackground: boolean; startAtLogin: boolean; notifications: boolean }

declare global {
  interface Window {
    desktop?: {
      isDesktop: boolean;
      platform: string;
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
      isMaximized(): Promise<boolean>;
      onMaximizeChange(cb: (v: boolean) => void): () => void;
      onFocusChange(cb: (v: boolean) => void): () => void;
      openExternal(url: string): void;
      notify(title: string, body: string): void;
      getSettings(): Promise<DesktopSettings>;
      setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
      onSettings(cb: (s: DesktopSettings) => void): () => void;
      onNavigate(cb: (route: string) => void): () => void;
    };
  }
}

export function openExternal(url: string) {
  if (window.desktop) window.desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
