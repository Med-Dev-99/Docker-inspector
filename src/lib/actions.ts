// User-facing actions with confirmation, busy state and toasts.
import { useSyncExternalStore } from 'react';
import { engine, q } from './api';
import { queryClient, cName, ContainerSummary } from './docker';
import { confirm } from '../components/dialog';
import { toast, toastError } from '../components/toast';
import { navigate } from './router';

// busy tracking ---------------------------------------------------------
const busy = new Map<string, string>();
const listeners = new Set<() => void>();
let ver = 0;
const emit = () => { ver++; listeners.forEach((l) => l()); };
export function useBusy(id?: string) {
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => ver);
  return id ? busy.get(id) : undefined;
}
async function withBusy<T>(id: string, label: string, fn: () => Promise<T>) {
  busy.set(id, label);
  emit();
  try { return await fn(); } finally { busy.delete(id); emit(); }
}

const refresh = (id?: string) => {
  queryClient.invalidateQueries({ queryKey: ['containers'] });
  if (id) queryClient.invalidateQueries({ queryKey: ['container', id] });
};

const VERB: Record<string, string> = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', pause: 'Pausing', unpause: 'Resuming', kill: 'Killing' };

export type CAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill';

export async function containerDo(id: string, name: string, action: CAction) {
  if (action === 'kill') {
    const r = await confirm({ title: `Kill “${name}”?`, message: 'The main process receives SIGKILL immediately and cannot clean up.', confirmLabel: 'Kill', destructive: true });
    if (!r.ok) return;
  }
  try {
    await withBusy(id, VERB[action], () => engine.post(`/containers/${id}/${action}${action === 'stop' || action === 'restart' ? '?t=10' : ''}`));
  } catch (e) {
    toastError(`Couldn’t ${action} ${name}`, e);
  } finally {
    refresh(id);
  }
}

export async function containerRemove(id: string, name: string, running: boolean, afterNavigate?: string) {
  const r = await confirm({
    title: `Delete “${name}”?`,
    message: running ? 'This container is running. It will be stopped and permanently removed.' : 'The container and its writable layer will be permanently removed. This can’t be undone.',
    confirmLabel: 'Delete', destructive: true, checkbox: 'Also remove its anonymous volumes',
  });
  if (!r.ok) return false;
  try {
    await withBusy(id, 'Deleting', () => engine.del(`/containers/${id}?${q({ force: running ? 1 : undefined, v: r.checked ? 1 : undefined })}`));
    toast({ kind: 'success', title: 'Container deleted', message: name });
    if (afterNavigate) navigate(afterNavigate);
    return true;
  } catch (e) {
    toastError(`Couldn’t delete ${name}`, e);
    return false;
  } finally {
    refresh();
    queryClient.invalidateQueries({ queryKey: ['df'] });
  }
}

export async function projectDo(name: string, containers: ContainerSummary[], action: 'start' | 'stop' | 'restart') {
  const targets = containers.filter((c) => (action === 'start' ? c.State !== 'running' : action === 'stop' ? c.State === 'running' || c.State === 'paused' : true));
  if (!targets.length) return;
  const key = `project:${name}`;
  try {
    await withBusy(key, VERB[action], async () => {
      const results = await Promise.allSettled(targets.map((c) => engine.post(`/containers/${c.Id}/${action}`)));
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      if (failed.length) toast({ kind: 'error', title: `${failed.length} of ${targets.length} failed`, message: failed[0].reason?.message });
      else toast({ kind: 'success', title: `${name}: ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, message: `${targets.length} container${targets.length === 1 ? '' : 's'}` });
    });
  } finally {
    refresh();
  }
}

export async function projectRemove(name: string, containers: ContainerSummary[]) {
  const r = await confirm({
    title: `Delete project “${name}”?`,
    message: `All ${containers.length} containers in this project will be stopped and removed. Images and named volumes are kept.`,
    confirmLabel: 'Delete All', destructive: true,
  });
  if (!r.ok) return;
  const key = `project:${name}`;
  await withBusy(key, 'Deleting', async () => {
    const results = await Promise.allSettled(containers.map((c) => engine.del(`/containers/${c.Id}?force=1`)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast({ kind: 'error', title: `${failed} container(s) couldn’t be removed` });
    else toast({ kind: 'success', title: `Project “${name}” removed` });
  });
  refresh();
  navigate('/containers');
}

export function containerMenuName(c: ContainerSummary) { return cName(c); }

export async function imageRemove(id: string, label: string, opts: { force?: boolean } = {}) {
  const r = await confirm({
    title: `Delete image “${label}”?`,
    message: 'The image and any layers not shared with other images will be removed from disk.',
    confirmLabel: 'Delete', destructive: true, checkbox: 'Force (also untag from other repositories / stopped containers)', checkboxDefault: !!opts.force,
  });
  if (!r.ok) return false;
  try {
    await withBusy(id, 'Deleting', () => engine.del(`/images/${encodeURIComponent(id)}?${q({ force: r.checked ? 1 : undefined })}`));
    toast({ kind: 'success', title: 'Image deleted', message: label });
    return true;
  } catch (e) {
    toastError(`Couldn’t delete ${label}`, e);
    return false;
  } finally {
    queryClient.invalidateQueries({ queryKey: ['images'] });
    queryClient.invalidateQueries({ queryKey: ['df'] });
  }
}

export async function volumeRemove(name: string, label: string) {
  const r = await confirm({ title: `Delete volume “${label}”?`, message: 'All data stored in this volume will be permanently erased.', confirmLabel: 'Delete', destructive: true });
  if (!r.ok) return false;
  try {
    await withBusy(name, 'Deleting', () => engine.del(`/volumes/${encodeURIComponent(name)}`));
    toast({ kind: 'success', title: 'Volume deleted', message: label });
    return true;
  } catch (e) {
    toastError(`Couldn’t delete volume`, e);
    return false;
  } finally {
    queryClient.invalidateQueries({ queryKey: ['volumes'] });
    queryClient.invalidateQueries({ queryKey: ['df'] });
  }
}

export async function networkRemove(id: string, name: string) {
  const r = await confirm({ title: `Delete network “${name}”?`, message: 'Containers must be disconnected first.', confirmLabel: 'Delete', destructive: true });
  if (!r.ok) return false;
  try {
    await withBusy(id, 'Deleting', () => engine.del(`/networks/${id}`));
    toast({ kind: 'success', title: 'Network deleted', message: name });
    return true;
  } catch (e) {
    toastError('Couldn’t delete network', e);
    return false;
  } finally {
    queryClient.invalidateQueries({ queryKey: ['networks'] });
  }
}

export async function networkDisconnect(netId: string, netName: string, containerId: string, containerName: string) {
  const r = await confirm({ title: `Disconnect ${containerName}?`, message: `The container will lose its interface on “${netName}”.`, confirmLabel: 'Disconnect', destructive: true });
  if (!r.ok) return;
  try {
    await engine.post(`/networks/${netId}/disconnect`, { Container: containerId, Force: false });
    toast({ kind: 'success', title: 'Disconnected', message: `${containerName} ⟷ ${netName}` });
  } catch (e) {
    toastError('Couldn’t disconnect', e);
  } finally {
    queryClient.invalidateQueries({ queryKey: ['network', netId] });
    queryClient.invalidateQueries({ queryKey: ['networks'] });
    queryClient.invalidateQueries({ queryKey: ['container', containerId] });
  }
}
