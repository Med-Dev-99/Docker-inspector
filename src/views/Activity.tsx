import { useMemo, useState } from 'react';
import { Activity, Box, Database, Layers, Network, Play, Square, Skull, Plus, Trash2, Pause, CloudDownload, Tag, Link2, Unlink, RotateCw, HeartPulse, Zap, CircleDot } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Page } from '../components/layout';
import { Empty, SearchField, Segmented, Toggle } from '../components/ui';
import { useEvents, DockerEvent, isAnonymousVolume, isNoiseEvent } from '../lib/docker';
import { navigate } from '../lib/router';
import { ago, time } from '../lib/format';

const TYPE_ICON: Record<string, LucideIcon> = { container: Box, image: Layers, volume: Database, network: Network };

function actionStyle(action: string): { color: string; icon: LucideIcon } {
  const a = action.split(':')[0];
  if (a === 'start' || a === 'unpause') return { color: 'green', icon: Play };
  if (a === 'restart') return { color: 'blue', icon: RotateCw };
  if (a === 'stop') return { color: 'gray', icon: Square };
  if (a === 'die') return { color: 'orange', icon: Square };
  if (a === 'kill' || a === 'oom') return { color: 'red', icon: a === 'oom' ? Skull : Zap };
  if (a === 'create') return { color: 'blue', icon: Plus };
  if (a === 'destroy' || a === 'delete' || a === 'untag' || a === 'remove' || a === 'prune') return { color: 'gray', icon: Trash2 };
  if (a === 'pause') return { color: 'yellow', icon: Pause };
  if (a === 'pull') return { color: 'purple', icon: CloudDownload };
  if (a === 'tag') return { color: 'purple', icon: Tag };
  if (a === 'connect' || a === 'mount') return { color: 'teal', icon: Link2 };
  if (a === 'disconnect' || a === 'unmount') return { color: 'gray', icon: Unlink };
  if (a === 'health_status') return { color: action.includes('unhealthy') ? 'orange' : 'green', icon: HeartPulse };
  return { color: 'gray', icon: CircleDot };
}

function describe(e: DockerEvent): { title: string; to?: string } {
  const at = e.attributes || {};
  const name = at.name || e.actorId?.slice(0, 12);
  switch (e.type) {
    case 'container': return { title: name, to: e.action === 'destroy' ? undefined : `/containers/${e.actorId}` };
    case 'image': return { title: at.name || e.actorId?.replace('sha256:', '').slice(0, 12), to: e.action === 'delete' || e.action === 'untag' ? undefined : `/images/${encodeURIComponent(e.actorId)}` };
    case 'volume': return { title: isAnonymousVolume(e.actorId) ? `${e.actorId.slice(0, 12)}…` : e.actorId, to: e.action === 'destroy' ? undefined : `/volumes/${encodeURIComponent(e.actorId)}` };
    case 'network': return { title: at.name || e.actorId?.slice(0, 12), to: e.action === 'destroy' ? undefined : `/networks/${e.actorId}` };
    default: return { title: name || e.type };
  }
}

function detail(e: DockerEvent) {
  const at = e.attributes || {};
  if (e.type === 'container') {
    if (e.action === 'die') return `exit code ${at.exitCode}`;
    return at.image || '';
  }
  if (e.type === 'network' && at.container) return `container ${at.container.slice(0, 12)}`;
  if (e.type === 'volume' && at.container) return `container ${at.container.slice(0, 12)}${at.destination ? ` → ${at.destination}` : ''}`;
  return '';
}

export function EventRow({ e, compact }: { e: DockerEvent; compact?: boolean }) {
  const st = actionStyle(e.action);
  const d = describe(e);
  const TypeIcon = TYPE_ICON[e.type] || Activity;
  const Icon = st.icon;
  const failed = e.action === 'die' && e.attributes?.exitCode && !['0', '137', '143'].includes(e.attributes.exitCode);
  return (
    <div className={`event${d.to ? ' clickable' : ''}${compact ? ' compact' : ''}`} onClick={() => d.to && navigate(d.to)}>
      <div className={`event-icon bg-soft-${failed ? 'red' : st.color}`}><Icon size={12} strokeWidth={2.4} /></div>
      <div className="event-main">
        <div className="event-title">
          <span className={`event-action text-${failed ? 'red' : st.color}`}>{e.action.replace('health_status: ', 'health: ')}</span>
          <TypeIcon size={12} className="muted" />
          <span className="truncate">{d.title}</span>
        </div>
        {!compact && detail(e) && <div className="event-sub truncate">{detail(e)}</div>}
      </div>
      <div className="event-time" title={new Date(e.time).toLocaleString()}>{compact ? ago(e.time) : time(e.time)}</div>
    </div>
  );
}

export function ActivityView() {
  const { data: events } = useEvents();
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const [noise, setNoise] = useState(false);

  const list = useMemo(() => {
    let l = [...(events || [])].reverse();
    if (!noise) l = l.filter((e) => !isNoiseEvent(e) && !e.action.startsWith('health_status') && !(e.type === 'volume' && (e.action === 'mount' || e.action === 'unmount')) && !(e.type === 'network' && (e.action === 'connect' || e.action === 'disconnect')));
    if (type !== 'all') l = l.filter((e) => e.type === type);
    if (q) { const s = q.toLowerCase(); l = l.filter((e) => e.action.includes(s) || describe(e).title?.toLowerCase().includes(s) || JSON.stringify(e.attributes).toLowerCase().includes(s)); }
    return l.slice(0, 600);
  }, [events, type, q, noise]);

  const days = useMemo(() => {
    const m = new Map<string, DockerEvent[]>();
    for (const e of list) {
      const d = new Date(e.time);
      const today = new Date();
      const yest = new Date(Date.now() - 864e5);
      const key = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === yest.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(e);
    }
    return [...m.entries()];
  }, [list]);

  return (
    <Page title="Activity" subtitle={<><span className="live-dot" /> Live engine events · last 24 hours</>}
      toolbar={<>
        <Toggle checked={noise} onChange={setNoise} label="Include exec, health & mounts" />
        <Segmented value={type} onChange={setType} options={[
          { value: 'all', label: 'All' }, { value: 'container', label: 'Containers' }, { value: 'image', label: 'Images' }, { value: 'volume', label: 'Volumes' }, { value: 'network', label: 'Networks' },
        ]} />
        <SearchField value={q} onChange={setQ} placeholder="Filter events" />
      </>}>
      <div className="scroll pad activity">
        {list.length === 0 && <Empty icon={Activity} title="No events" message="Engine events (start, stop, pull, create…) appear here as they happen." />}
        {days.map(([day, evs]) => (
          <section key={day} className="group">
            <div className="group-head"><div className="group-title">{day}</div><div className="group-actions muted small">{evs.length} events</div></div>
            <div className="group-box flush event-list">{evs.map((e) => <EventRow key={e.id} e={e} />)}</div>
          </section>
        ))}
      </div>
    </Page>
  );
}
