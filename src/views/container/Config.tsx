import { useState } from 'react';
import { Copy, Eye, EyeOff, Database, Folder, HardDrive, ExternalLink } from 'lucide-react';
import { Group, Row, Pill, SearchField, IconButton, CopyButton, copyText, Empty } from '../../components/ui';
import { isSecretKey, nsDuration } from '../../lib/format';
import { openExternal, isAnonymousVolume } from '../../lib/docker';
import { navigate } from '../../lib/router';

function EnvTable({ env }: { env: string[] }) {
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const rows = env.map((e) => { const i = e.indexOf('='); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; })
    .filter(([k, v]) => !q || k.toLowerCase().includes(q.toLowerCase()) || v.toLowerCase().includes(q.toLowerCase()));
  return (
    <Group title={`Environment (${env.length})`} flush actions={<>
      <SearchField value={q} onChange={setQ} placeholder="Filter" width={160} />
      <IconButton icon={all ? EyeOff : Eye} label={all ? 'Hide secrets' : 'Reveal secrets'} onClick={() => setAll(!all)} />
      <IconButton icon={Copy} label="Copy as .env" onClick={() => copyText(env.join('\n'), 'Environment copied as .env')} />
    </>}>
      <table className="table kv-table">
        <tbody>
          {rows.map(([k, v]) => {
            const secret = isSecretKey(k, v) && !!v;
            const shown = !secret || all || reveal[k];
            return (
              <tr key={k}>
                <td className="mono kv-key">{k}</td>
                <td className="mono kv-val">
                  <span className={shown ? '' : 'masked'}>{shown ? v || <span className="muted">(empty)</span> : '••••••••••••'}</span>
                  <span className="kv-tools">
                    {secret && !all && <IconButton icon={reveal[k] ? EyeOff : Eye} size={12} label="Reveal" onClick={() => setReveal({ ...reveal, [k]: !reveal[k] })} />}
                    <CopyButton text={v} />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="group-empty">No variables</div>}
    </Group>
  );
}

function LabelsTable({ labels }: { labels: Record<string, string> }) {
  const [q, setQ] = useState('');
  const rows = Object.entries(labels).filter(([k, v]) => !q || k.toLowerCase().includes(q.toLowerCase()) || v.toLowerCase().includes(q.toLowerCase()));
  return (
    <Group title={`Labels (${Object.keys(labels).length})`} flush actions={<SearchField value={q} onChange={setQ} placeholder="Filter" width={160} />}>
      <table className="table kv-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><td className="mono kv-key">{k}</td><td className="mono kv-val">{v}<span className="kv-tools"><CopyButton text={v} /></span></td></tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="group-empty">No labels</div>}
    </Group>
  );
}

export function ConfigTab({ c }: { c: any }) {
  const cfg = c.Config;
  const hc = c.HostConfig;
  const ns = c.NetworkSettings || {};
  const portRows: { container: string; host: string; ip: string }[] = [];
  for (const [k, v] of Object.entries(ns.Ports || {}) as [string, any][]) {
    if (!v || !v.length) portRows.push({ container: k, host: '', ip: '' });
    else for (const b of v) portRows.push({ container: k, host: b.HostPort, ip: b.HostIp });
  }
  for (const k of Object.keys(cfg.ExposedPorts || {})) if (!portRows.some((p) => p.container === k)) portRows.push({ container: k, host: '', ip: '' });

  return (
    <div className="scroll pad">
      <EnvTable env={cfg.Env || []} />

      <Group title="Ports" flush>
        {portRows.length === 0 ? <div className="group-empty">No ports exposed</div> : (
          <table className="table">
            <thead><tr><th>Container</th><th>Host</th><th>Bind address</th><th /></tr></thead>
            <tbody>
              {portRows.map((p, i) => (
                <tr key={i}>
                  <td className="mono">{p.container}</td>
                  <td className="mono">{p.host || <span className="muted">not published</span>}</td>
                  <td className="mono muted">{p.ip || '—'}</td>
                  <td className="r">{p.host && <IconButton icon={ExternalLink} size={13} label="Open in browser" onClick={() => openExternal(`http://localhost:${p.host}`)} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Group>

      <Group title="Mounts" flush>
        {(c.Mounts || []).length === 0 ? <div className="group-empty">No mounts</div> : (
          <table className="table">
            <thead><tr><th>Type</th><th>Source</th><th>Destination</th><th>Mode</th></tr></thead>
            <tbody>
              {c.Mounts.map((m: any, i: number) => (
                <tr key={i}>
                  <td><span className="flex-c gap-6">{m.Type === 'volume' ? <Database size={13} className="tint-orange" /> : m.Type === 'bind' ? <Folder size={13} className="tint-blue" /> : <HardDrive size={13} className="muted" />}{m.Type}</span></td>
                  <td className="mono small">
                    {m.Type === 'volume'
                      ? <a className="link" onClick={() => navigate(`/volumes/${encodeURIComponent(m.Name)}`)}>{isAnonymousVolume(m.Name) ? `${m.Name.slice(0, 12)}… (anonymous)` : m.Name}</a>
                      : <span title={m.Source}>{m.Source}</span>}
                  </td>
                  <td className="mono small">
                    {c.State.Status === 'running'
                      ? <a className="link" onClick={() => navigate(`/containers/${c.Id}/files?path=${encodeURIComponent(m.Destination)}`)}>{m.Destination}</a>
                      : m.Destination}
                  </td>
                  <td><Pill color={m.RW ? 'blue' : 'gray'}>{m.RW ? 'read-write' : 'read-only'}</Pill>{m.Propagation && <span className="muted small"> {m.Propagation}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Group>

      <Group title="Networks" flush>
        {Object.keys(ns.Networks || {}).length === 0 ? <div className="group-empty">Not attached to any network</div> : (
          <table className="table">
            <thead><tr><th>Network</th><th>IPv4</th><th>Gateway</th><th>MAC</th><th>Aliases / DNS names</th></tr></thead>
            <tbody>
              {Object.entries(ns.Networks).map(([n, v]: [string, any]) => (
                <tr key={n}>
                  <td><a className="link" onClick={() => navigate(`/networks/${v.NetworkID}`)}>{n}</a></td>
                  <td className="mono small">{v.IPAddress ? `${v.IPAddress}/${v.IPPrefixLen}` : '—'}</td>
                  <td className="mono small">{v.Gateway || '—'}</td>
                  <td className="mono small muted">{v.MacAddress || '—'}</td>
                  <td className="mono small muted">{[...(v.Aliases || []), ...(v.DNSNames || [])].filter((x, i, a) => a.indexOf(x) === i).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Group>

      <LabelsTable labels={cfg.Labels || {}} />

      <div className="columns">
        <div className="col">
          <Group title="Security">
            <Row label="Privileged">{hc.Privileged ? <Pill color="red">privileged</Pill> : 'No'}</Row>
            <Row label="Capabilities added" mono>{(hc.CapAdd || []).join(', ')}</Row>
            <Row label="Capabilities dropped" mono>{(hc.CapDrop || []).join(', ')}</Row>
            <Row label="Security options" mono>{(hc.SecurityOpt || []).join(', ')}</Row>
            <Row label="AppArmor profile" mono>{c.AppArmorProfile}</Row>
            <Row label="User namespace">{hc.UsernsMode || 'host (default)'}</Row>
            <Row label="PID namespace">{hc.PidMode || 'private'}</Row>
            <Row label="IPC mode">{hc.IpcMode}</Row>
            <Row label="Read-only rootfs">{hc.ReadonlyRootfs ? 'Yes' : 'No'}</Row>
            <Row label="No new privileges">{(hc.SecurityOpt || []).some((s: string) => s.startsWith('no-new-privileges')) ? 'Yes' : 'No'}</Row>
          </Group>
          {cfg.Healthcheck && (
            <Group title="Health check definition">
              <Row label="Test" mono>{(cfg.Healthcheck.Test || []).join(' ')}</Row>
              <Row label="Interval">{nsDuration(cfg.Healthcheck.Interval)}</Row>
              <Row label="Timeout">{nsDuration(cfg.Healthcheck.Timeout)}</Row>
              <Row label="Start period">{nsDuration(cfg.Healthcheck.StartPeriod)}</Row>
              <Row label="Retries">{String(cfg.Healthcheck.Retries ?? '—')}</Row>
            </Group>
          )}
        </div>
        <div className="col">
          <Group title="DNS & Hosts">
            <Row label="Hostname" mono>{cfg.Hostname}</Row>
            <Row label="Domain name" mono>{cfg.Domainname}</Row>
            <Row label="DNS servers" mono>{(hc.Dns || []).join(', ')}</Row>
            <Row label="DNS search" mono>{(hc.DnsSearch || []).join(', ')}</Row>
            <Row label="Extra hosts" mono>{(hc.ExtraHosts || []).join(', ')}</Row>
            <Row label="Links" mono>{(hc.Links || []).join(', ')}</Row>
          </Group>
          <Group title="Logging">
            <Row label="Driver">{hc.LogConfig?.Type}</Row>
            {Object.entries(hc.LogConfig?.Config || {}).map(([k, v]) => <Row key={k} label={k} mono>{String(v)}</Row>)}
          </Group>
          {((hc.Devices || []).length > 0 || (hc.Ulimits || []).length > 0) && (
            <Group title="Devices & Limits">
              {(hc.Devices || []).map((d: any, i: number) => <Row key={i} label="Device" mono>{d.PathOnHost} → {d.PathInContainer} ({d.CgroupPermissions})</Row>)}
              {(hc.Ulimits || []).map((u: any) => <Row key={u.Name} label={`ulimit ${u.Name}`} mono>{u.Soft} / {u.Hard}</Row>)}
            </Group>
          )}
        </div>
      </div>
      {!cfg && <Empty title="No configuration" />}
    </div>
  );
}
