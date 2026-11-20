import { useEffect, useMemo, useState } from 'react';
import { CloudDownload, Copy, Ellipsis, Layers, Play, RefreshCw, Sparkles, Tag, Trash2, Box, ArrowDownWideNarrow } from 'lucide-react';
import { Page, Split } from '../components/layout';
import { Button, Capsule, Empty, Group, IconButton, Loading, Pill, Row, SearchField, Segmented, Spinner, StatusDot, copyText, useLocalState } from '../components/ui';
import { MenuButton, MenuItem, onContextMenu } from '../components/menu';
import { useImages, useImage, useImageHistory, useContainers, useDf, dfSummary, imageName, isDangling, ImageSummary, cName, stateColor } from '../lib/docker';
import { navigate, useRoute } from '../lib/router';
import { imageRemove, useBusy } from '../lib/actions';
import { ago, bytes, cmd, date, shortId } from '../lib/format';
import { PullImageSheet } from './sheets/PullImage';
import { RunContainerSheet } from './sheets/RunContainer';
import { TagSheet } from './sheets/Tag';
import { PruneSheet } from './sheets/Prune';
import { InspectTab } from './container/Inspect';

type Filter = 'all' | 'used' | 'unused' | 'dangling';
type Sort = 'size' | 'unique' | 'created' | 'name';

export function ImagesView() {
  const route = useRoute();
  const id = route.parts[1];
  const { data: images, isLoading } = useImages();
  const { data: containers } = useContainers();
  const { data: df } = useDf();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useLocalState<Filter>('images.filter', 'all');
  const [sort, setSort] = useLocalState<Sort>('images.sort', 'size');
  const [pullOpen, setPullOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);

  // Exclusive bytes per image (what deleting it would actually free), from `system df`.
  const unique = useMemo(() => new Map((df?.Images || []).map((i) => [i.Id, Math.max(0, i.Size - Math.max(0, i.SharedSize))])), [df]);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of containers || []) m.set(c.ImageID, (m.get(c.ImageID) || 0) + 1);
    return m;
  }, [containers]);

  const list = useMemo(() => {
    let l = images || [];
    if (filter === 'used') l = l.filter((i) => usage.has(i.Id));
    if (filter === 'unused') l = l.filter((i) => !usage.has(i.Id));
    if (filter === 'dangling') l = l.filter(isDangling);
    if (search) {
      const s = search.toLowerCase();
      l = l.filter((i) => (i.RepoTags || []).some((t) => t.toLowerCase().includes(s)) || i.Id.replace('sha256:', '').startsWith(s));
    }
    const sorted = [...l];
    if (sort === 'size') sorted.sort((a, b) => b.Size - a.Size);
    if (sort === 'unique') sorted.sort((a, b) => (unique.get(b.Id) ?? b.Size) - (unique.get(a.Id) ?? a.Size));
    if (sort === 'created') sorted.sort((a, b) => b.Created - a.Created);
    if (sort === 'name') sorted.sort((a, b) => imageName(a).localeCompare(imageName(b)));
    return sorted;
  }, [images, filter, search, sort, usage, unique]);

  const summary = dfSummary(df);
  const selected = images?.find((i) => i.Id === id || (i.RepoTags || []).includes(id || ''));

  return (
    <Page title="Images" subtitle={images ? `${images.length} images${summary ? ` · ${bytes(summary.images.size)} on disk · ${bytes(summary.images.reclaimable)} reclaimable` : ''}` : undefined}
      toolbar={<>
        <Segmented value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'used', label: 'In Use' }, { value: 'unused', label: 'Unused' }, { value: 'dangling', label: 'Dangling' },
        ]} />
        <Capsule>
          <MenuButton className="btn-icon" title="Sort" items={[
            { header: true, label: 'Sort by' },
            { label: 'Size', checked: sort === 'size', onClick: () => setSort('size') },
            { label: 'Space freed if deleted', checked: sort === 'unique', onClick: () => setSort('unique') },
            { label: 'Date created', checked: sort === 'created', onClick: () => setSort('created') },
            { label: 'Name', checked: sort === 'name', onClick: () => setSort('name') },
          ]}><ArrowDownWideNarrow size={16} strokeWidth={1.9} /></MenuButton>
          <IconButton icon={CloudDownload} label="Pull image" onClick={() => setPullOpen(true)} />
          <IconButton icon={Sparkles} label="Clean up unused images" onClick={() => setPruneOpen(true)} />
        </Capsule>
        <SearchField value={search} onChange={setSearch} placeholder="Search images" />
      </>}>
      <Split
        list={
          <div className="list">
            {isLoading && <Loading />}
            {!isLoading && list.length === 0 && <Empty icon={Layers} title="No images" message={search ? 'No images match your search.' : 'Pull an image to get started.'} />}
            {list.map((i) => <ImageRow key={i.Id} img={i} used={usage.get(i.Id) || 0} unique={unique.get(i.Id)} selected={selected?.Id === i.Id} max={Math.max(1, ...list.slice(0, 50).map((x) => x.Size))} />)}
          </div>
        }
        detail={id ? <ImageDetail key={id} id={selected?.Id || id} summary={selected} unique={selected ? unique.get(selected.Id) : undefined} /> : <Empty icon={Layers} title="No image selected" message="Select an image to see its layers, configuration and the containers using it." />}
      />
      <PullImageSheet open={pullOpen} onClose={() => setPullOpen(false)} />
      <PruneSheet open={pruneOpen} onClose={() => setPruneOpen(false)} preset={{ containers: false, networks: false, cache: false, images: true }} />
    </Page>
  );
}

function imageMenu(img: ImageSummary, label: string, opts: { onRun: () => void; onTag: () => void; onPull: () => void }): MenuItem[] {
  return [
    { label: 'Run…', icon: Play, onClick: opts.onRun },
    { label: 'Pull latest', icon: RefreshCw, disabled: isDangling(img), onClick: opts.onPull },
    { label: 'Add Tag…', icon: Tag, onClick: opts.onTag },
    { separator: true },
    { label: 'Copy ID', icon: Copy, onClick: () => copyText(img.Id, 'Image ID copied') },
    { label: 'Copy Name', icon: Copy, onClick: () => copyText(label, 'Name copied') },
    { separator: true },
    { label: 'Delete…', icon: Trash2, destructive: true, onClick: () => imageRemove(img.Id, label).then((ok) => ok && navigate('/images')) },
  ];
}

function ImageRow({ img, used, unique, selected, max }: { img: ImageSummary; used: number; unique?: number; selected: boolean; max: number }) {
  const label = imageName(img);
  const busy = useBusy(img.Id);
  const dangling = isDangling(img);
  const [repo, tag] = label.includes(':') ? [label.slice(0, label.lastIndexOf(':')), label.slice(label.lastIndexOf(':') + 1)] : [label, ''];
  return (
    <div className={`list-row${selected ? ' selected' : ''}`} onClick={() => navigate(`/images/${encodeURIComponent(img.Id)}`)}
      onContextMenu={onContextMenu(() => imageMenu(img, label, { onRun: () => navigate(`/images/${encodeURIComponent(img.Id)}?run=1`), onTag: () => navigate(`/images/${encodeURIComponent(img.Id)}?tag=1`), onPull: () => navigate(`/images/${encodeURIComponent(img.Id)}?pull=1`) }))}>
      <div className="lr-lead"><div className={`mini-icon ${dangling ? 'gray' : used ? 'purple' : 'purple-soft'}`}><Layers size={13} strokeWidth={2} /></div></div>
      <div className="lr-main">
        <div className="lr-title">
          <span className="truncate">{dangling ? <span className="muted">&lt;none&gt;</span> : repo}</span>
          {tag && !dangling && <span className="tag-chip">{tag}</span>}
          {(img.RepoTags?.length || 0) > 1 && <span className="muted small">+{img.RepoTags!.length - 1}</span>}
        </div>
        <div className="lr-sub truncate">{busy ? `${busy}…` : <>{shortId(img.Id)} · {ago(img.Created * 1000)}{unique !== undefined && unique < img.Size * 0.95 ? ` · ${bytes(unique)} unique` : ''}{used ? ` · ${used} container${used > 1 ? 's' : ''}` : ''}</>}</div>
        <div className="size-bar"><div style={{ width: `${Math.max(2, (img.Size / max) * 100)}%` }} /></div>
      </div>
      <div className="lr-side">
        <span className="lr-metric">{bytes(img.Size)}</span>
        {used ? <Pill color="green">in use</Pill> : dangling ? <Pill color="gray">dangling</Pill> : <Pill color="gray">unused</Pill>}
      </div>
    </div>
  );
}

function ImageDetail({ id, summary, unique }: { id: string; summary?: ImageSummary; unique?: number }) {
  const route = useRoute();
  const { data: img, isLoading, error } = useImage(id);
  const { data: history } = useImageHistory(id);
  const { data: containers } = useContainers();
  const [tab, setTab] = useState<'overview' | 'layers' | 'inspect'>('overview');
  const [runOpen, setRunOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  useEffect(() => {
    const qy = route.query;
    if (!qy.toString()) return;
    if (qy.get('run')) setRunOpen(true);
    if (qy.get('tag')) setTagOpen(true);
    if (qy.get('pull')) setPullOpen(true);
    navigate(`/${route.parts.map(encodeURIComponent).join('/')}`, true);
  }, [route.raw]);
  const busy = useBusy(img?.Id);
  if (isLoading) return <Loading />;
  if (error || !img) return <Empty icon={Layers} title="Image not found" message="It may have been deleted." />;

  const label = summary ? imageName(summary) : img.RepoTags?.[0] || shortId(img.Id);
  const using = (containers || []).filter((c) => c.ImageID === img.Id);
  const cfg = img.Config || {};
  const maxLayer = Math.max(1, ...(history || []).map((h) => h.Size));

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-icon state-purple"><Layers size={24} strokeWidth={1.7} /></div>
        <div className="detail-titles">
          <div className="detail-title"><span className="truncate">{label}</span>{using.length > 0 ? <Pill color="green">in use</Pill> : <Pill color="gray">unused</Pill>}</div>
          <div className="detail-sub"><span className="mono">{shortId(img.Id)}</span><span className="sep">·</span>{bytes(img.Size)}<span className="sep">·</span>{img.Os}/{img.Architecture}{img.Variant ? `/${img.Variant}` : ''}<span className="sep">·</span>created {ago(img.Created)}</div>
        </div>
        <div className="detail-actions">
          {busy ? <span className="capsule capsule-busy"><Spinner size={13} /> {busy}…</span> : (
            <Capsule>
              <IconButton icon={Play} label="Run…" className="tint-green" onClick={() => setRunOpen(true)} />
              <IconButton icon={RefreshCw} label="Pull latest" disabled={!img.RepoTags?.length} onClick={() => setPullOpen(true)} />
              <IconButton icon={Trash2} label="Delete" onClick={() => imageRemove(img.Id, label).then((ok) => ok && navigate('/images'))} />
              <MenuButton className="btn-icon" title="More" items={[
                { label: 'Add Tag…', icon: Tag, onClick: () => setTagOpen(true) },
                { label: 'Copy ID', icon: Copy, onClick: () => copyText(img.Id, 'Image ID copied') },
                ...(img.RepoDigests?.[0] ? [{ label: 'Copy Digest', icon: Copy, onClick: () => copyText(img.RepoDigests[0], 'Digest copied') }] : []),
              ]}><Ellipsis size={16} /></MenuButton>
            </Capsule>
          )}
        </div>
      </div>
      {(img.RepoTags?.length || 0) > 0 && (
        <div className="detail-ports">{img.RepoTags.map((t: string) => <span key={t} className="tag-chip lg">{t}</span>)}</div>
      )}
      <div className="detail-tabs">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'layers', label: `Layers (${history?.length ?? '…'})` }, { value: 'inspect', label: 'Inspect' }]} />
      </div>
      <div className="detail-body">
        {tab === 'overview' && (
          <div className="scroll pad">
            <div className="columns">
              <div className="col">
                <Group title="Image">
                  <Row label="ID" mono copy={img.Id}>{shortId(img.Id)}</Row>
                  <Row label="Size">{bytes(img.Size)}</Row>
                  {unique !== undefined && <Row label="Unique size" hint="freed if deleted">{bytes(unique)}{img.Size - unique > 0 && <span className="muted"> · {bytes(img.Size - unique)} shared with other images</span>}</Row>}
                  <Row label="Created">{date(img.Created)}</Row>
                  <Row label="Platform">{img.Os}/{img.Architecture}{img.Variant ? `/${img.Variant}` : ''}</Row>
                  <Row label="Layers">{String(img.RootFS?.Layers?.length ?? '—')}</Row>
                  <Row label="Author">{img.Author}</Row>
                  <Row label="Built with">{img.DockerVersion ? `Docker ${img.DockerVersion}` : img.Metadata ? 'BuildKit' : ''}</Row>
                  {img.RepoDigests?.[0] && <Row label="Digest" mono copy={img.RepoDigests[0]}>{img.RepoDigests[0].split('@')[1]?.slice(0, 24)}…</Row>}
                  {img.Metadata?.LastTagTime && toMsSafe(img.Metadata.LastTagTime) && <Row label="Last tagged">{date(img.Metadata.LastTagTime)}</Row>}
                </Group>
                <Group title="Default configuration">
                  <Row label="Entrypoint" mono>{cmd(cfg.Entrypoint)}</Row>
                  <Row label="Command" mono>{cmd(cfg.Cmd)}</Row>
                  <Row label="Working dir" mono>{cfg.WorkingDir}</Row>
                  <Row label="User" mono>{cfg.User}</Row>
                  <Row label="Exposed ports" mono>{Object.keys(cfg.ExposedPorts || {}).join(', ')}</Row>
                  <Row label="Volumes" mono>{Object.keys(cfg.Volumes || {}).join(', ')}</Row>
                  <Row label="Stop signal" mono>{cfg.StopSignal}</Row>
                  {cfg.Healthcheck && <Row label="Health check" mono>{(cfg.Healthcheck.Test || []).slice(1).join(' ')}</Row>}
                </Group>
              </div>
              <div className="col">
                <Group title={`Used by ${using.length} container${using.length === 1 ? '' : 's'}`} flush>
                  {using.length === 0 ? <div className="group-empty">No containers use this image.</div> : using.map((c) => (
                    <div key={c.Id} className="link-row" onClick={() => navigate(`/containers/${c.Id}`)}>
                      <StatusDot color={stateColor(c.State, c.Status)} /><Box size={13} className="muted" /><span className="truncate">{cName(c)}</span><span className="flex-1" /><span className="muted small">{c.Status}</span>
                    </div>
                  ))}
                </Group>
                <Group title={`Environment (${(cfg.Env || []).length})`} flush>
                  {(cfg.Env || []).length === 0 ? <div className="group-empty">None</div> : (
                    <table className="table kv-table"><tbody>{(cfg.Env || []).map((e: string) => { const i = e.indexOf('='); return <tr key={e}><td className="mono kv-key">{e.slice(0, i)}</td><td className="mono kv-val">{e.slice(i + 1)}</td></tr>; })}</tbody></table>
                  )}
                </Group>
                {Object.keys(cfg.Labels || {}).length > 0 && (
                  <Group title="Labels" flush>
                    <table className="table kv-table"><tbody>{Object.entries(cfg.Labels).map(([k, v]) => <tr key={k}><td className="mono kv-key">{k}</td><td className="mono kv-val">{String(v)}</td></tr>)}</tbody></table>
                  </Group>
                )}
              </div>
            </div>
          </div>
        )}
        {tab === 'layers' && (
          <div className="scroll pad">
            <Group title="Build history" flush footer="Newest layer first. Size is the data added by each step.">
              {(history || []).map((h, i) => (
                <div key={i} className="layer-row">
                  <div className="layer-size">
                    <span className={h.Size ? '' : 'muted'}>{h.Size ? bytes(h.Size) : '0 B'}</span>
                    <div className="size-bar"><div style={{ width: `${h.Size ? Math.max(2, (h.Size / maxLayer) * 100) : 0}%` }} /></div>
                  </div>
                  <div className="layer-main">
                    <code className="layer-cmd">{(h.CreatedBy || '').replace(/^\/bin\/sh -c #\(nop\)\s*/, '').replace(/^\/bin\/sh -c /, 'RUN ').replace(/\s*# buildkit$/, '')}</code>
                    <div className="layer-meta">{h.Created ? ago(h.Created * 1000) : ''}{h.Id && h.Id !== '<missing>' ? ` · ${shortId(h.Id)}` : ''}{h.Tags?.length ? ` · ${h.Tags.join(', ')}` : ''}{h.Comment ? ` · ${h.Comment}` : ''}</div>
                  </div>
                </div>
              ))}
            </Group>
          </div>
        )}
        {tab === 'inspect' && <InspectTab data={img} name={label.replace(/[/:]/g, '_')} />}
      </div>
      <RunContainerSheet open={runOpen} onClose={() => setRunOpen(false)} image={img.RepoTags?.[0] || img.Id} />
      <TagSheet open={tagOpen} onClose={() => setTagOpen(false)} id={img.Id} label={label} />
      <PullImageSheet open={pullOpen} onClose={() => setPullOpen(false)} initial={img.RepoTags?.[0] || ''} />
    </div>
  );
}

const toMsSafe = (s: string) => s && !s.startsWith('0001');
