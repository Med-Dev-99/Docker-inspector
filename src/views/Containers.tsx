import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, ChevronRight, Copy, Ellipsis, ExternalLink, FileText, FolderOpen, Layers, Pause, Pencil, Play, Plus, RotateCw,
  Square, SquareTerminal, Trash2, Zap, Info, Activity, ScrollText, Cpu, Settings, Braces, ListTree, Boxes, AlertOctagon, ArrowRight,
} from 'lucide-react';
import { Page, Split } from '../components/layout';
import { Button, Capsule, Empty, IconButton, Loading, Pill, SearchField, Segmented, Spinner, StatusDot, useLocalState, copyText } from '../components/ui';
import { MenuButton, MenuItem, onContextMenu } from '../components/menu';
import { useContainers, useContainer, ContainerSummary, cName, project, service, stateColor, stateLabel, healthOf, uniquePorts, openExternal, portLabel } from '../lib/docker';
import { useAllLatest } from '../lib/stats';
import { navigate, useRoute } from '../lib/router';
import { containerDo, containerRemove, projectDo, projectRemove, useBusy } from '../lib/actions';
import { mem, pct, ago, shortId } from '../lib/format';
import { OverviewTab } from './container/Overview';
import { StatsTab } from './container/Stats';
import { LogsTab } from './container/Logs';
import { TerminalTab } from './container/Terminal';
import { FilesTab } from './container/Files';
import { ProcessesTab } from './container/Processes';
import { ConfigTab } from './container/Config';
import { InspectTab } from './container/Inspect';
import { RenameSheet } from './sheets/Rename';
import { RunContainerSheet } from './sheets/RunContainer';
import { useCrashes } from '../lib/history';

type Filter = 'all' | 'running' | 'stopped';

export const TABS = [
  { value: 'overview', label: 'Overview', icon: Info },
  { value: 'stats', label: 'Stats', icon: Activity },
  { value: 'logs', label: 'Logs', icon: ScrollText },
  { value: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { value: 'files', label: 'Files', icon: FolderOpen },
  { value: 'processes', label: 'Processes', icon: Cpu },
  { value: 'config', label: 'Config', icon: Settings },
  { value: 'inspect', label: 'Inspect', icon: Braces },
] as const;

const stateRank = (s: string) => ({ running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 } as Record<string, number>)[s] ?? 6;

export function ContainersView() {
  const route = useRoute();
  const id = route.parts[1];
  const tab = route.parts[2] || 'overview';
  const projectFilter = route.query.get('project');
  const qs = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : '';
  const { data, isLoading } = useContainers();
  const latest = useAllLatest();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useLocalState<Filter>('containers.filter', 'all');
  const [grouped, setGrouped] = useLocalState('containers.grouped', true);
  const [collapsed, setCollapsed] = useLocalState<Record<string, boolean>>('containers.collapsed', {});
  const [runOpen, setRunOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    let l = data || [];
    if (projectFilter) l = l.filter((c) => project(c.Labels) === projectFilter);
    if (filter === 'running') l = l.filter((c) => c.State === 'running' || c.State === 'paused' || c.State === 'restarting');
    if (filter === 'stopped') l = l.filter((c) => !['running', 'paused', 'restarting'].includes(c.State));
    if (search) {
      const s = search.toLowerCase();
      l = l.filter((c) => cName(c).toLowerCase().includes(s) || c.Image.toLowerCase().includes(s) || c.Id.startsWith(s) || (project(c.Labels) || '').toLowerCase().includes(s));
    }
    return [...l].sort((a, b) => stateRank(a.State) - stateRank(b.State) || cName(a).localeCompare(cName(b)));
  }, [data, filter, search, projectFilter]);

  const groups = useMemo(() => {
    if (!grouped || projectFilter) return [{ key: '', name: '', items: list }];
    const m = new Map<string, ContainerSummary[]>();
    for (const c of list) {
      const p = project(c.Labels) || '';
      if (!m.has(p)) m.set(p, []);
      m.get(p)!.push(c);
    }
    return [...m.entries()]
      .map(([k, items]) => ({ key: k, name: k, items }))
      .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : 0) || Math.min(...a.items.map((c) => stateRank(c.State))) - Math.min(...b.items.map((c) => stateRank(c.State))) || a.key.localeCompare(b.key));
  }, [list, grouped, projectFilter]);

  // keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, .xterm, [contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const flat = groups.flatMap((g) => (collapsed[g.key] && g.key ? [] : g.items));
      if (!flat.length) return;
      e.preventDefault();
      const i = flat.findIndex((c) => c.Id === id);
      const n = e.key === 'ArrowDown' ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1);
      navigate(`/containers/${flat[n].Id}/${tab}${qs}`, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [groups, id, tab, qs, collapsed]);

  const total = projectFilter ? (data || []).filter((c) => project(c.Labels) === projectFilter) : data || [];
  const running = total.filter((c) => c.State === 'running').length;
  const projectItems = projectFilter ? total : [];
  const projectBusy = useBusy(projectFilter ? `project:${projectFilter}` : undefined);

  return (
    <Page
      title={projectFilter || 'Containers'}
      subtitle={data ? `${running} running · ${total.length} total` : undefined}
      toolbar={
        <>
          {projectFilter && (
            <Capsule>
              {projectBusy ? <span className="capsule-busy"><Spinner size={13} /> {projectBusy}…</span> : <>
                <IconButton icon={Play} label="Start all" onClick={() => projectDo(projectFilter, projectItems, 'start')} />
                <IconButton icon={Square} label="Stop all" onClick={() => projectDo(projectFilter, projectItems, 'stop')} />
                <IconButton icon={RotateCw} label="Restart all" onClick={() => projectDo(projectFilter, projectItems, 'restart')} />
                <IconButton icon={Trash2} label="Delete project" onClick={() => projectRemove(projectFilter, projectItems)} />
              </>}
            </Capsule>
          )}
          <Segmented value={filter} onChange={setFilter} options={[
            { value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'stopped', label: 'Stopped' },
          ]} />
          {!projectFilter && (
            <Capsule>
              <IconButton icon={grouped ? Boxes : ListTree} label={grouped ? 'Grouped by project' : 'Flat list'} active={grouped} onClick={() => setGrouped(!grouped)} />
              <IconButton icon={Plus} label="Run a new container" onClick={() => setRunOpen(true)} />
            </Capsule>
          )}
          <SearchField ref={searchRef} value={search} onChange={setSearch} placeholder="Search containers" />
        </>
      }
    >
      <Split
        list={
          <div className="list">
            {isLoading && <Loading />}
            {!isLoading && list.length === 0 && <Empty icon={Box} title={search ? 'No matches' : 'No containers'} message={search ? `Nothing matches “${search}”.` : 'Containers you create will show up here.'} />}
            {groups.map((g) => (
              <div key={g.key || '_'} className="list-group">
                {g.key && (
                  <GroupHeader name={g.name} items={g.items} collapsed={!!collapsed[g.key]}
                    onToggle={() => setCollapsed({ ...collapsed, [g.key]: !collapsed[g.key] })} />
                )}
                {!collapsed[g.key] && g.items.map((c) => (
                  <ContainerRow key={c.Id} c={c} selected={c.Id === id} stats={latest[c.Id]} inGroup={!!g.key}
                    onSelect={() => navigate(`/containers/${c.Id}/${tab}${qs}`)} />
                ))}
              </div>
            ))}
          </div>
        }
        detail={id ? <ContainerDetail key={id} id={id} tab={tab} qs={qs} /> : (
          <Empty icon={Box} title="No container selected" message="Select a container to see its details, live stats, logs and terminal." />
        )}
      />
      <RunContainerSheet open={runOpen} onClose={() => setRunOpen(false)} />
    </Page>
  );
}

function GroupHeader({ name, items, collapsed, onToggle }: { name: string; items: ContainerSummary[]; collapsed: boolean; onToggle: () => void }) {
  const running = items.filter((c) => c.State === 'running').length;
  const busy = useBusy(`project:${name}`);
  const menu: MenuItem[] = [
    { label: 'Show Project', icon: FolderOpen, onClick: () => navigate(`/containers?project=${encodeURIComponent(name)}`) },
    { separator: true },
    { label: 'Start All', icon: Play, onClick: () => projectDo(name, items, 'start') },
    { label: 'Stop All', icon: Square, onClick: () => projectDo(name, items, 'stop') },
    { label: 'Restart All', icon: RotateCw, onClick: () => projectDo(name, items, 'restart') },
    { separator: true },
    { label: 'Delete Project Containers…', icon: Trash2, destructive: true, onClick: () => projectRemove(name, items) },
  ];
  return (
    <div className="group-header" onClick={onToggle} onContextMenu={onContextMenu(menu)}>
      <ChevronRight size={12} strokeWidth={2.6} className={`gh-chev${collapsed ? '' : ' open'}`} />
      <span className="gh-name">{name}</span>
      <span className="gh-count">{running}/{items.length}</span>
      <span className="gh-actions" onClick={(e) => e.stopPropagation()}>
        {busy ? <Spinner size={12} /> : running > 0
          ? <IconButton icon={Square} size={12} label="Stop all" onClick={() => projectDo(name, items, 'stop')} />
          : <IconButton icon={Play} size={12} label="Start all" onClick={() => projectDo(name, items, 'start')} />}
        <MenuButton className="btn-icon" items={menu} title="More"><Ellipsis size={13} /></MenuButton>
      </span>
    </div>
  );
}

export function containerMenu(c: { Id: string; State: string; name: string; image?: string }, tabBase = `/containers/${c.Id}`): MenuItem[] {
  const running = c.State === 'running';
  const paused = c.State === 'paused';
  return [
    ...(running || paused ? [] : [{ label: 'Start', icon: Play, onClick: () => containerDo(c.Id, c.name, 'start') }]),
    ...(running ? [{ label: 'Stop', icon: Square, onClick: () => containerDo(c.Id, c.name, 'stop') }] : []),
    ...(running || paused ? [{ label: 'Restart', icon: RotateCw, onClick: () => containerDo(c.Id, c.name, 'restart') }] : []),
    ...(running ? [{ label: 'Pause', icon: Pause, onClick: () => containerDo(c.Id, c.name, 'pause') }] : []),
    ...(paused ? [{ label: 'Resume', icon: Play, onClick: () => containerDo(c.Id, c.name, 'unpause') }] : []),
    ...(running ? [{ label: 'Kill', icon: Zap, onClick: () => containerDo(c.Id, c.name, 'kill') }] : []),
    { separator: true },
    { label: 'Logs', icon: FileText, onClick: () => navigate(`${tabBase}/logs`) },
    { label: 'Terminal', icon: SquareTerminal, disabled: !running, onClick: () => navigate(`${tabBase}/terminal`) },
    { label: 'Files', icon: FolderOpen, disabled: !running, onClick: () => navigate(`${tabBase}/files`) },
    { separator: true },
    { label: 'Copy ID', icon: Copy, onClick: () => copyText(c.Id, 'Container ID copied') },
    { label: 'Copy Name', icon: Copy, onClick: () => copyText(c.name, 'Name copied') },
    ...(c.image ? [{ label: 'Go to Image', icon: Layers, onClick: () => navigate(`/images/${encodeURIComponent(c.image!)}`) }] : []),
    { separator: true },
    { label: 'Delete…', icon: Trash2, destructive: true, onClick: () => containerRemove(c.Id, c.name, running || paused, '/containers') },
  ];
}

function ContainerRow({ c, selected, stats, inGroup, onSelect }: { c: ContainerSummary; selected: boolean; stats?: { cpu: number; mem: number }; inGroup: boolean; onSelect: () => void }) {
  const name = cName(c);
  const svc = service(c.Labels);
  const title = inGroup && svc ? svc : name;
  const color = stateColor(c.State, c.Status);
  const busy = useBusy(c.Id);
  const health = healthOf(c.Status);
  const exited = c.Status.match(/^Exited \((\d+)\) (.*)$/);
  const statusText = exited ? `Exited (${exited[1]}) · ${exited[2]}` : c.Status;
  return (
    <div className={`list-row${selected ? ' selected' : ''}${inGroup ? ' indented' : ''}`} onClick={onSelect}
      onContextMenu={onContextMenu(() => containerMenu({ Id: c.Id, State: c.State, name, image: c.ImageID }))}>
      <div className="lr-lead">{busy ? <Spinner size={10} /> : <StatusDot color={color} pulse={c.State === 'restarting'} />}</div>
      <div className="lr-main">
        <div className="lr-title">
          <span className="truncate">{title}</span>
          {health === 'unhealthy' && <Pill color="orange">unhealthy</Pill>}
        </div>
        <div className="lr-sub truncate">{busy ? `${busy}…` : <>{c.Image.replace(/^sha256:/, '').slice(0, 48)} · {statusText}</>}</div>
      </div>
      {c.State === 'running' && stats && (
        <div className="lr-side">
          <span className="lr-metric">{pct(stats.cpu)}</span>
          <span className="lr-metric dim">{mem(stats.mem)}</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ detail
function ContainerDetail({ id, tab, qs }: { id: string; tab: string; qs: string }) {
  const { data: c, isLoading, error } = useContainer(id);
  const busy = useBusy(c?.Id);
  const [renameOpen, setRenameOpen] = useState(false);
  const { data: crashData } = useCrashes();
  if (isLoading) return <Loading />;
  if (error || !c) return <Empty icon={Box} title="Container not found" message="It may have been removed." action={<Button onClick={() => navigate('/containers')}>Back to Containers</Button>} />;

  const name = c.Name.replace(/^\//, '');
  const state: string = c.State.Status;
  const running = state === 'running';
  const paused = state === 'paused';
  const health = c.State.Health?.Status;
  const color = stateColor(state, health === 'unhealthy' ? '(unhealthy)' : health === 'starting' ? 'health: starting' : c.State.ExitCode ? `Exited (${c.State.ExitCode})` : '');
  const ports = uniquePorts(Object.entries(c.NetworkSettings?.Ports || {}).flatMap(([k, v]: [string, any]) => {
    const [port, proto] = k.split('/');
    return (v || []).map((b: any) => ({ PrivatePort: Number(port), PublicPort: Number(b.HostPort), Type: proto, IP: b.HostIp }));
  }));
  const go = (t: string) => navigate(`/containers/${id}/${t}${qs}`);
  const lastCrash = (crashData?.crashes || []).find((x) => x.name === name && Date.now() - x.lastT < 3 * 86400_000);
  const since = running ? `Up ${ago(c.State.StartedAt).replace(' ago', '')}` : state === 'exited' ? `Exited ${ago(c.State.FinishedAt)} · code ${c.State.ExitCode}` : stateLabel(state);

  return (
    <div className="detail">
      <div className="detail-head">
        <div className={`detail-icon state-${color}`}><Box size={24} strokeWidth={1.7} /></div>
        <div className="detail-titles">
          <div className="detail-title">
            <span className="truncate">{name}</span>
            <Pill color={color}>{stateLabel(state)}</Pill>
            {health && <Pill color={health === 'healthy' ? 'green' : health === 'unhealthy' ? 'orange' : 'yellow'}>{health}</Pill>}
          </div>
          <div className="detail-sub">
            <a className="link" href={`#/images/${encodeURIComponent(c.Image)}`}>{c.Config.Image}</a>
            <span className="sep">·</span><span className="mono">{shortId(c.Id)}</span>
            <span className="sep">·</span><span>{since}</span>
          </div>
        </div>
        <div className="detail-actions">
          {busy ? <span className="capsule capsule-busy"><Spinner size={13} /> {busy}…</span> : (
            <Capsule>
              {!running && !paused && <IconButton icon={Play} label="Start" onClick={() => containerDo(id, name, 'start')} className="tint-green" />}
              {running && <IconButton icon={Square} label="Stop" onClick={() => containerDo(id, name, 'stop')} />}
              {(running || paused) && <IconButton icon={RotateCw} label="Restart" onClick={() => containerDo(id, name, 'restart')} />}
              {running && <IconButton icon={Pause} label="Pause" onClick={() => containerDo(id, name, 'pause')} />}
              {paused && <IconButton icon={Play} label="Resume" onClick={() => containerDo(id, name, 'unpause')} />}
              <IconButton icon={Trash2} label="Delete" onClick={() => containerRemove(id, name, running || paused, `/containers${qs}`)} />
              <MenuButton className="btn-icon" title="More" items={() => [
                ...containerMenu({ Id: id, State: state, name, image: c.Image }).filter((i) => 'label' in i && ['Kill', 'Copy ID', 'Copy Name', 'Go to Image'].includes(i.label)),
                { label: 'Rename…', icon: Pencil, onClick: () => setRenameOpen(true) },
              ]}><Ellipsis size={16} /></MenuButton>
            </Capsule>
          )}
        </div>
      </div>
      {lastCrash && (
        <div className={`crash-banner${running ? ' recovered' : ''}`} onClick={() => navigate(`/crashes/${lastCrash.id}`)}>
          <AlertOctagon size={15} />
          <span><b>{running ? 'Crashed and restarted' : 'Crashed'} {ago(lastCrash.lastT)}</b>{lastCrash.occurrences > 1 ? ` (${lastCrash.occurrences} times)` : ''}: {lastCrash.title}.</span>
          <span className="flex-1" /><span className="crash-banner-link">See why <ArrowRight size={12} /></span>
        </div>
      )}
      {ports.some((p) => p.PublicPort) && (
        <div className="detail-ports">
          {ports.filter((p) => p.PublicPort).map((p) => (
            <button key={`${p.PublicPort}${p.Type}${p.PrivatePort}`} className="port-chip" title={`Open http://localhost:${p.PublicPort}`}
              onClick={() => openExternal(`http://localhost:${p.PublicPort}`)}>
              <span>{portLabel(p)}</span><ExternalLink size={11} strokeWidth={2.2} />
            </button>
          ))}
        </div>
      )}
      <div className="detail-tabs">
        <Segmented value={tab} onChange={go} options={TABS.map((t) => ({ value: t.value, label: t.label, icon: t.icon }))} />
      </div>
      <div className={`detail-body tab-${tab}`}>
        {tab === 'overview' && <OverviewTab c={c} />}
        {tab === 'stats' && <StatsTab c={c} />}
        {tab === 'logs' && <LogsTab c={c} />}
        {tab === 'terminal' && <TerminalTab c={c} />}
        {tab === 'files' && <FilesTab c={c} />}
        {tab === 'processes' && <ProcessesTab c={c} />}
        {tab === 'config' && <ConfigTab c={c} />}
        {tab === 'inspect' && <InspectTab data={c} name={name} />}
      </div>
      <RenameSheet open={renameOpen} onClose={() => setRenameOpen(false)} id={id} name={name} />
    </div>
  );
}
