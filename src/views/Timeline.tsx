import { useMemo, useState } from 'react';
import { Box, Clock, History, X, Skull, ExternalLink } from 'lucide-react';
import { Page } from '../components/layout';
import { HistoryChart, ChartMarker } from '../components/charts';
import { Button, Empty, Group, IconButton, Loading, Pill, Segmented, StatusDot, useLocalState } from '../components/ui';
import { EventRow } from './Activity';
import {
  RANGES, RangeKey, SummaryRow, useCrashes, useContainerSeries, useHistEvents, useHistoryInfo, useHostSeries, useSnapshot, useSummary,
} from '../lib/history';
import { isNoiseEvent } from '../lib/docker';
import { navigate } from '../lib/router';
import { ago, mem, pct, rate } from '../lib/format';

const fullTime = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function TimelineView() {
  const [range, setRange] = useLocalState<RangeKey>('timeline.range', '6h');
  const [selected, setSelected] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const info = useHistoryInfo();
  const host = useHostSeries(range);
  const summary = useSummary(range);
  const crashes = useCrashes();
  const snap = useSnapshot(selected);
  const events = useHistEvents(range);
  const series = useContainerSeries(focus ?? undefined, range, !!focus);

  const markers = useMemo<ChartMarker[]>(() => (crashes.data?.crashes || []).map((c) => ({
    t: c.lastT, color: c.oom ? 'var(--red)' : 'var(--orange)', label: `${c.name}: ${c.title}${c.occurrences > 1 ? ` (x${c.occurrences})` : ''}`,
    onClick: () => navigate(`/crashes/${c.id}`),
  })), [crashes.data]);

  const rangeCrashes = (crashes.data?.crashes || []).filter((c) => host.data && c.lastT >= host.data.from && c.lastT <= host.data.to);
  const rows = useMemo(() => [...(summary.data?.containers || [])].sort((a, b) => b.avgCpu - a.avgCpu), [summary.data]);
  const focusRow = rows.find((r) => r.cid === focus) || null;
  const noisyEvents = useMemo(() => (events.data || []).filter((e) => !isNoiseEvent(e) && !e.action.startsWith('health_status')
    && !(e.type === 'volume' && /mount/.test(e.action)) && !(e.type === 'network' && /connect/.test(e.action))), [events.data]);

  const toolbar = <Segmented value={range} onChange={(r) => { setRange(r); setSelected(null); }} options={(Object.keys(RANGES) as RangeKey[]).map((k) => ({ value: k, label: k === '1h' ? '1 hour' : k === '6h' ? '6 hours' : k === '24h' ? '24 hours' : '7 days' }))} />;

  if (info.error) {
    return (
      <Page title="Timeline" toolbar={toolbar}>
        <Empty icon={History} title="History is not available" message="The local history database could not be opened, so nothing is being recorded. Check that the data folder is writable." />
      </Page>
    );
  }

  const pts = host.data?.points || [];
  const times = pts.map((p) => p.t);
  const memTotal = pts.length ? pts[pts.length - 1].memTotal : undefined;
  const recordingSince = info.data?.first;

  return (
    <Page title="Timeline" subtitle={recordingSince ? `Recording since ${new Date(recordingSince).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · keeps ${info.data?.historyDays} days` : 'Starting to record…'} toolbar={toolbar}>
      <div className="scroll pad timeline">
        {host.isLoading && <Loading label="Loading history…" />}
        {host.data && (
          <>
            <div className="hint-bar">
              <Clock size={14} />
              <span>Docker Inspector records your containers’ CPU, memory and events in the background. <b>Click any chart</b> to see what was running at that moment. Dots mark crashes.</span>
              {rangeCrashes.length > 0 && <Pill color="red" icon={Skull}>{rangeCrashes.length} crash{rangeCrashes.length === 1 ? '' : 'es'} in this period</Pill>}
            </div>

            <div className="chart-grid">
              <div className="card">
                <div className="card-head"><div className="card-title">CPU</div><div className="card-note">machine total · containers’ share</div></div>
                <HistoryChart from={host.data.from} to={host.data.to} times={times} step={host.data.step} height={170} format={(v) => pct(v)} minMax={10}
                  series={[{ name: 'Whole machine', color: 'var(--gray-chart)', values: pts.map((p) => p.cpu) }, { name: 'Containers', color: 'var(--blue)', values: pts.map((p) => p.ccpu) }]}
                  markers={markers} selected={selected} onSelect={setSelected} />
              </div>
              <div className="card">
                <div className="card-head"><div className="card-title">Memory</div><div className="card-note">machine used · containers</div></div>
                <HistoryChart from={host.data.from} to={host.data.to} times={times} step={host.data.step} height={170} format={(v) => mem(v)} max={memTotal}
                  series={[{ name: 'Whole machine', color: 'var(--gray-chart)', values: pts.map((p) => p.mem) }, { name: 'Containers', color: 'var(--purple)', values: pts.map((p) => p.cmem) }]}
                  markers={markers} selected={selected} onSelect={setSelected} />
              </div>
            </div>

            {selected !== null && (
              <div className="card snapshot">
                <div className="card-head">
                  <div className="card-title"><Clock size={14} /> {fullTime(selected)}</div>
                  <IconButton icon={X} size={14} label="Close" onClick={() => setSelected(null)} />
                </div>
                {snap.isLoading && <Loading />}
                {snap.data && (
                  <div className="snapshot-grid">
                    <div>
                      <div className="top-head">Running at that moment ({snap.data.containers.length})</div>
                      {snap.data.containers.length === 0 && <div className="group-empty">Nothing was recorded at that time (the app was not running, or no container was up).</div>}
                      {snap.data.containers.map((c) => (
                        <a key={c.cid} className="snap-row" onClick={() => navigate(`/containers/${c.cid}`)}>
                          <StatusDot color="green" size={7} />
                          <span className="truncate">{c.name || c.cid.slice(0, 12)}</span>
                          <span className="snap-val">{pct(c.cpu)}</span>
                          <span className="snap-val dim">{mem(c.mem)}</span>
                        </a>
                      ))}
                      {snap.data.host && <div className="snap-host">Machine: CPU {pct(snap.data.host.cpu)} · memory {mem(snap.data.host.mem)} of {mem(snap.data.host.memTotal)}</div>}
                    </div>
                    <div>
                      <div className="top-head">Events within 5 minutes</div>
                      {snap.data.events.filter((e) => !isNoiseEvent(e)).length === 0 && <div className="group-empty">No events around that time.</div>}
                      <div className="event-list compact">{snap.data.events.filter((e) => !isNoiseEvent(e)).slice(-12).map((e) => <EventRow key={e.id} e={e} compact />)}</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <Group title="Busiest containers in this period" footer="Click a container to chart it. Averages are per recorded sample; peaks are the highest value seen.">
              {rows.length === 0 ? <div className="group-empty">No container activity was recorded in this period.</div> : (
                <table className="table">
                  <thead><tr><th>Container</th><th className="r">Avg CPU</th><th className="r">Peak CPU</th><th className="r">Avg memory</th><th className="r">Peak memory</th><th className="r">Crashes</th></tr></thead>
                  <tbody>
                    {rows.slice(0, 25).map((r) => (
                      <tr key={r.cid} className={`clickable${focus === r.cid ? ' selected' : ''}`} onClick={() => setFocus(focus === r.cid ? null : r.cid)}>
                        <td><span className="flex-c gap-6"><Box size={13} className="muted" /><span className="truncate">{r.name || r.cid.slice(0, 12)}</span>{r.project && <span className="muted small">{r.project}</span>}</span></td>
                        <td className="r mono small">{pct(r.avgCpu)}</td><td className="r mono small">{pct(r.maxCpu)}</td>
                        <td className="r mono small">{mem(r.avgMem)}</td><td className="r mono small">{mem(r.maxMem)}</td>
                        <td className="r">{r.crashes > 0 ? <Pill color="red">{r.crashes}</Pill> : <span className="muted">–</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Group>

            {focus && focusRow && <FocusCharts row={focusRow} data={series.data} loading={series.isLoading} memTotal={memTotal} selected={selected} onSelect={setSelected} markers={markers.filter((m) => m.label.startsWith(`${focusRow.name}:`))} />}

            <Group title="What happened" footer="Starts, stops, crashes and image or volume changes in this period." >
              {noisyEvents.length === 0 ? <div className="group-empty">No events were recorded in this period.</div> : (
                <div className="event-list">{[...noisyEvents].reverse().slice(0, 40).map((e) => <EventRow key={e.id} e={e} />)}</div>
              )}
            </Group>
          </>
        )}
      </div>
    </Page>
  );
}

function FocusCharts({ row, data, loading, memTotal, selected, onSelect, markers }: {
  row: SummaryRow; data?: ReturnType<typeof useContainerSeries>['data']; loading: boolean; memTotal?: number; selected: number | null; onSelect: (t: number) => void; markers: ChartMarker[];
}) {
  if (loading || !data) return <Loading />;
  const p = data.points;
  const t = p.map((x) => x.t);
  const limit = row.memLimit && memTotal && row.memLimit < memTotal * 0.95 ? row.memLimit : 0;
  return (
    <div className="card focus-card">
      <div className="card-head">
        <div className="card-title"><Box size={14} /> {row.name || row.cid.slice(0, 12)}</div>
        <Button size="sm" icon={ExternalLink} onClick={() => navigate(`/containers/${row.cid}`)}>Open container</Button>
      </div>
      <div className="chart-grid">
        <div>
          <div className="chart-sub">CPU (100% = one core)</div>
          <HistoryChart from={data.from} to={data.to} times={t} step={data.step} height={140} format={(v) => pct(v)} minMax={10} markers={markers} selected={selected} onSelect={onSelect}
            series={[{ name: 'Average', color: 'var(--blue)', values: p.map((x) => x.cpu) }, { name: 'Peak', color: 'var(--orange)', values: p.map((x) => x.cpuMax), fill: false, dashed: true }]} />
        </div>
        <div>
          <div className="chart-sub">Memory{limit ? ` (limit ${mem(limit)})` : ''}</div>
          <HistoryChart from={data.from} to={data.to} times={t} step={data.step} height={140} format={(v) => mem(v)} minMax={64 * 1024 * 1024} markers={markers} selected={selected} onSelect={onSelect}
            series={[{ name: 'Average', color: 'var(--purple)', values: p.map((x) => x.mem) }, { name: 'Peak', color: 'var(--pink)', values: p.map((x) => x.memMax), fill: false, dashed: true },
              ...(limit ? [{ name: 'Limit', color: 'var(--red)', values: p.map(() => limit), fill: false, dashed: true }] : [])]} />
        </div>
        <div className="span-2">
          <div className="chart-sub">Network (per second)</div>
          <HistoryChart from={data.from} to={data.to} times={t} step={data.step} height={110} format={(v) => rate(v)} minMax={1024} selected={selected} onSelect={onSelect}
            series={[{ name: 'Received', color: 'var(--teal)', values: p.map((x) => x.rxRate) }, { name: 'Sent', color: 'var(--orange)', values: p.map((x) => x.txRate) }]} />
        </div>
      </div>
      <div className="muted small">Last seen {ago(row.last)} · {row.samples.toLocaleString()} samples</div>
    </div>
  );
}
