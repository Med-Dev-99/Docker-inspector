import { Activity } from 'lucide-react';
import { AreaChart } from '../../components/charts';
import { Empty, Button } from '../../components/ui';
import { useHistory } from '../../lib/stats';
import { mem, pct, rate } from '../../lib/format';
import { containerDo } from '../../lib/actions';
import { MetricTiles } from './Overview';

export function StatsTab({ c }: { c: any }) {
  const h = useHistory(c.Id);
  const running = c.State.Status === 'running';
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
