import { useState } from 'react';
import { Activity } from 'lucide-react';
import { AreaChart, HistoryChart } from '../../components/charts';
import { Empty, Button, Loading, Segmented, useLocalState } from '../../components/ui';
import { useHistory } from '../../lib/stats';
import { RANGES, RangeKey, useContainerSeries } from '../../lib/history';
import { mem, pct, rate, ago } from '../../lib/format';
import { containerDo } from '../../lib/actions';
import { navigate } from '../../lib/router';
import { MetricTiles } from './Overview';

type Mode = 'live' | RangeKey;

export function StatsTab({ c }: { c: any }) {
  const [mode, setMode] = useLocalState<Mode>('stats.mode', 'live');
  const running = c.State.Status === 'running';
  const effective: Mode = mode === 'live' && !running ? '1h' : mode;
  return (
    <div className="stats-tab">
      <div className="subbar">
        <Segmented size="sm" value={effective} onChange={setMode} options={[
          { value: 'live', label: 'Live' }, { value: '1h', label: '1 hour' }, { value: '6h', label: '6 hours' }, { value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' },
        ]} />
        <div className="flex-1" />
        <span className="subbar-info">{effective === 'live' ? <><span className="live-dot" /> Last 5 minutes, updating every second</> : <>Recorded history · {RANGES[effective].label.toLowerCase()}</>}</span>
      </div>
      {effective === 'live' ? <LiveStats c={c} running={running} /> : <HistoryStats c={c} range={effective} />}
    </div>
  );
}

function LiveStats({ c, running }: { c: any; running: boolean }) {
  const h = useHistory(c.Id);
  if (!running) {
    return <Empty icon={Activity} title="Container is not running" message="Live resource usage is available while the container runs."
      action={<Button variant="primary" onClick={() => containerDo(c.Id, c.Name.slice(1), 'start')}>Start Container</Button>} />;
  }
  const times = h.map((s) => s.t);
  const last = h[h.length - 1];
  const memLimit = last?.memLimit || 0;
  const ncpu = last?.ncpu || 1;
  return (
    <div className="scroll pad">
      <MetricTiles id={c.Id} />
      <div className="chart-grid">
        <div className="card">
          <div className="card-head"><div className="card-title">CPU usage</div><div className="card-note">100% = one core · {ncpu} cores available</div></div>
          <AreaChart times={times} height={180} format={(v) => pct(v)} minMax={5}
            series={[{ name: 'CPU', color: 'var(--blue)', values: h.map((s) => s.cpu) }]} />
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">Memory</div><div className="card-note">{memLimit ? `limit ${mem(memLimit)}` : ''}</div></div>
          <AreaChart times={times} height={180} format={(v) => mem(v)} minMax={64 * 1024 * 1024}
            series={[{ name: 'Used', color: 'var(--purple)', values: h.map((s) => s.mem) }]} />
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">Network I/O</div></div>
          <AreaChart times={times} height={180} format={(v) => rate(v)} minMax={1024}
            series={[
              { name: 'Received', color: 'var(--teal)', values: h.map((s) => s.rxRate) },
              { name: 'Sent', color: 'var(--orange)', values: h.map((s) => s.txRate) },
            ]} />
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">Disk I/O</div></div>
          <AreaChart times={times} height={180} format={(v) => rate(v)} minMax={1024}
            series={[
              { name: 'Read', color: 'var(--indigo)', values: h.map((s) => s.blkRRate) },
              { name: 'Write', color: 'var(--pink)', values: h.map((s) => s.blkWRate) },
            ]} />
        </div>
        <div className="card span-2">
          <div className="card-head"><div className="card-title">Processes (PIDs)</div></div>
          <AreaChart times={times} height={120} format={(v) => String(Math.round(v))} minMax={4}
            series={[{ name: 'PIDs', color: 'var(--green)', values: h.map((s) => s.pids) }]} />
        </div>
      </div>
    </div>
  );
}

function HistoryStats({ c, range }: { c: any; range: RangeKey }) {
  const { data, isLoading, error } = useContainerSeries(c.Id, range);
  const [selected, setSelected] = useState<number | null>(null);
  if (isLoading) return <Loading label="Loading history…" />;
  if (error) return <Empty icon={Activity} title="History is not available" message="The local history database could not be read." />;
  if (!data || data.points.length === 0) {
    return <Empty icon={Activity} title="Nothing recorded for this period" message="Docker Inspector records a container’s usage while the app (or its tray icon) is running and the container is up." />;
  }
  const p = data.points;
  const t = p.map((x) => x.t);
  const limit: number = c.HostConfig?.Memory || 0;
  const deaths = data.events.filter((e) => e.action === 'die').map((e) => ({
    t: e.time, color: e.attributes?.exitCode && e.attributes.exitCode !== '0' ? 'var(--red)' : 'var(--gray)',
    label: `Stopped${e.attributes?.exitCode ? ` (exit ${e.attributes.exitCode})` : ''}`, onClick: undefined,
  }));
  const starts = data.events.filter((e) => e.action === 'start').map((e) => ({ t: e.time, color: 'var(--green)', label: 'Started', onClick: undefined }));
  const markers = [...deaths, ...starts];
  const peakCpu = Math.max(...p.map((x) => x.cpuMax || 0));
  const peakMem = Math.max(...p.map((x) => x.memMax || 0));
  return (
    <div className="scroll pad">
      <div className="hint-bar">
        <Activity size={14} />
        <span>Peak CPU <b>{pct(peakCpu)}</b> · peak memory <b>{mem(peakMem)}</b>{limit ? <> of {mem(limit)} limit</> : ''} · last data {ago(t[t.length - 1])}. Green dots are starts, red dots are crashes.</span>
        <Button size="sm" onClick={() => navigate('/timeline')}>Open Timeline</Button>
      </div>
      <div className="chart-grid">
        <div className="card">
          <div className="card-head"><div className="card-title">CPU usage</div><div className="card-note">average and peak per interval</div></div>
          <HistoryChart from={data.from} to={data.to} times={t} step={data.step} height={170} format={(v) => pct(v)} minMax={10} markers={markers} selected={selected} onSelect={setSelected}
            series={[{ name: 'Average', color: 'var(--blue)', values: p.map((x) => x.cpu) }, { name: 'Peak', color: 'var(--orange)', values: p.map((x) => x.cpuMax), fill: false, dashed: true }]} />
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">Memory</div><div className="card-note">{limit ? `limit ${mem(limit)}` : 'no limit'}</div></div>
          <HistoryChart from={data.from} to={data.to} times={t} step={data.step} height={170} format={(v) => mem(v)} minMax={64 * 1024 * 1024} markers={markers} selected={selected} onSelect={setSelected}
            series={[{ name: 'Average', color: 'var(--purple)', values: p.map((x) => x.mem) }, { name: 'Peak', color: 'var(--pink)', values: p.map((x) => x.memMax), fill: false, dashed: true },
              ...(limit ? [{ name: 'Limit', color: 'var(--red)', values: p.map(() => limit), fill: false, dashed: true }] : [])]} />
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">Network I/O</div></div>
          <HistoryChart from={data.from} to={data.to} times={t} step={data.step} height={150} format={(v) => rate(v)} minMax={1024} selected={selected} onSelect={setSelected}
            series={[{ name: 'Received', color: 'var(--teal)', values: p.map((x) => x.rxRate) }, { name: 'Sent', color: 'var(--orange)', values: p.map((x) => x.txRate) }]} />
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">Disk I/O</div></div>
          <HistoryChart from={data.from} to={data.to} times={t} step={data.step} height={150} format={(v) => rate(v)} minMax={1024} selected={selected} onSelect={setSelected}
            series={[{ name: 'Read', color: 'var(--indigo)', values: p.map((x) => x.blkRRate) }, { name: 'Write', color: 'var(--pink)', values: p.map((x) => x.blkWRate) }]} />
        </div>
      </div>
    </div>
  );
}
