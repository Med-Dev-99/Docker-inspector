import { useMemo, useState } from 'react';
import { Box, Database, Layers, Network, Sparkles, TriangleAlert, ArrowRight, HardDrive, Cpu, MemoryStick } from 'lucide-react';
import { Page } from '../components/layout';
import { AreaChart, Ring, StackedBar } from '../components/charts';
import { Button, Empty, Meter, StatusDot, Spinner } from '../components/ui';
import { useContainers, useImages, useVolumes, useNetworks, useDf, useHost, useInfo, useEvents, dfSummary, cName, stateColor, isNoiseEvent } from '../lib/docker';
import { useAllLatest, useHostHistory } from '../lib/stats';
import { navigate } from '../lib/router';
import { bytes, mem, pct, duration } from '../lib/format';
import { PruneSheet } from './sheets/Prune';
import { EventRow } from './Activity';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardView() {
  const { data: containers } = useContainers();
  const { data: images } = useImages();
  const { data: volumes } = useVolumes();
  const { data: networks } = useNetworks();
  const { data: df } = useDf();
  const { data: host } = useHost();
  const { data: info } = useInfo();
  const { data: events } = useEvents();
  const latest = useAllLatest();
  const hostHist = useHostHistory();
  const [pruneOpen, setPruneOpen] = useState(false);

  const s = dfSummary(df);
  const counts = useMemo(() => {
    const c = { running: 0, paused: 0, stopped: 0, unhealthy: 0, crashed: 0 };
    for (const x of containers || []) {
      if (x.State === 'running') c.running++;
      else if (x.State === 'paused') c.paused++;
      else c.stopped++;
      if (x.Status.includes('(unhealthy)')) c.unhealthy++;
      if (stateColor(x.State, x.Status) === 'red') c.crashed++;
    }
    return c;
  }, [containers]);

  const running = (containers || []).filter((c) => c.State === 'running');
  const totalCpu = running.reduce((a, c) => a + (latest[c.Id]?.cpu || 0), 0);
  const totalMem = running.reduce((a, c) => a + (latest[c.Id]?.mem || 0), 0);
  const ncpu = host?.cpus || 1;
  const top = [...running].sort((a, b) => (latest[b.Id]?.cpu || 0) - (latest[a.Id]?.cpu || 0)).slice(0, 6);
  const topMem = [...running].sort((a, b) => (latest[b.Id]?.mem || 0) - (latest[a.Id]?.mem || 0)).slice(0, 6);
  const diskPct = host?.disk ? ((host.disk.total - host.disk.free) / host.disk.total) * 100 : 0;
  const recent = (events || []).filter((e) => !isNoiseEvent(e) && !e.action.startsWith('health_status') && !(e.type === 'volume' && /mount/.test(e.action)) && !(e.type === 'network' && /connect/.test(e.action))).slice(-8).reverse();
  const memTotal = host?.mem.total || 1;

  return (
    <Page title="Overview" subtitle={host ? `${greeting()} · ${host.hostname}` : undefined}>
      <div className="scroll pad dashboard">
        {host?.disk && diskPct > 90 && (
          <div className="banner banner-warn">
            <TriangleAlert size={18} />
            <div className="banner-text">
              <b>Your disk is {pct(diskPct, 0)} full</b> — only {bytes(host.disk.free)} free on the volume holding <span className="mono">{host.disk.path}</span>.
              {s && s.reclaimable > 0 && <> Docker can reclaim about <b>{bytes(s.reclaimable)}</b>.</>}
            </div>
            <Button variant="primary" icon={Sparkles} onClick={() => setPruneOpen(true)}>Clean Up…</Button>
          </div>
        )}

        <div className="stat-cards">
          <a className="stat-card" onClick={() => navigate('/containers')}>
            <div className="stat-icon bg-blue"><Box size={18} /></div>
            <div className="stat-body">
              <div className="stat-label">Containers</div>
              <div className="stat-value">{containers?.length ?? '–'}</div>
              <div className="stat-breakdown">
                <span><StatusDot color="green" size={7} /> {counts.running} running</span>
                {counts.paused > 0 && <span><StatusDot color="yellow" size={7} /> {counts.paused} paused</span>}
                <span><StatusDot color="gray" size={7} /> {counts.stopped} stopped</span>
              </div>
            </div>
          </a>
          <a className="stat-card" onClick={() => navigate('/images')}>
            <div className="stat-icon bg-purple"><Layers size={18} /></div>
            <div className="stat-body">
              <div className="stat-label">Images</div>
              <div className="stat-value">{images?.length ?? '–'}</div>
              <div className="stat-breakdown"><span>{s ? bytes(s.images.size) : '…'}</span>{s && <span className="muted">{bytes(s.images.reclaimable)} reclaimable</span>}</div>
            </div>
          </a>
          <a className="stat-card" onClick={() => navigate('/volumes')}>
            <div className="stat-icon bg-orange"><Database size={18} /></div>
            <div className="stat-body">
              <div className="stat-label">Volumes</div>
              <div className="stat-value">{volumes?.length ?? '–'}</div>
              <div className="stat-breakdown"><span>{s ? bytes(s.volumes.size) : '…'}</span>{s && <span className="muted">{s.volumes.count - s.volumes.active} unused</span>}</div>
            </div>
          </a>
          <a className="stat-card" onClick={() => navigate('/networks')}>
            <div className="stat-icon bg-teal"><Network size={18} /></div>
            <div className="stat-body">
              <div className="stat-label">Networks</div>
              <div className="stat-value">{networks?.length ?? '–'}</div>
              <div className="stat-breakdown"><span>{networks ? networks.filter((n) => !['bridge', 'host', 'none'].includes(n.Name)).length : 0} custom</span></div>
            </div>
          </a>
        </div>

        {(counts.unhealthy > 0 || counts.crashed > 0) && (
          <div className="alerts-row">
            {(containers || []).filter((c) => c.Status.includes('(unhealthy)') || stateColor(c.State, c.Status) === 'red').slice(0, 6).map((c) => (
              <a key={c.Id} className="alert-chip" onClick={() => navigate(`/containers/${c.Id}/logs`)}>
                <StatusDot color={stateColor(c.State, c.Status)} />
                <b>{cName(c)}</b><span className="muted">{c.Status.includes('unhealthy') ? 'unhealthy' : c.Status.replace(/ ago$/, ' ago')}</span>
                <ArrowRight size={12} />
              </a>
            ))}
          </div>
        )}

        <div className="dash-grid">
          <div className="card">
            <div className="card-head">
              <div className="card-title"><Cpu size={14} /> CPU</div>
              <div className="card-note">containers {pct(totalCpu / ncpu)} · host {pct(hostHist[hostHist.length - 1]?.cpu)} of {ncpu} cores</div>
            </div>
            <AreaChart times={hostHist.map((h) => h.t)} height={170} format={(v) => pct(v, 0)} minMax={10} legend
              series={[
                { name: 'Host', color: 'var(--gray-chart)', values: hostHist.map((h) => h.cpu) },
                { name: 'Containers', color: 'var(--blue)', values: hostHist.map((h) => h.ccpu ?? 0) },
              ]} />
          </div>
          <div className="card">
            <div className="card-head">
              <div className="card-title"><MemoryStick size={14} /> Memory</div>
              <div className="card-note">containers {mem(totalMem)} · host {mem(hostHist[hostHist.length - 1]?.mem)} of {mem(memTotal)}</div>
            </div>
            <AreaChart times={hostHist.map((h) => h.t)} height={170} format={(v) => mem(v)} max={memTotal} legend
              series={[
                { name: 'Host used', color: 'var(--gray-chart)', values: hostHist.map((h) => h.mem) },
                { name: 'Containers', color: 'var(--purple)', values: hostHist.map((h) => h.cmem ?? 0) },
              ]} />
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title"><HardDrive size={14} /> Disk</div>
              <Button size="sm" icon={Sparkles} onClick={() => setPruneOpen(true)}>Clean Up…</Button>
            </div>
            {!s ? <div className="loading"><Spinner /> Measuring disk usage…</div> : (
              <div className="disk-card">
                <div className="disk-top">
                  <Ring value={diskPct} size={84} stroke={9} color={diskPct > 90 ? 'var(--red)' : diskPct > 80 ? 'var(--orange)' : 'var(--accent)'}>
                    <div className="ring-big">{pct(diskPct, 0)}</div><div className="ring-small">used</div>
                  </Ring>
                  <div className="disk-text">
                    <div className="disk-big">{bytes(s.total)} <span className="muted">used by Docker</span></div>
                    {host?.disk && <div className="muted small">{bytes(host.disk.free)} free of {bytes(host.disk.total)} on this disk</div>}
                    <div className="disk-reclaim">{bytes(s.reclaimable)} reclaimable</div>
                  </div>
                </div>
                <StackedBar height={10} segments={[
                  { value: s.images.size, color: 'var(--purple)', label: `Images ${bytes(s.images.size)}` },
                  { value: s.containers.size, color: 'var(--blue)', label: `Containers ${bytes(s.containers.size)}` },
                  { value: s.volumes.size, color: 'var(--orange)', label: `Volumes ${bytes(s.volumes.size)}` },
                  { value: s.cache.size, color: 'var(--pink)', label: `Build cache ${bytes(s.cache.size)}` },
                ]} />
                <div className="disk-legend">
                  {[['Images', s.images, 'purple', '/images'], ['Containers', s.containers, 'blue', '/containers'], ['Volumes', s.volumes, 'orange', '/volumes'], ['Build cache', s.cache, 'pink', '/storage']].map(([label, v, color, to]: any) => (
                    <a key={label} className="disk-legend-item" onClick={() => navigate(to)}>
                      <span className={`legend-swatch bg-${color}`} />
                      <span>{label}</span>
                      <b>{bytes(v.size)}</b>
                      <span className="muted small">{bytes(v.reclaimable)} free-able</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div className="card-title">Top consumers</div><div className="card-note">{running.length} running</div></div>
            {running.length === 0 ? <Empty title="Nothing running" message="Start a container to see live usage." /> : (
              <div className="top-list">
                <div className="top-col">
                  <div className="top-head">CPU</div>
                  {top.map((c) => (
                    <a key={c.Id} className="top-row" onClick={() => navigate(`/containers/${c.Id}/stats`)}>
                      <span className="truncate">{cName(c)}</span>
                      <span className="top-val">{pct(latest[c.Id]?.cpu)}</span>
                      <Meter value={Math.min(100, (latest[c.Id]?.cpu || 0))} />
                    </a>
                  ))}
                </div>
                <div className="top-col">
                  <div className="top-head">Memory</div>
                  {topMem.map((c) => (
                    <a key={c.Id} className="top-row" onClick={() => navigate(`/containers/${c.Id}/stats`)}>
                      <span className="truncate">{cName(c)}</span>
                      <span className="top-val">{mem(latest[c.Id]?.mem)}</span>
                      <Meter value={((latest[c.Id]?.mem || 0) / memTotal) * 100 * 4} color="purple" warn={400} danger={400} />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div className="card-title">Recent activity</div><a className="link small" onClick={() => navigate('/activity')}>Show all</a></div>
            {recent.length === 0 ? <Empty title="No recent events" /> : <div className="event-list compact">{recent.map((e) => <EventRow key={e.id} e={e} compact />)}</div>}
          </div>

          <div className="card">
            <div className="card-head"><div className="card-title">This machine</div><a className="link small" onClick={() => navigate('/system')}>Engine details</a></div>
            {host && (
              <div className="machine">
                <div className="machine-row"><span>Host</span><b>{host.hostname}</b></div>
                <div className="machine-row"><span>System</span><b>{host.os}</b></div>
                <div className="machine-row"><span>Kernel</span><b>{host.kernel}</b></div>
                <div className="machine-row"><span>Processor</span><b className="truncate">{host.cpuModel} · {host.cpus} threads</b></div>
                <div className="machine-row"><span>Memory</span><b>{mem(host.mem.used)} / {mem(host.mem.total)}</b></div>
                {host.mem.swapTotal > 0 && <div className="machine-row"><span>Swap</span><b>{mem(host.mem.swapUsed)} / {mem(host.mem.swapTotal)}</b></div>}
                <div className="machine-row"><span>Load</span><b>{host.loadavg.map((l) => l.toFixed(2)).join('  ')}</b></div>
                <div className="machine-row"><span>Uptime</span><b>{duration(host.uptime)}</b></div>
                {info && <div className="machine-row"><span>Docker</span><b>{info.ServerVersion} · {info.Driver} · cgroup v{info.CgroupVersion}</b></div>}
              </div>
            )}
          </div>
        </div>
      </div>
      <PruneSheet open={pruneOpen} onClose={() => setPruneOpen(false)} />
    </Page>
  );
}
