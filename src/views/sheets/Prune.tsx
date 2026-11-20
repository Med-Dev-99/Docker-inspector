import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Sheet, confirm } from '../../components/dialog';
import { Button, Checkbox, Spinner } from '../../components/ui';
import { engine, filters } from '../../lib/api';
import { queryClient, useDf, dfSummary } from '../../lib/docker';
import { toast } from '../../components/toast';
import { bytes, plural } from '../../lib/format';

type Key = 'containers' | 'images' | 'imagesAll' | 'volumes' | 'volumesNamed' | 'networks' | 'cache' | 'cacheAll';

export function PruneSheet({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: Partial<Record<Key, boolean>> }) {
  const { data: df, isLoading } = useDf();
  const s = dfSummary(df);
  const [sel, setSel] = useState<Record<Key, boolean>>({ containers: true, images: true, imagesAll: false, volumes: false, volumesNamed: false, networks: true, cache: true, cacheAll: false });
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (open) setSel({ containers: true, images: true, imagesAll: false, volumes: false, volumesNamed: false, networks: true, cache: true, cacheAll: false, ...preset });
  }, [open]);
  const set = (k: Key) => (v: boolean) => setSel((o) => ({ ...o, [k]: v }));

  const stopped = df?.Containers.filter((c) => !['running', 'paused', 'restarting'].includes(c.State)) || [];
  const dangling = df?.Images.filter((i) => !i.RepoTags?.some((t) => t !== '<none>:<none>') && i.Containers === 0) || [];
  const unusedImages = df?.Images.filter((i) => i.Containers === 0) || [];
  const unusedVolumes = df?.Volumes.filter((v) => (v.UsageData?.RefCount ?? 0) === 0) || [];
  const anonUnused = unusedVolumes.filter((v) => /^[0-9a-f]{64}$/.test(v.Name));
  const sizeOf = (arr: { Size?: number; SharedSize?: number }[]) => arr.reduce((a, i) => a + Math.max(0, (i.Size || 0) - Math.max(0, i.SharedSize || 0)), 0);
  const volSize = (arr: typeof unusedVolumes) => arr.reduce((a, v) => a + Math.max(0, v.UsageData?.Size || 0), 0);

  const est =
    (sel.containers ? stopped.reduce((a, c) => a + (c.SizeRw || 0), 0) : 0) +
    (sel.images ? sizeOf(sel.imagesAll ? unusedImages : dangling) : 0) +
    (sel.volumes ? volSize(sel.volumesNamed ? unusedVolumes : anonUnused) : 0) +
    (sel.cache ? s?.cache.reclaimable || 0 : 0);

  const run = async () => {
    if (sel.volumes) {
      const r = await confirm({ title: 'Delete unused volumes?', message: `${sel.volumesNamed ? 'All unused volumes, including named ones,' : 'Anonymous volumes not used by any container'} will be permanently erased together with their data.`, confirmLabel: 'Delete Data', destructive: true });
      if (!r.ok) return;
    }
    let reclaimed = 0;
    const done: string[] = [];
    const errors: string[] = [];
    const step = async (label: string, fn: () => Promise<any>) => {
      setBusy(label);
      try {
        const r = await fn();
        reclaimed += r?.SpaceReclaimed || 0;
        const n = (r?.ContainersDeleted || r?.ImagesDeleted || r?.VolumesDeleted || r?.NetworksDeleted || r?.CachesDeleted || []).length;
        if (n) done.push(`${label.toLowerCase()}: ${n}`);
      } catch (e: any) { errors.push(`${label}: ${e.message}`); }
    };
    if (sel.containers) await step('Containers', () => engine.post('/containers/prune'));
    if (sel.images) await step('Images', () => engine.post(`/images/prune${sel.imagesAll ? `?filters=${filters({ dangling: ['false'] })}` : ''}`));
    if (sel.volumes) await step('Volumes', () => engine.post(`/volumes/prune${sel.volumesNamed ? `?filters=${filters({ all: ['true'] })}` : ''}`));
    if (sel.networks) await step('Networks', () => engine.post('/networks/prune'));
    if (sel.cache) await step('Build cache', () => engine.post(`/build/prune${sel.cacheAll ? '?all=true' : ''}`));
    setBusy('');
    for (const k of ['containers', 'images', 'volumes', 'networks', 'df']) queryClient.invalidateQueries({ queryKey: [k] });
    if (errors.length) toast({ kind: 'error', title: 'Some cleanups failed', message: errors.join('\n') });
    toast({ kind: 'success', title: `Reclaimed ${bytes(reclaimed)}`, message: done.length ? `Removed ${done.join(', ')}` : 'Nothing needed cleaning.' });
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Clean Up Docker" subtitle="Free disk space by removing things nothing is using" icon={<Sparkles size={18} />} width={560}
      footer={<>
        <span className="sheet-foot-info">{busy ? <><Spinner size={12} /> Cleaning {busy.toLowerCase()}…</> : <>Up to <b>{bytes(est)}</b> reclaimable</>}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!busy || !Object.values(sel).some(Boolean)} onClick={run}>Clean Up</Button>
      </>}>
      {isLoading ? <div className="loading"><Spinner /> Calculating disk usage…</div> : (
        <div className="prune-list">
          <div className="prune-item">
            <Checkbox checked={sel.containers} onChange={set('containers')}><b>Stopped containers</b></Checkbox>
            <div className="prune-meta">{plural(stopped.length, 'container')} · {bytes(stopped.reduce((a, c) => a + (c.SizeRw || 0), 0))}</div>
          </div>
          <div className="prune-item">
            <Checkbox checked={sel.images} onChange={set('images')}><b>Unused images</b></Checkbox>
            <div className="prune-meta">{sel.imagesAll ? `${plural(unusedImages.length, 'image')} not used by any container · ${bytes(sizeOf(unusedImages))}` : `${plural(dangling.length, 'dangling image')} · ${bytes(sizeOf(dangling))}`}</div>
            <div className="prune-sub"><Checkbox checked={sel.imagesAll} disabled={!sel.images} onChange={set('imagesAll')}>Include tagged images not used by any container ({plural(unusedImages.length, 'image')}, {bytes(sizeOf(unusedImages))})</Checkbox></div>
          </div>
          <div className="prune-item">
            <Checkbox checked={sel.cache} onChange={set('cache')}><b>Build cache</b></Checkbox>
            <div className="prune-meta">{plural(df?.BuildCache?.length || 0, 'entry', 'entries')} · {bytes(s?.cache.reclaimable)} reclaimable</div>
            <div className="prune-sub"><Checkbox checked={sel.cacheAll} disabled={!sel.cache} onChange={set('cacheAll')}>Remove all unused cache, not just dangling layers</Checkbox></div>
          </div>
          <div className="prune-item">
            <Checkbox checked={sel.networks} onChange={set('networks')}><b>Unused networks</b></Checkbox>
            <div className="prune-meta">Custom networks with no containers attached</div>
          </div>
          <div className="prune-item danger">
            <Checkbox checked={sel.volumes} onChange={set('volumes')}><b>Unused volumes</b> <span className="pill pill-red">deletes data</span></Checkbox>
            <div className="prune-meta">{sel.volumesNamed ? `${plural(unusedVolumes.length, 'volume')} · ${bytes(volSize(unusedVolumes))}` : `${plural(anonUnused.length, 'anonymous volume')} · ${bytes(volSize(anonUnused))}`}</div>
            <div className="prune-sub"><Checkbox checked={sel.volumesNamed} disabled={!sel.volumes} onChange={set('volumesNamed')}>Include named volumes ({plural(unusedVolumes.length, 'volume')}, {bytes(volSize(unusedVolumes))})</Checkbox></div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
