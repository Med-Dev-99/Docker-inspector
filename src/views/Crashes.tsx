import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertOctagon, Box, CheckCheck, Check, Clock, Copy, Cpu, ExternalLink, HeartPulse, Info, Link2, LogOut, MemoryStick, Play, Repeat,
  ScrollText, ShieldCheck, Trash2, TrendingUp, Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Page, Split } from '../components/layout';
import { HistoryChart } from '../components/charts';
import { Button, Capsule, Empty, Group, IconButton, Loading, Pill, Row, SearchField, StatusDot, Toggle, copyText } from '../components/ui';
import { onContextMenu } from '../components/menu';
import { confirm } from '../components/dialog';
import { toast, toastError } from '../components/toast';
import { ackAllCrashes, ackCrash, applyUpdate, CrashSummary, crashMarkdown, deleteCrash, useCrash, useCrashes } from '../lib/history';
import { containerDo } from '../lib/actions';
import { navigate, useRoute } from '../lib/router';
import { ago, bytes, date, mem, nsDuration, pct } from '../lib/format';

const SEV_COLOR: Record<string, string> = { critical: 'red', high: 'orange', medium: 'yellow', low: 'gray' };
const ICONS: Record<string, LucideIcon> = {
  exit: LogOut, memory: MemoryStick, log: ScrollText, clock: Clock, trend: TrendingUp, cpu: Cpu, health: HeartPulse, link: Link2, loop: Repeat, info: Info,
};

export function CrashesView() {
  const route = useRoute();
  const id = route.parts[1];
  const { data, isLoading } = useCrashes();
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const list = useMemo(() => {
    let l = data?.crashes || [];
    if (unreadOnly) l = l.filter((c) => !c.acked);
    if (search) { const s = search.toLowerCase(); l = l.filter((c) => c.name.toLowerCase().includes(s) || c.title.toLowerCase().includes(s) || (c.project || '').toLowerCase().includes(s)); }
    return l;
  }, [data, search, unreadOnly]);

  // Open the newest report automatically on first visit.
  useEffect(() => { if (!id && list.length) navigate(`/crashes/${list[0].id}`, true); }, [id, list.length]);

  const unread = data?.unread || 0;
  return (
    <Page title="Crash reports" subtitle={data ? (data.crashes.length ? `${data.crashes.length} recorded${unread ? ` · ${unread} new` : ''}` : 'Nothing has crashed') : undefined}
      toolbar={<>
        <Toggle checked={unreadOnly} onChange={setUnreadOnly} label="New only" />
        <Capsule><IconButton icon={CheckCheck} label="Mark all as read" disabled={!unread} onClick={() => ackAllCrashes()} /></Capsule>
        <SearchField value={search} onChange={setSearch} placeholder="Search crashes" />
      </>}>
      <Split listWidth={380}
        list={
          <div className="list">
            {isLoading && <Loading />}
            {!isLoading && list.length === 0 && (
              <Empty icon={ShieldCheck} title={data?.crashes.length ? 'No matches' : 'No crashes recorded'}
                message={data?.crashes.length ? 'Nothing matches your filter.' : 'When a container dies unexpectedly, Docker Inspector saves a report here: why it died, what it logged, and how memory and CPU looked just before.'} />
            )}
            {list.map((c) => <CrashRow key={c.id} c={c} selected={String(c.id) === id} />)}
          </div>
        }
        detail={id ? <CrashDetail key={id} id={id} /> : <Empty icon={AlertOctagon} title="No report selected" message="Select a crash to see why it happened." />}
      />
    </Page>
  );
}

function CrashRow({ c, selected }: { c: CrashSummary; selected: boolean }) {
  return (
    <div className={`list-row${selected ? ' selected' : ''}`} onClick={() => { navigate(`/crashes/${c.id}`); if (!c.acked) ackCrash(c.id); }}
      onContextMenu={onContextMenu([
        { label: 'Mark as read', icon: Check, disabled: c.acked, onClick: () => ackCrash(c.id) },
        { label: 'Delete report', icon: Trash2, destructive: true, onClick: () => deleteCrash(c.id) },
      ])}>
      <div className="lr-lead"><StatusDot color={SEV_COLOR[c.severity] || 'gray'} /></div>
      <div className="lr-main">
        <div className="lr-title"><span className="truncate">{c.name}</span>{c.occurrences > 1 && <span className="tag-chip">×{c.occurrences}</span>}</div>
        <div className="lr-sub truncate">{c.title}</div>
      </div>
      <div className="lr-side">
        <span className="lr-metric">{ago(c.lastT)}</span>
        {!c.acked && <span className="unread-dot" title="New" />}
      </div>
    </div>
  );
}

function CrashDetail({ id }: { id: string }) {
  const { data: c, isLoading, error } = useCrash(id);
  const [applying, setApplying] = useState(false);
  const logBox = useRef<HTMLDivElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  // Scroll only the log box (not the whole page) so the culprit line is in view.
  useEffect(() => {
    const box = logBox.current, line = highlight.current;
    if (box && line) box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 2);
  }, [c?.id]);
  if (isLoading) return <Loading />;
  if (error || !c) return <Empty icon={AlertOctagon} title="Report not found" message="It may have been deleted." />;

  const a = c.report.analysis;
  const cfg = c.report.config;
  const exists = c.container;
  const samples = c.report.samples;
  const logs = c.report.logs;
  const color = SEV_COLOR[c.severity] || 'gray';

  const apply = async (command: string) => {
    if (!exists) return;
    const m = /--memory (\d+)m/.exec(command);
    const sw = /--memory-swap (\d+)m/.exec(command);
    if (!m) return;
    setApplying(true);
    try {
      await applyUpdate(exists.id, { Memory: Number(m[1]) * 1024 * 1024, MemorySwap: sw ? Number(sw[1]) * 1024 * 1024 : -1 });
      toast({ kind: 'success', title: 'Memory limit raised', message: `${c.name} now has ${m[1]} MB. Start it again to continue.` });
    } catch (e) { toastError('Couldn’t update the limit', e); } finally { setApplying(false); }
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <div className={`detail-icon state-${color === 'yellow' ? 'yellow' : color === 'gray' ? 'gray' : color}`}><AlertOctagon size={24} strokeWidth={1.7} /></div>
        <div className="detail-titles">
          <div className="detail-title"><span className="truncate">{c.name}</span><Pill color={color}>{c.severity}</Pill>{c.occurrences > 1 && <Pill color="orange">×{c.occurrences}</Pill>}</div>
          <div className="detail-sub">{a.title}<span className="sep">·</span>{ago(c.lastT)}<span className="sep">·</span>{c.image || 'unknown image'}</div>
        </div>
        <div className="detail-actions">
          <Capsule>
            {exists && exists.state !== 'running' && <IconButton icon={Play} label="Start container" className="tint-green" onClick={() => containerDo(exists.id, c.name, 'start')} />}
            {exists && <IconButton icon={ExternalLink} label="Open container" onClick={() => navigate(`/containers/${exists.id}/logs`)} />}
            <IconButton icon={Copy} label="Copy report as Markdown" onClick={() => copyText(crashMarkdown(c), 'Report copied - paste it into an issue or chat')} />
            <IconButton icon={Trash2} label="Delete report" onClick={async () => {
              const r = await confirm({ title: 'Delete this report?', message: 'The recorded evidence for this crash will be removed.', confirmLabel: 'Delete', destructive: true });
              if (r.ok) { await deleteCrash(c.id); navigate('/crashes'); }
            }} />
          </Capsule>
        </div>
      </div>

      <div className="detail-body">
        <div className="scroll pad">
          <div className={`verdict verdict-${color}`}>
            <div className="verdict-label">What happened</div>
            <div className="verdict-title">{a.title}</div>
            <div className="verdict-text">{a.summary}</div>
            {c.source === 'scan' && <div className="verdict-note">Found when Docker Inspector started: it was not running when this happened.</div>}
          </div>

          <div className="columns">
            <div className="col">
              <Group title="Evidence" flush>
                {a.evidence.map((e, i) => {
                  const Icon = ICONS[e.icon] || Info;
                  return (
                    <div key={i} className="evidence">
                      <div className={`evidence-icon ev-${e.icon}`}><Icon size={13} strokeWidth={2.2} /></div>
                      <div className="evidence-text">{e.text}</div>
                    </div>
                  );
                })}
              </Group>
            </div>
            <div className="col">
              <Group title="How to fix it" flush>
                {a.suggestions.length === 0 && <div className="group-empty">No specific fix was identified. Check the log lines below.</div>}
                {a.suggestions.map((s, i) => (
                  <div key={i} className="suggestion">
                    <div className="suggestion-icon"><Wrench size={13} strokeWidth={2.2} /></div>
                    <div className="suggestion-body">
                      <div>{s.text}</div>
                      {s.command && (
                        <div className="cmd-box">
                          <code>{s.command}</code>
                          <div className="cmd-actions">
                            <IconButton icon={Copy} size={13} label="Copy command" onClick={() => copyText(s.command!, 'Command copied')} />
                            {exists && s.command.startsWith('docker update --memory') && <Button size="sm" variant="primary" disabled={applying} onClick={() => apply(s.command!)}>Apply</Button>}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </Group>
            </div>
          </div>

          {samples.length > 2 && (
            <div className="card crash-chart">
              <div className="card-head"><div className="card-title"><Activity size={14} /> The {Math.max(1, Math.round((samples[samples.length - 1].t - samples[0].t) / 1000))} seconds before it stopped</div><div className="card-note">recorded once per second</div></div>
              <div className="chart-grid">
                <div>
                  <div className="chart-sub">CPU</div>
                  <HistoryChart from={samples[0].t} to={samples[samples.length - 1].t + 1000} times={samples.map((s) => s.t)} step={1000} height={120} format={(v) => pct(v)} minMax={10} legend={false}
                    series={[{ name: 'CPU', color: 'var(--blue)', values: samples.map((s) => s.cpu) }]} />
                </div>
                <div>
                  <div className="chart-sub">Memory{a.memLimit ? ` (limit ${mem(a.memLimit)})` : ''}</div>
                  <HistoryChart from={samples[0].t} to={samples[samples.length - 1].t + 1000} times={samples.map((s) => s.t)} step={1000} height={120} format={(v) => mem(v)} legend={false}
                    max={a.memLimit || undefined} minMax={32 * 1024 * 1024}
                    series={[{ name: 'Memory', color: 'var(--purple)', values: samples.map((s) => s.mem) }, ...(a.memLimit ? [{ name: 'Limit', color: 'var(--red)', values: samples.map(() => a.memLimit as number), fill: false, dashed: true }] : [])]} />
                </div>
              </div>
            </div>
          )}

          {logs.length > 0 && (
            <Group title={`Last ${logs.length} log lines`} flush footer="The highlighted line is the one the diagnosis is based on. Red-edged lines were written to stderr.">
              <div className="crash-logs" ref={logBox}>
                {logs.map((l, i) => (
                  <div key={i} ref={i === a.logIndex ? highlight : undefined} className={`log-line ${l.stream}${i === a.logIndex ? ' culprit' : ''}`}>
                    <span className="log-gutter" />
                    <span className="log-text">{l.text || ' '}</span>
                  </div>
                ))}
              </div>
            </Group>
          )}

          <div className="columns">
            <div className="col">
              <Group title="Container at the time">
                <Row label="Image" mono>{cfg.image}</Row>
                <Row label="Command" mono>{cfg.command}</Row>
                <Row label="Exit code">{a.exitCode ?? '?'}{a.signal ? ` (${a.signal})` : ''}{a.oom ? ' · OOM killed' : ''}</Row>
                <Row label="Started">{cfg.startedAt && !cfg.startedAt.startsWith('0001') ? date(cfg.startedAt) : ''}</Row>
                <Row label="Stopped">{date(c.finishedAt)}</Row>
                <Row label="Restart policy">{cfg.restartPolicy}{cfg.restartCount ? ` · restarted ${cfg.restartCount}×` : ''}</Row>
                <Row label="Memory limit">{cfg.memoryLimit ? bytes(cfg.memoryLimit, { binary: true }) : 'None'}</Row>
                <Row label="CPU limit">{cfg.cpus ? `${cfg.cpus} CPUs` : 'None'}</Row>
                {cfg.error && <Row label="Docker error"><span className="text-red">{cfg.error}</span></Row>}
                {cfg.health && <Row label="Health">{cfg.health.status}{cfg.health.failingStreak ? ` · failing ${cfg.health.failingStreak}×` : ''}</Row>}
              </Group>
            </div>
            <div className="col">
              {c.previous.length > 0 && (
                <Group title="Earlier crashes of this container" flush>
                  {c.previous.map((p) => (
                    <div key={p.id} className="link-row" onClick={() => navigate(`/crashes/${p.id}`)}>
                      <Box size={13} className="muted" /><span className="truncate">{p.title}</span>{p.occurrences > 1 && <span className="tag-chip">×{p.occurrences}</span>}
                      <span className="flex-1" /><span className="muted small">{ago(p.lastT)}</span>
                    </div>
                  ))}
                </Group>
              )}
              {c.report.events.length > 0 && (
                <Group title="Docker events" flush>
                  {c.report.events.map((e, i) => (
                    <div key={i} className="link-row static">
                      <span className="mono small">{new Date(e.time).toLocaleTimeString()}</span><b>{e.action}</b>
                      {e.attributes.exitCode && <span className="muted small">exit {e.attributes.exitCode}</span>}
                    </div>
                  ))}
                </Group>
              )}
              {cfg.health?.log?.length ? (
                <Group title="Last health checks" flush>
                  {cfg.health.log.map((h, i) => (
                    <div key={i} className="health-log"><div className="health-log-head"><Pill color={h.exitCode === 0 ? 'green' : 'red'}>{h.exitCode === 0 ? 'pass' : `exit ${h.exitCode}`}</Pill><span className="muted">{date(h.end)}</span></div>{h.output && <pre className="health-out">{h.output}</pre>}</div>
                  ))}
                </Group>
              ) : null}
            </div>
          </div>
          {a.ranMs !== null && <div className="muted small">Ran for {nsDuration(a.ranMs * 1e6)} before stopping.</div>}
        </div>
      </div>
    </div>
  );
}
