import { useState } from 'react';
import { HeartPulse, Pencil } from 'lucide-react';
import { Group, Row, Pill, Button } from '../../components/ui';
import { Sparkline } from '../../components/charts';
import { useHistory, useLatest } from '../../lib/stats';
import { useContainerSize, useHost } from '../../lib/docker';
import { ago, bytes, cmd, cpus, date, duration, mem, nsDuration, pct, rate, toMs, shortId } from '../../lib/format';
import { UpdateResourcesSheet } from '../sheets/UpdateResources';

export function MetricTiles({ id }: { id: string }) {
  const s = useLatest(id);
  const h = useHistory(id);
  const { data: host } = useHost();
  if (!s) return null;
  const memLimit = s.memLimit && host && s.memLimit < host.mem.total ? s.memLimit : 0;
  return (
    <div className="tiles">
      <div className="tile">
        <div className="tile-label">CPU</div>
        <div className="tile-value">{pct(s.cpu)}</div>
        <div className="tile-sub">{(s.cpu / s.ncpu).toFixed(2)}% of {s.ncpu} cores</div>
        <Sparkline values={h.map((x) => x.cpu)} color="var(--blue)" />
      </div>
      <div className="tile">
        <div className="tile-label">Memory</div>
        <div className="tile-value">{mem(s.mem)}</div>
        <div className="tile-sub">{memLimit ? `${pct(s.memPct)} of ${mem(memLimit)} limit` : 'No limit'}</div>
        <Sparkline values={h.map((x) => x.mem)} color="var(--purple)" />
      </div>
      <div className="tile">
        <div className="tile-label">Network</div>
        <div className="tile-value tile-dual"><span>↓ {rate(s.rxRate)}</span><span>↑ {rate(s.txRate)}</span></div>
        <div className="tile-sub">{bytes(s.rx)} in · {bytes(s.tx)} out</div>
        <Sparkline values={h.map((x) => x.rxRate + x.txRate)} color="var(--teal)" />
      </div>
      <div className="tile">
        <div className="tile-label">Disk I/O</div>
        <div className="tile-value tile-dual"><span>R {rate(s.blkRRate)}</span><span>W {rate(s.blkWRate)}</span></div>
        <div className="tile-sub">{bytes(s.blkR)} read · {bytes(s.blkW)} written</div>
        <Sparkline values={h.map((x) => x.blkRRate + x.blkWRate)} color="var(--indigo)" />
      </div>
      <div className="tile">
        <div className="tile-label">Processes</div>
        <div className="tile-value">{s.pids}</div>
        <div className="tile-sub">PIDs{s.pidsLimit && s.pidsLimit < 1e7 ? ` · limit ${s.pidsLimit.toLocaleString()}` : ''}</div>
        <Sparkline values={h.map((x) => x.pids)} color="var(--orange)" />
      </div>
    </div>
  );
}

export function OverviewTab({ c }: { c: any }) {
  const st = c.State;
  const hc = c.HostConfig;
  const cfg = c.Config;
  const labels: Record<string, string> = cfg.Labels || {};
  const health = st.Health;
  const { data: sized } = useContainerSize(c.Id);
  const [editOpen, setEditOpen] = useState(false);
  const running = st.Status === 'running';
  const compose = labels['com.docker.compose.project'];

  return (
    <div className="scroll pad">
      {running && <MetricTiles id={c.Id} />}
      <div className="columns">
        <div className="col">
          <Group title="General">
            <Row label="Name" copy={c.Name.replace(/^\//, '')}>{c.Name.replace(/^\//, '')}</Row>
            <Row label="Container ID" mono copy={c.Id}>{shortId(c.Id)}</Row>
            <Row label="Status">{st.Status}{st.Restarting ? ' (restarting)' : ''}{st.OOMKilled && <Pill color="red">OOM killed</Pill>}</Row>
            <Row label="Created">{date(c.Created)} <span className="muted">({ago(c.Created)})</span></Row>
            {toMs(st.StartedAt) > 0 && <Row label="Started">{date(st.StartedAt)}</Row>}
            {running && <Row label="Uptime">{duration((Date.now() - toMs(st.StartedAt)) / 1000)}</Row>}
            {!running && toMs(st.FinishedAt) > 0 && <Row label="Finished">{date(st.FinishedAt)}</Row>}
            {!running && <Row label="Exit code">{st.ExitCode !== 0 ? <span className="text-red">{st.ExitCode}</span> : '0'}</Row>}
            {st.Error && <Row label="Error"><span className="text-red">{st.Error}</span></Row>}
            <Row label="Restart count">{String(c.RestartCount ?? 0)}</Row>
            {running && <Row label="Main PID" mono>{String(st.Pid)}</Row>}
            <Row label="Platform">{c.Platform}{c.ImageManifestDescriptor?.platform?.architecture ? ` / ${c.ImageManifestDescriptor.platform.architecture}` : ''}</Row>
            <Row label="Hostname" mono>{cfg.Hostname}</Row>
          </Group>

          <Group title="Command">
            <Row label="Entrypoint" mono>{cmd(cfg.Entrypoint)}</Row>
            <Row label="Command" mono>{cmd(cfg.Cmd)}</Row>
            <Row label="Process" mono>{c.Path} {cmd(c.Args)}</Row>
            <Row label="Working dir" mono>{cfg.WorkingDir || '/'}</Row>
            <Row label="User" mono>{cfg.User || 'root (default)'}</Row>
            <Row label="TTY / Stdin">{cfg.Tty ? 'TTY' : 'No TTY'} · {cfg.OpenStdin ? 'stdin open' : 'stdin closed'}</Row>
          </Group>

          {health && (
            <Group title={<span className="flex-c gap-6"><HeartPulse size={13} /> Health check</span>}>
              <Row label="Status"><Pill color={health.Status === 'healthy' ? 'green' : health.Status === 'unhealthy' ? 'orange' : 'yellow'}>{health.Status}</Pill></Row>
              <Row label="Failing streak">{String(health.FailingStreak)}</Row>
              {cfg.Healthcheck && <>
                <Row label="Test" mono>{cmd(cfg.Healthcheck.Test?.slice(1))}</Row>
                <Row label="Interval">{nsDuration(cfg.Healthcheck.Interval) === '—' ? '30s (default)' : nsDuration(cfg.Healthcheck.Interval)} · timeout {nsDuration(cfg.Healthcheck.Timeout)} · retries {cfg.Healthcheck.Retries ?? 3}</Row>
              </>}
              {(health.Log || []).slice(-5).reverse().map((l: any, i: number) => (
                <div key={i} className="health-log">
                  <div className="health-log-head">
                    <Pill color={l.ExitCode === 0 ? 'green' : 'red'}>{l.ExitCode === 0 ? 'pass' : `exit ${l.ExitCode}`}</Pill>
                    <span className="muted">{date(l.Start)}</span>
                  </div>
                  {l.Output?.trim() && <pre className="health-out">{l.Output.trim().slice(0, 600)}</pre>}
                </div>
              ))}
            </Group>
          )}
        </div>

        <div className="col">
          <Group title="Resources & Restart" actions={<Button size="sm" icon={Pencil} onClick={() => setEditOpen(true)}>Edit</Button>}>
            <Row label="Restart policy">{hc.RestartPolicy?.Name || 'no'}{hc.RestartPolicy?.Name === 'on-failure' && hc.RestartPolicy.MaximumRetryCount ? ` (max ${hc.RestartPolicy.MaximumRetryCount})` : ''}</Row>
            <Row label="Memory limit">{hc.Memory ? mem(hc.Memory) : 'Unlimited'}</Row>
            <Row label="Memory reservation">{hc.MemoryReservation ? mem(hc.MemoryReservation) : 'None'}</Row>
            <Row label="Swap limit">{hc.MemorySwap > 0 ? mem(hc.MemorySwap) : hc.MemorySwap === -1 ? 'Unlimited' : 'Default'}</Row>
            <Row label="CPU limit">{cpus(hc.NanoCpus || (hc.CpuQuota && hc.CpuPeriod ? (hc.CpuQuota / hc.CpuPeriod) * 1e9 : 0))}</Row>
            <Row label="CPU shares">{hc.CpuShares ? String(hc.CpuShares) : 'Default (1024)'}</Row>
            <Row label="CPU set">{hc.CpusetCpus || 'All'}</Row>
            <Row label="PIDs limit">{hc.PidsLimit ? String(hc.PidsLimit) : 'Unlimited'}</Row>
            <Row label="Shared memory">{mem(hc.ShmSize)}</Row>
          </Group>

          <Group title="Storage">
            <Row label="Writable layer" hint="SizeRw">{sized ? bytes(sized.SizeRw ?? 0) : '…'}</Row>
            <Row label="Total size" hint="incl. image">{sized ? bytes(sized.SizeRootFs ?? 0) : '…'}</Row>
            <Row label="Storage driver">{c.Driver}</Row>
            <Row label="Mounts">{String(c.Mounts?.length || 0)}</Row>
            <Row label="Read-only rootfs">{hc.ReadonlyRootfs ? 'Yes' : 'No'}</Row>
            <Row label="Log driver">{hc.LogConfig?.Type}{hc.LogConfig?.Config?.['max-size'] ? ` · max ${hc.LogConfig.Config['max-size']}` : ''}</Row>
            <Row label="Log file" mono copy={c.LogPath}>{c.LogPath ? '…' + c.LogPath.slice(-40) : ''}</Row>
          </Group>

          <Group title="Network">
            <Row label="Mode">{hc.NetworkMode}</Row>
            {Object.entries(c.NetworkSettings?.Networks || {}).map(([n, v]: [string, any]) => (
              <Row key={n} label={n} mono>{v.IPAddress || '—'}{v.Gateway ? <span className="muted"> via {v.Gateway}</span> : null}</Row>
            ))}
          </Group>

          {compose && (
            <Group title="Docker Compose">
              <Row label="Project">{compose}</Row>
              <Row label="Service">{labels['com.docker.compose.service']}</Row>
              <Row label="Replica">{labels['com.docker.compose.container-number']}</Row>
              <Row label="Working dir" mono copy={labels['com.docker.compose.project.working_dir']}>{labels['com.docker.compose.project.working_dir']}</Row>
              <Row label="Config files" mono>{labels['com.docker.compose.project.config_files']}</Row>
              {labels['com.docker.compose.depends_on'] && <Row label="Depends on" mono>{labels['com.docker.compose.depends_on']}</Row>}
              <Row label="Compose version">{labels['com.docker.compose.version']}</Row>
            </Group>
          )}
        </div>
      </div>
      <UpdateResourcesSheet open={editOpen} onClose={() => setEditOpen(false)} c={c} />
    </div>
  );
}
