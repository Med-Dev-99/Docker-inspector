import { useMemo, useState } from 'react';
import { Box, Copy, Database, FolderOpen, Plus, Sparkles, Trash2, ArrowDownWideNarrow } from 'lucide-react';
import { Page, Split } from '../components/layout';
import { Capsule, Empty, Group, IconButton, Loading, Pill, Row, SearchField, Segmented, Spinner, StatusDot, copyText, useLocalState, Button } from '../components/ui';
import { MenuButton, onContextMenu } from '../components/menu';
import { useVolumes, useContainers, useDf, isAnonymousVolume, cName, stateColor, project, Volume } from '../lib/docker';
import { navigate, useRoute } from '../lib/router';
import { volumeRemove, useBusy } from '../lib/actions';
import { ago, bytes, date } from '../lib/format';
import { CreateVolumeSheet } from './sheets/CreateVolume';
import { PruneSheet } from './sheets/Prune';
import { InspectTab } from './container/Inspect';

type Filter = 'all' | 'used' | 'unused';

const volLabel = (name: string) => (isAnonymousVolume(name) ? `${name.slice(0, 12)}…` : name);

export function VolumesView() {
  const route = useRoute();
  const name = route.parts[1];
  const { data: volumes, isLoading } = useVolumes();
  const { data: containers } = useContainers();
  const { data: df, isFetching: dfLoading } = useDf();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useLocalState<Filter>('volumes.filter', 'all');
  const [sort, setSort] = useLocalState<'size' | 'name' | 'created'>('volumes.sort', 'size');
  const [createOpen, setCreateOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);

  const sizes = useMemo(() => new Map((df?.Volumes || []).map((v) => [v.Name, v.UsageData?.Size ?? -1])), [df]);
  const users = useMemo(() => {
    const m = new Map<string, { id: string; name: string; state: string; status: string; dest: string }[]>();
    for (const c of containers || []) for (const mt of c.Mounts || []) {
      if (mt.Type !== 'volume' || !mt.Name) continue;
      if (!m.has(mt.Name)) m.set(mt.Name, []);
      m.get(mt.Name)!.push({ id: c.Id, name: cName(c), state: c.State, status: c.Status, dest: mt.Destination });
    }
    return m;
  }, [containers]);

  const list = useMemo(() => {
    let l = volumes || [];
    if (filter === 'used') l = l.filter((v) => users.has(v.Name));
    if (filter === 'unused') l = l.filter((v) => !users.has(v.Name));
    if (search) { const s = search.toLowerCase(); l = l.filter((v) => v.Name.toLowerCase().includes(s) || (project(v.Labels) || '').toLowerCase().includes(s)); }
    const r = [...l];
    if (sort === 'size') r.sort((a, b) => (sizes.get(b.Name) ?? 0) - (sizes.get(a.Name) ?? 0));
    if (sort === 'name') r.sort((a, b) => Number(isAnonymousVolume(a.Name)) - Number(isAnonymousVolume(b.Name)) || a.Name.localeCompare(b.Name));
    if (sort === 'created') r.sort((a, b) => (b.CreatedAt || '').localeCompare(a.CreatedAt || ''));
    return r;
  }, [volumes, filter, search, users, sort, sizes]);

  const total = [...sizes.values()].reduce((a, s) => a + Math.max(0, s), 0);
  const max = Math.max(1, ...list.map((v) => sizes.get(v.Name) ?? 0));
  const selected = volumes?.find((v) => v.Name === name);

  return (
    <Page title="Volumes" subtitle={volumes ? `${volumes.length} volumes${df ? ` · ${bytes(total)}` : dfLoading ? ' · measuring…' : ''}` : undefined}
      toolbar={<>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'used', label: 'In Use' }, { value: 'unused', label: 'Unused' }]} />
        <Capsule>
          <MenuButton className="btn-icon" title="Sort" items={[
            { header: true, label: 'Sort by' },
            { label: 'Size', checked: sort === 'size', onClick: () => setSort('size') },
            { label: 'Name', checked: sort === 'name', onClick: () => setSort('name') },
            { label: 'Date created', checked: sort === 'created', onClick: () => setSort('created') },
          ]}><ArrowDownWideNarrow size={16} strokeWidth={1.9} /></MenuButton>
          <IconButton icon={Plus} label="New volume" onClick={() => setCreateOpen(true)} />
          <IconButton icon={Sparkles} label="Clean up unused volumes" onClick={() => setPruneOpen(true)} />
        </Capsule>
        <SearchField value={search} onChange={setSearch} placeholder="Search volumes" />
      </>}>
      <Split
        list={
          <div className="list">
            {isLoading && <Loading />}
            {!isLoading && list.length === 0 && <Empty icon={Database} title="No volumes" />}
            {list.map((v) => {
              const u = users.get(v.Name) || [];
              const size = sizes.get(v.Name);
              const anon = isAnonymousVolume(v.Name);
              return (
                <div key={v.Name} className={`list-row${v.Name === name ? ' selected' : ''}`} onClick={() => navigate(`/volumes/${encodeURIComponent(v.Name)}`)}
                  onContextMenu={onContextMenu([
                    { label: 'Copy Name', icon: Copy, onClick: () => copyText(v.Name, 'Volume name copied') },
                    { label: 'Copy Mountpoint', icon: Copy, onClick: () => copyText(v.Mountpoint, 'Mountpoint copied') },
                    { separator: true },
                    { label: 'Delete…', icon: Trash2, destructive: true, disabled: u.length > 0, onClick: () => volumeRemove(v.Name, volLabel(v.Name)).then((ok) => ok && navigate('/volumes')) },
                  ])}>
                  <div className="lr-lead"><div className={`mini-icon ${u.length ? 'orange' : 'orange-soft'}`}><Database size={13} strokeWidth={2} /></div></div>
                  <div className="lr-main">
                    <div className="lr-title"><span className={`truncate${anon ? ' mono' : ''}`}>{volLabel(v.Name)}</span>{anon && <span className="tag-chip">anonymous</span>}</div>
                    <div className="lr-sub truncate">{project(v.Labels) ? `${project(v.Labels)} · ` : ''}{v.Driver}{u.length ? ` · ${u.map((x) => x.name).join(', ')}` : ' · not used'}</div>
                    {size !== undefined && size > 0 && <div className="size-bar orange"><div style={{ width: `${Math.max(2, (size / max) * 100)}%` }} /></div>}
                  </div>
                  <div className="lr-side">
                    <span className="lr-metric">{size === undefined ? (dfLoading ? <Spinner size={10} /> : '—') : size < 0 ? 'n/a' : bytes(size)}</span>
                    {u.length ? <Pill color="green">in use</Pill> : <Pill color="gray">unused</Pill>}
                  </div>
                </div>
              );
            })}
          </div>
        }
        detail={selected ? <VolumeDetail key={selected.Name} v={selected} size={sizes.get(selected.Name)} users={users.get(selected.Name) || []} />
          : name && !isLoading ? <Empty icon={Database} title="Volume not found" /> : <Empty icon={Database} title="No volume selected" message="Select a volume to see its size, mountpoint and which containers use it." />}
      />
      <CreateVolumeSheet open={createOpen} onClose={() => setCreateOpen(false)} />
      <PruneSheet open={pruneOpen} onClose={() => setPruneOpen(false)} preset={{ containers: false, images: false, networks: false, cache: false, volumes: true }} />
    </Page>
  );
}

function VolumeDetail({ v, size, users }: { v: Volume; size?: number; users: { id: string; name: string; state: string; status: string; dest: string }[] }) {
  const busy = useBusy(v.Name);
  const [tab, setTab] = useState<'overview' | 'inspect'>('overview');
  const browsable = users.find((u) => u.state === 'running');
  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-icon state-orange"><Database size={24} strokeWidth={1.7} /></div>
        <div className="detail-titles">
          <div className="detail-title"><span className="truncate">{volLabel(v.Name)}</span>{users.length ? <Pill color="green">in use</Pill> : <Pill color="gray">unused</Pill>}</div>
          <div className="detail-sub">{v.Driver}<span className="sep">·</span>{size !== undefined && size >= 0 ? bytes(size) : 'size unknown'}<span className="sep">·</span>created {ago(v.CreatedAt)}</div>
        </div>
        <div className="detail-actions">
          {busy ? <span className="capsule capsule-busy"><Spinner size={13} /> {busy}…</span> : (
            <Capsule>
              {browsable && <IconButton icon={FolderOpen} label={`Browse files in ${browsable.name}`} onClick={() => navigate(`/containers/${browsable.id}/files?path=${encodeURIComponent(browsable.dest)}`)} />}
              <IconButton icon={Copy} label="Copy name" onClick={() => copyText(v.Name, 'Volume name copied')} />
              <IconButton icon={Trash2} label={users.length ? 'In use — remove containers first' : 'Delete'} disabled={users.length > 0}
                onClick={() => volumeRemove(v.Name, volLabel(v.Name)).then((ok) => ok && navigate('/volumes'))} />
            </Capsule>
          )}
        </div>
      </div>
      <div className="detail-tabs">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'inspect', label: 'Inspect' }]} />
      </div>
      <div className="detail-body">
        {tab === 'overview' ? (
          <div className="scroll pad">
            <div className="columns">
              <div className="col">
                <Group title="Volume">
                  <Row label="Name" mono copy={v.Name}>{v.Name}</Row>
                  <Row label="Driver">{v.Driver}</Row>
                  <Row label="Scope">{v.Scope}</Row>
                  <Row label="Size">{size !== undefined && size >= 0 ? bytes(size) : '—'}</Row>
                  <Row label="Created">{date(v.CreatedAt)}</Row>
                  <Row label="Mountpoint" mono copy={v.Mountpoint}>{v.Mountpoint}</Row>
                  {project(v.Labels) && <Row label="Compose project">{project(v.Labels)}</Row>}
                </Group>
                {Object.keys(v.Options || {}).length > 0 && (
                  <Group title="Driver options">{Object.entries(v.Options!).map(([k, val]) => <Row key={k} label={k} mono>{val}</Row>)}</Group>
                )}
              </div>
              <div className="col">
                <Group title={`Used by ${users.length} container${users.length === 1 ? '' : 's'}`} flush>
                  {users.length === 0 ? <div className="group-empty">No containers mount this volume. It is safe to delete if you don’t need its data.</div> : users.map((u) => (
                    <div key={u.id} className="link-row" onClick={() => navigate(`/containers/${u.id}`)}>
                      <StatusDot color={stateColor(u.state, u.status)} /><Box size={13} className="muted" /><span className="truncate">{u.name}</span>
                      <span className="flex-1" /><span className="mono small muted">{u.dest}</span>
                    </div>
                  ))}
                </Group>
                {Object.keys(v.Labels || {}).length > 0 && (
                  <Group title="Labels" flush>
                    <table className="table kv-table"><tbody>{Object.entries(v.Labels!).map(([k, val]) => <tr key={k}><td className="mono kv-key">{k}</td><td className="mono kv-val">{val}</td></tr>)}</tbody></table>
                  </Group>
                )}
                {browsable && <Button icon={FolderOpen} onClick={() => navigate(`/containers/${browsable.id}/files?path=${encodeURIComponent(browsable.dest)}`)}>Browse files via {browsable.name}</Button>}
              </div>
            </div>
          </div>
        ) : <InspectTab data={v} name={v.Name} />}
      </div>
    </div>
  );
}
