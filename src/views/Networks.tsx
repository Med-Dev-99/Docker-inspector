import { useMemo, useState } from 'react';
import { Box, Copy, Network as NetIcon, Plus, Sparkles, Trash2, Unlink, Link2 } from 'lucide-react';
import { Page, Split } from '../components/layout';
import { Button, Capsule, Empty, Group, IconButton, Loading, Pill, Row, SearchField, Segmented, Spinner, copyText } from '../components/ui';
import { Sheet } from '../components/dialog';
import { onContextMenu } from '../components/menu';
import { useNetworks, useNetwork, useContainers, SYSTEM_NETWORKS, project, cName, queryClient } from '../lib/docker';
import { navigate, useRoute } from '../lib/router';
import { networkRemove, networkDisconnect, useBusy } from '../lib/actions';
import { ago, date, shortId } from '../lib/format';
import { engine } from '../lib/api';
import { toast, toastError } from '../components/toast';
import { CreateNetworkSheet } from './sheets/CreateNetwork';
import { InspectTab } from './container/Inspect';

export function NetworksView() {
  const route = useRoute();
  const id = route.parts[1];
  const { data: networks, isLoading } = useNetworks();
  const { data: containers } = useContainers();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of containers || []) for (const n of Object.values(c.NetworkSettings?.Networks || {})) m.set(n.NetworkID, (m.get(n.NetworkID) || 0) + 1);
    return m;
  }, [containers]);

  const list = useMemo(() => {
    let l = networks || [];
    if (search) { const s = search.toLowerCase(); l = l.filter((n) => n.Name.toLowerCase().includes(s) || n.Driver.includes(s) || n.Id.startsWith(s)); }
    return [...l].sort((a, b) => Number(SYSTEM_NETWORKS.has(b.Name)) - Number(SYSTEM_NETWORKS.has(a.Name)) || (counts.get(b.Id) || 0) - (counts.get(a.Id) || 0) || a.Name.localeCompare(b.Name));
  }, [networks, search, counts]);

  const prune = async () => {
    try {
      const r = await engine.post('/networks/prune');
      toast({ kind: 'success', title: `Removed ${(r?.NetworksDeleted || []).length} unused networks` });
      queryClient.invalidateQueries({ queryKey: ['networks'] });
    } catch (e) { toastError('Prune failed', e); }
  };

  return (
    <Page title="Networks" subtitle={networks ? `${networks.length} networks` : undefined}
      toolbar={<>
        <Capsule>
          <IconButton icon={Plus} label="New network" onClick={() => setCreateOpen(true)} />
          <IconButton icon={Sparkles} label="Remove unused networks" onClick={prune} />
        </Capsule>
        <SearchField value={search} onChange={setSearch} placeholder="Search networks" />
      </>}>
      <Split
        list={
          <div className="list">
            {isLoading && <Loading />}
            {list.map((n) => {
              const count = counts.get(n.Id) || 0;
              const subnet = n.IPAM?.Config?.[0]?.Subnet;
              const sys = SYSTEM_NETWORKS.has(n.Name);
              return (
                <div key={n.Id} className={`list-row${n.Id === id ? ' selected' : ''}`} onClick={() => navigate(`/networks/${n.Id}`)}
                  onContextMenu={onContextMenu([
                    { label: 'Copy ID', icon: Copy, onClick: () => copyText(n.Id, 'Network ID copied') },
                    { label: 'Copy Name', icon: Copy, onClick: () => copyText(n.Name, 'Name copied') },
                    { separator: true },
                    { label: 'Delete…', icon: Trash2, destructive: true, disabled: sys, onClick: () => networkRemove(n.Id, n.Name).then((ok) => ok && navigate('/networks')) },
                  ])}>
                  <div className="lr-lead"><div className={`mini-icon ${count ? 'teal' : 'teal-soft'}`}><NetIcon size={13} strokeWidth={2} /></div></div>
                  <div className="lr-main">
                    <div className="lr-title"><span className="truncate">{n.Name}</span>{sys && <span className="tag-chip">system</span>}</div>
                    <div className="lr-sub truncate">{n.Driver}{subnet ? ` · ${subnet}` : ''}{project(n.Labels) ? ` · ${project(n.Labels)}` : ''}</div>
                  </div>
                  <div className="lr-side"><span className="lr-metric">{count}</span><span className="lr-metric dim">container{count === 1 ? '' : 's'}</span></div>
                </div>
              );
            })}
          </div>
        }
        detail={id ? <NetworkDetail key={id} id={id} /> : <Empty icon={NetIcon} title="No network selected" message="Select a network to see its subnet, gateway and connected containers." />}
      />
      <CreateNetworkSheet open={createOpen} onClose={() => setCreateOpen(false)} />
    </Page>
  );
}

function ConnectSheet({ open, onClose, netId, netName, connected }: { open: boolean; onClose: () => void; netId: string; netName: string; connected: Set<string> }) {
  const { data: containers } = useContainers();
  const [sel, setSel] = useState('');
  const [alias, setAlias] = useState('');
  const options = (containers || []).filter((c) => !connected.has(c.Id));
  const submit = async () => {
    try {
      await engine.post(`/networks/${netId}/connect`, { Container: sel, ...(alias ? { EndpointConfig: { Aliases: [alias] } } : {}) });
      toast({ kind: 'success', title: 'Container connected', message: netName });
      queryClient.invalidateQueries({ queryKey: ['network', netId] });
      queryClient.invalidateQueries({ queryKey: ['containers'] });
      onClose();
    } catch (e) { toastError('Couldn’t connect', e); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Connect Container" subtitle={`to ${netName}`} icon={<Link2 size={18} />} width={460}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!sel} onClick={submit}>Connect</Button></>}>
      <div className="form">
        <label className="field"><span className="field-label">Container</span><span className="field-control">
          <select className="select" value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((c) => <option key={c.Id} value={c.Id}>{cName(c)} ({c.State})</option>)}
          </select>
        </span></label>
        <label className="field"><span className="field-label">Alias</span><span className="field-control">
          <input className="input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Optional DNS alias" />
        </span></label>
      </div>
    </Sheet>
  );
}

function NetworkDetail({ id }: { id: string }) {
  const { data: n, isLoading, error } = useNetwork(id);
  const { data: containers } = useContainers();
  const busy = useBusy(id);
  const [tab, setTab] = useState<'overview' | 'inspect'>('overview');
  const [connectOpen, setConnectOpen] = useState(false);
  if (isLoading) return <Loading />;
  if (error || !n) return <Empty icon={NetIcon} title="Network not found" />;
  const sys = SYSTEM_NETWORKS.has(n.Name);
  // Network inspect only lists running containers; add stopped ones from the container list.
  const attached = (containers || []).filter((c) => Object.values(c.NetworkSettings?.Networks || {}).some((x: any) => x.NetworkID === n.Id));
  const live = n.Containers || {};
  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-icon state-teal"><NetIcon size={24} strokeWidth={1.7} /></div>
        <div className="detail-titles">
          <div className="detail-title"><span className="truncate">{n.Name}</span><Pill color="teal">{n.Driver}</Pill>{n.Internal && <Pill color="orange">internal</Pill>}</div>
          <div className="detail-sub"><span className="mono">{shortId(n.Id)}</span><span className="sep">·</span>{n.Scope}<span className="sep">·</span>created {ago(n.Created)}</div>
        </div>
        <div className="detail-actions">
          {busy ? <span className="capsule capsule-busy"><Spinner size={13} /> {busy}…</span> : (
            <Capsule>
              {!['host', 'none'].includes(n.Name) && <IconButton icon={Link2} label="Connect a container" onClick={() => setConnectOpen(true)} />}
              <IconButton icon={Copy} label="Copy ID" onClick={() => copyText(n.Id, 'Network ID copied')} />
              <IconButton icon={Trash2} label={sys ? 'System networks can’t be deleted' : 'Delete'} disabled={sys} onClick={() => networkRemove(n.Id, n.Name).then((ok) => ok && navigate('/networks'))} />
            </Capsule>
          )}
        </div>
      </div>
      <div className="detail-tabs"><Segmented value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'inspect', label: 'Inspect' }]} /></div>
      <div className="detail-body">
        {tab === 'overview' ? (
          <div className="scroll pad">
            <Group title={`Connected containers (${attached.length})`} flush>
              {attached.length === 0 ? <div className="group-empty">No containers are attached.</div> : (
                <table className="table">
                  <thead><tr><th>Container</th><th>State</th><th>IPv4</th><th>IPv6</th><th>MAC</th><th /></tr></thead>
                  <tbody>
                    {attached.map((c) => {
                      const ep: any = Object.values(c.NetworkSettings?.Networks || {}).find((x: any) => x.NetworkID === n.Id) || {};
                      const l = live[c.Id];
                      return (
                        <tr key={c.Id}>
                          <td><a className="link flex-c gap-6" onClick={() => navigate(`/containers/${c.Id}`)}><Box size={13} />{cName(c)}</a></td>
                          <td className="small">{c.State}</td>
                          <td className="mono small">{l?.IPv4Address || (ep.IPAddress ? `${ep.IPAddress}/${ep.IPPrefixLen}` : '—')}</td>
                          <td className="mono small muted">{l?.IPv6Address || ep.GlobalIPv6Address || '—'}</td>
                          <td className="mono small muted">{l?.MacAddress || ep.MacAddress || '—'}</td>
                          <td className="r">{!['host', 'none'].includes(n.Name) && <IconButton icon={Unlink} size={13} label="Disconnect" onClick={() => networkDisconnect(n.Id, n.Name, c.Id, cName(c))} />}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Group>
            <div className="columns">
              <div className="col">
                <Group title="Network">
                  <Row label="ID" mono copy={n.Id}>{shortId(n.Id)}</Row>
                  <Row label="Driver">{n.Driver}</Row>
                  <Row label="Scope">{n.Scope}</Row>
                  <Row label="Created">{date(n.Created)}</Row>
                  <Row label="Internal">{n.Internal ? 'Yes' : 'No'}</Row>
                  <Row label="Attachable">{n.Attachable ? 'Yes' : 'No'}</Row>
                  <Row label="IPv4 / IPv6">{n.EnableIPv4 === false ? 'off' : 'on'} / {n.EnableIPv6 ? 'on' : 'off'}</Row>
                  {project(n.Labels) && <Row label="Compose project">{project(n.Labels)}</Row>}
                </Group>
              </div>
              <div className="col">
                <Group title="IP address management">
                  <Row label="IPAM driver">{n.IPAM?.Driver}</Row>
                  {(n.IPAM?.Config || []).map((cfg, i) => (
                    <div key={i}>
                      <Row label="Subnet" mono>{cfg.Subnet}</Row>
                      <Row label="Gateway" mono>{cfg.Gateway}</Row>
                      {cfg.IPRange && <Row label="IP range" mono>{cfg.IPRange}</Row>}
                    </div>
                  ))}
                </Group>
                {Object.keys(n.Options || {}).length > 0 && (
                  <Group title="Driver options">{Object.entries(n.Options).map(([k, v]) => <Row key={k} label={<span className="mono small">{k.replace('com.docker.network.', '')}</span>} mono>{v}</Row>)}</Group>
                )}
              </div>
            </div>
          </div>
        ) : <InspectTab data={n} name={n.Name} />}
      </div>
      <ConnectSheet open={connectOpen} onClose={() => setConnectOpen(false)} netId={n.Id} netName={n.Name} connected={new Set(attached.map((c) => c.Id))} />
    </div>
  );
}
