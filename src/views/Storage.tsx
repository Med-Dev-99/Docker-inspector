import { useEffect, useState } from 'react';
import { HardDrive, Sparkles, Layers, Box, Database, Hammer, RotateCw, TriangleAlert } from 'lucide-react';
import { Page } from '../components/layout';
import { Donut } from '../components/charts';
import { Button, Capsule, IconButton, Loading, Meter, Pill } from '../components/ui';
import { useDf, useHost, dfSummary, imageName, cName, isAnonymousVolume } from '../lib/docker';
import { navigate, useRoute } from '../lib/router';
import { bytes, pct, ago } from '../lib/format';
import { PruneSheet } from './sheets/Prune';

function BarList({ items, color, empty }: { items: { key: string; label: React.ReactNode; sub?: React.ReactNode; value: number; to?: string; badge?: React.ReactNode }[]; color: string; empty: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <div className="group-empty">{empty}</div>;
  return (
    <div className="bar-list">
      {items.map((i) => (
        <a key={i.key} className="bar-row" onClick={() => i.to && navigate(i.to)}>
          <div className="bar-row-text">
            <span className="truncate">{i.label}</span>{i.badge}
            <span className="flex-1" />
            <b>{bytes(i.value)}</b>
          </div>
          {i.sub && <div className="bar-row-sub truncate">{i.sub}</div>}
          <div className={`size-bar ${color}`}><div style={{ width: `${Math.max(1.5, (i.value / max) * 100)}%` }} /></div>
        </a>
      ))}
    </div>
  );
}

export function StorageView() {
  const { data: df, isLoading, refetch, isFetching } = useDf();
  const { data: host } = useHost();
  const [pruneOpen, setPruneOpen] = useState(false);
  const route = useRoute();
  // Deep link from Doctor: /storage?cleanup=1 opens the Clean Up sheet.
  useEffect(() => { if (route.query.get('cleanup') === '1') { setPruneOpen(true); navigate('/storage', true); } }, [route.raw]);
  const s = dfSummary(df);
  const diskPct = host?.disk ? ((host.disk.total - host.disk.free) / host.disk.total) * 100 : 0;

  const cacheByType = new Map<string, number>();
  for (const b of df?.BuildCache || []) if (!b.Shared) cacheByType.set(b.Type, (cacheByType.get(b.Type) || 0) + b.Size);

  return (
    <Page title="Disk Usage" subtitle={s ? `Docker uses ${bytes(s.total)} · ${bytes(s.reclaimable)} reclaimable` : 'Measuring…'}
      toolbar={<>
        <Capsule><IconButton icon={RotateCw} label="Recalculate" onClick={() => refetch()} className={isFetching ? 'spinning' : ''} /></Capsule>
        <Button variant="primary" icon={Sparkles} onClick={() => setPruneOpen(true)}>Clean Up…</Button>
      </>}>
      {isLoading || !s || !df ? <Loading label="Calculating disk usage — this can take a few seconds…" /> : (
        <div className="scroll pad storage">
          <div className="storage-hero card">
            <Donut size={168} stroke={20} segments={[
              { value: s.images.size, color: 'var(--purple)', label: `Images ${bytes(s.images.size)}` },
              { value: s.containers.size, color: 'var(--blue)', label: `Containers ${bytes(s.containers.size)}` },
              { value: s.volumes.size, color: 'var(--orange)', label: `Volumes ${bytes(s.volumes.size)}` },
              { value: s.cache.size, color: 'var(--pink)', label: `Build cache ${bytes(s.cache.size)}` },
            ]}>
              <div className="ring-big">{bytes(s.total)}</div><div className="ring-small">total</div>
            </Donut>
            <div className="storage-cats">
              {[
                { label: 'Images', icon: Layers, v: s.images, color: 'purple', note: `${s.images.active} of ${s.images.count} in use`, to: '/images' },
                { label: 'Containers', icon: Box, v: s.containers, color: 'blue', note: `writable layers of ${s.containers.count} containers`, to: '/containers' },
                { label: 'Volumes', icon: Database, v: s.volumes, color: 'orange', note: `${s.volumes.active} of ${s.volumes.count} in use`, to: '/volumes' },
                { label: 'Build cache', icon: Hammer, v: s.cache, color: 'pink', note: `${s.cache.count.toLocaleString()} entries`, to: '' },
              ].map((c) => (
                <a key={c.label} className="storage-cat" onClick={() => c.to && navigate(c.to)}>
                  <div className={`stat-icon bg-${c.color}`}><c.icon size={16} /></div>
                  <div className="storage-cat-body">
                    <div className="storage-cat-top"><span>{c.label}</span><b>{bytes(c.v.size)}</b></div>
                    <Meter value={c.v.size ? (c.v.reclaimable / c.v.size) * 100 : 0} color={c.color} warn={101} danger={101} />
                    <div className="storage-cat-sub"><span>{c.note}</span><span>{bytes(c.v.reclaimable)} reclaimable</span></div>
                  </div>
                </a>
              ))}
            </div>
            {host?.disk && (
              <div className="storage-disk">
                <div className="storage-disk-head"><HardDrive size={15} /> <b>Host disk</b>{diskPct > 90 && <Pill color="red" icon={TriangleAlert}>almost full</Pill>}</div>
                <div className="storage-disk-big">{bytes(host.disk.free)} <span className="muted">free</span></div>
                <Meter value={diskPct} />
                <div className="muted small">{bytes(host.disk.total - host.disk.free)} of {bytes(host.disk.total)} used ({pct(diskPct, 0)})</div>
                <div className="muted small">Docker share: {pct((s.total / host.disk.total) * 100, 1)} of the disk</div>
                <div className="mono small muted">{host.disk.path}</div>
              </div>
            )}
          </div>

          <div className="storage-grid">
            <div className="card">
              <div className="card-head"><div className="card-title"><Layers size={14} /> Images by unique size</div><a className="link small" onClick={() => navigate('/images')}>All images</a></div>
              <BarList color="purple" empty="No images" items={[...df.Images].map((i) => ({ i, u: Math.max(0, i.Size - Math.max(0, i.SharedSize)) })).sort((a, b) => b.u - a.u).slice(0, 12).map(({ i, u }) => ({
                key: i.Id, label: imageName(i), value: u, to: `/images/${encodeURIComponent(i.Id)}`,
                sub: `${ago(i.Created * 1000)}${i.SharedSize > 0 ? ` · ${bytes(i.Size)} total, ${bytes(i.SharedSize)} shared with other images` : ''}`,
                badge: i.Containers > 0 ? <Pill color="green">in use</Pill> : <Pill color="gray">unused</Pill>,
              }))} />
            </div>
            <div className="card">
              <div className="card-head"><div className="card-title"><Database size={14} /> Largest volumes</div><a className="link small" onClick={() => navigate('/volumes')}>All volumes</a></div>
              <BarList color="orange" empty="No volumes" items={[...df.Volumes].filter((v) => (v.UsageData?.Size ?? 0) > 0).sort((a, b) => (b.UsageData?.Size || 0) - (a.UsageData?.Size || 0)).slice(0, 12).map((v) => ({
                key: v.Name, label: isAnonymousVolume(v.Name) ? `${v.Name.slice(0, 12)}… (anonymous)` : v.Name, value: v.UsageData?.Size || 0, to: `/volumes/${encodeURIComponent(v.Name)}`,
                badge: (v.UsageData?.RefCount || 0) > 0 ? <Pill color="green">in use</Pill> : <Pill color="gray">unused</Pill>,
              }))} />
            </div>
            <div className="card">
              <div className="card-head"><div className="card-title"><Box size={14} /> Container writable layers</div></div>
              <BarList color="blue" empty="No containers have written data" items={[...df.Containers].filter((c) => (c.SizeRw || 0) > 0).sort((a, b) => (b.SizeRw || 0) - (a.SizeRw || 0)).slice(0, 12).map((c) => ({
                key: c.Id, label: cName(c), value: c.SizeRw || 0, to: `/containers/${c.Id}`, sub: `${c.Image} · ${c.State}`,
              }))} />
            </div>
            <div className="card">
              <div className="card-head"><div className="card-title"><Hammer size={14} /> Build cache</div></div>
              <div className="cache-summary">
                <div><span className="muted">Total</span><b>{bytes(s.cache.size)}</b></div>
                <div><span className="muted">Reclaimable</span><b>{bytes(s.cache.reclaimable)}</b></div>
                <div><span className="muted">Entries</span><b>{s.cache.count.toLocaleString()}</b></div>
                <div><span className="muted">In use</span><b>{s.cache.active}</b></div>
              </div>
              <BarList color="pink" empty="No build cache" items={[...cacheByType.entries()].sort((a, b) => b[1] - a[1]).map(([t, v]) => ({ key: t, label: t, value: v }))} />
              <div className="card-foot"><Button size="sm" icon={Sparkles} onClick={() => setPruneOpen(true)}>Clear build cache…</Button></div>
            </div>
          </div>
        </div>
      )}
      <PruneSheet open={pruneOpen} onClose={() => setPruneOpen(false)} />
    </Page>
  );
}
