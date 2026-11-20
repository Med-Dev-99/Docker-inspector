// Client for the time machine, crash reports and Doctor APIs.
import { useQuery } from '@tanstack/react-query';
import { api, engine } from './api';
import { queryClient, DockerEvent } from './docker';

export type RangeKey = '1h' | '6h' | '24h' | '7d';
export const RANGES: Record<RangeKey, { ms: number; label: string }> = {
  '1h': { ms: 3600_000, label: 'Last hour' },
  '6h': { ms: 6 * 3600_000, label: 'Last 6 hours' },
  '24h': { ms: 24 * 3600_000, label: 'Last 24 hours' },
  '7d': { ms: 7 * 24 * 3600_000, label: 'Last 7 days' },
};

export interface HostPoint { t: number; cpu: number; mem: number; memTotal: number; ccpu: number; cmem: number }
export interface ContainerPoint {
  t: number; cpu: number; cpuMax: number; mem: number; memMax: number; memLimit: number;
  rxRate: number; txRate: number; blkRRate: number; blkWRate: number; pids: number;
}
export interface Series<P> { from: number; to: number; step: number; points: P[] }
export interface SummaryRow {
  cid: string; name: string | null; image: string | null; project: string | null; service: string | null;
  avgCpu: number; maxCpu: number; avgMem: number; maxMem: number; memLimit: number; samples: number; first: number; last: number; crashes: number;
}
export interface Snapshot {
  t: number;
  host: HostPoint | null;
  containers: { cid: string; t: number; cpu: number; mem: number; memLimit: number; rxRate: number; txRate: number; name: string | null; image: string | null; project: string | null }[];
  events: DockerEvent[];
}

export interface CrashSummary {
  id: number; cid: string; name: string; image: string | null; project: string | null; service: string | null;
  t: number; lastT: number; occurrences: number; exitCode: number | null; oom: boolean; kind: string;
  title: string; summary: string; severity: 'critical' | 'high' | 'medium' | 'low'; source: 'live' | 'scan'; acked: boolean;
}
export interface Evidence { icon: string; text: string; logIndex?: number }
export interface Analysis {
  kind: string; title: string; summary: string; severity: string; exitCode: number | null; signal: string | null; oom: boolean;
  evidence: Evidence[]; suggestions: { text: string; command?: string }[]; logIndex: number | null;
  ranMs: number | null; peakMem: number | null; memLimit: number | null;
}
export interface CrashReport extends CrashSummary {
  finishedAt: string;
  report: {
    analysis: Analysis;
    logs: { stream: 'stdout' | 'stderr'; ts: string | null; text: string }[];
    samples: { t: number; cpu: number; mem: number; memLimit: number }[];
    events: { time: number; action: string; attributes: Record<string, string | undefined> }[];
    config: {
      image?: string; imageId?: string; command?: string; restartPolicy?: string; restartCount?: number; memoryLimit?: number; cpus?: number;
      startedAt?: string; finishedAt?: string; error?: string | null; workingDir?: string | null;
      health?: { status: string; failingStreak: number; log: { exitCode: number; end: string; output: string }[] } | null;
    };
  };
  container: { id: string; state: string } | null;
  previous: { id: number; t: number; lastT: number; occurrences: number; title: string; kind: string; oom: boolean }[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Fix =
  | { kind: 'copy'; label: string; text: string }
  | { kind: 'update'; label: string; body: Record<string, unknown> }
  | { kind: 'navigate'; label: string; to: string };
export interface Finding {
  key: string; check: string; severity: Severity; category: 'security' | 'reliability' | 'resources' | 'maintenance';
  title: string; detail: string; target: { id: string; name: string; project: string | null; running: boolean } | null;
  fixes: Fix[]; ignored: boolean;
}
export interface DoctorResult {
  generatedAt: number; score: number; grade: string; counts: Record<Severity, number>;
  engine: { os: string; native: boolean; desktop: boolean; ufw: boolean | null; endpoint: string };
  findings: Finding[];
  containers: { id: string; name: string; project: string | null; running: boolean; score: number; grade: string; issues: number }[];
}

// ------------------------------------------------------------------ queries
const span = (range: RangeKey, end?: number) => {
  const to = end ?? Date.now();
  return { from: to - RANGES[range].ms, to };
};

export const useHistoryInfo = () =>
  useQuery({ queryKey: ['hist-info'], queryFn: () => api<{ first: number | null; historyDays: number; dataDir: string }>('/api/history/info'), staleTime: 60_000, retry: false });

export const useHostSeries = (range: RangeKey, end?: number) =>
  useQuery({
    queryKey: ['hist-host', range, end ?? 'now'],
    queryFn: () => { const { from, to } = span(range, end); return api<Series<HostPoint>>(`/api/history/host?from=${from}&to=${to}`); },
    refetchInterval: end ? false : range === '1h' ? 10_000 : 60_000, retry: false,
  });

export const useContainerSeries = (id: string | undefined, range: RangeKey, enabled = true) =>
  useQuery({
    queryKey: ['hist-container', id, range],
    queryFn: () => { const { from, to } = span(range); return api<Series<ContainerPoint> & { events: DockerEvent[] }>(`/api/history/container/${id}?from=${from}&to=${to}`); },
    enabled: !!id && enabled, refetchInterval: range === '1h' ? 10_000 : 60_000, retry: false,
  });

export const useSummary = (range: RangeKey) =>
  useQuery({
    queryKey: ['hist-summary', range],
    queryFn: () => { const { from, to } = span(range); return api<{ from: number; to: number; containers: SummaryRow[] }>(`/api/history/summary?from=${from}&to=${to}`); },
    refetchInterval: 60_000, retry: false,
  });

export const useSnapshot = (t: number | null) =>
  useQuery({ queryKey: ['hist-snapshot', t], queryFn: () => api<Snapshot>(`/api/history/snapshot?t=${t}`), enabled: t !== null, retry: false });

export const useHistEvents = (range: RangeKey) =>
  useQuery({
    queryKey: ['hist-events', range],
    queryFn: () => { const { from, to } = span(range); return api<DockerEvent[]>(`/api/history/events?from=${from}&to=${to}&limit=3000`); },
    refetchInterval: 60_000, retry: false,
  });

export const useCrashes = () =>
  useQuery({ queryKey: ['crashes'], queryFn: () => api<{ unread: number; crashes: CrashSummary[] }>('/api/crashes'), refetchInterval: 60_000, retry: false });

export const useCrash = (id?: string) =>
  useQuery({ queryKey: ['crash', id], queryFn: () => api<CrashReport>(`/api/crashes/${id}`), enabled: !!id, retry: false });

export const useDoctor = () =>
  useQuery({ queryKey: ['doctor'], queryFn: () => api<DoctorResult>('/api/doctor'), staleTime: 15_000, refetchInterval: 60_000, retry: false });

// ------------------------------------------------------------------ mutations
const refreshCrashes = () => {
  queryClient.invalidateQueries({ queryKey: ['crashes'] });
  queryClient.invalidateQueries({ queryKey: ['doctor'] });
};
export async function ackCrash(id: number) { await api(`/api/crashes/${id}/ack`, { method: 'POST' }); refreshCrashes(); }
export async function ackAllCrashes() { await api('/api/crashes/ack-all', { method: 'POST' }); refreshCrashes(); }
export async function deleteCrash(id: number) { await api(`/api/crashes/${id}`, { method: 'DELETE' }); refreshCrashes(); }

export async function refreshDoctor() {
  const r = await api<DoctorResult>('/api/doctor?fresh=1');
  queryClient.setQueryData(['doctor'], r);
  return r;
}
export async function ignoreFinding(key: string) {
  await api('/api/doctor/ignore', { method: 'POST', body: JSON.stringify({ key }) });
  queryClient.invalidateQueries({ queryKey: ['doctor'] });
}
export async function unignoreFinding(key: string) {
  await api(`/api/doctor/ignore?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
  queryClient.invalidateQueries({ queryKey: ['doctor'] });
}
export async function applyUpdate(containerId: string, body: Record<string, unknown>) {
  const r = await engine.post<{ Warnings?: string[] | null }>(`/containers/${containerId}/update`, body);
  queryClient.invalidateQueries({ queryKey: ['container', containerId] });
  await refreshDoctor().catch(() => {});
  return r;
}

/** Plain-text/Markdown version of a crash report, for pasting into an issue or chat. */
export function crashMarkdown(c: CrashReport) {
  const a = c.report.analysis;
  const lines = [
    `## ${c.name} crashed: ${a.title}`,
    '',
    `- When: ${new Date(c.lastT).toLocaleString()}${c.occurrences > 1 ? ` (${c.occurrences} times)` : ''}`,
    `- Image: ${c.image ?? 'unknown'}`,
    `- Exit code: ${a.exitCode ?? '?'}${a.signal ? ` (${a.signal})` : ''}${a.oom ? ' - OOM killed' : ''}`,
    '',
    a.summary,
    '',
    '### Evidence',
    ...a.evidence.map((e) => `- ${e.text}`),
  ];
  if (a.suggestions.length) lines.push('', '### Suggested fixes', ...a.suggestions.map((s) => `- ${s.text}${s.command ? `\n  \`${s.command}\`` : ''}`));
  const logs = c.report.logs.slice(-40);
  if (logs.length) lines.push('', '### Last log lines', '```', ...logs.map((l) => `${l.stream === 'stderr' ? '[err] ' : ''}${l.text}`), '```');
  return lines.join('\n');
}
