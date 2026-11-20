import { useEffect, useState } from 'react';
import { Play, Plus, X } from 'lucide-react';
import { Sheet } from '../../components/dialog';
import { Button, Field, Toggle, IconButton } from '../../components/ui';
import { engine, ApiError, q } from '../../lib/api';
import { queryClient, useImages, useNetworks } from '../../lib/docker';
import { toast, toastError } from '../../components/toast';
import { navigate } from '../../lib/router';
import { pullImage } from './PullImage';

function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = '', quote: string | null = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; else if (ch === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i]; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else if (ch === '\\' && i + 1 < s.length) cur += s[++i];
    else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

type Pair = { a: string; b: string; c?: string };

function Pairs({ rows, setRows, aPh, bPh, sep, third }: { rows: Pair[]; setRows: (r: Pair[]) => void; aPh: string; bPh: string; sep: string; third?: { options: string[] } }) {
  return (
    <div className="pairs">
      {rows.map((r, i) => (
        <div key={i} className="pair">
          <input className="input input-sm mono" placeholder={aPh} value={r.a} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} />
          <span className="pair-sep">{sep}</span>
          <input className="input input-sm mono" placeholder={bPh} value={r.b} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, b: e.target.value } : x)))} />
          {third && (
            <select className="select select-sm" value={r.c || third.options[0]} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, c: e.target.value } : x)))}>
              {third.options.map((o) => <option key={o}>{o}</option>)}
            </select>
          )}
          <IconButton icon={X} size={12} label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button className="pair-add" onClick={() => setRows([...rows, { a: '', b: '' }])}><Plus size={12} /> Add</button>
    </div>
  );
}

export function RunContainerSheet({ open, onClose, image: initialImage = '' }: { open: boolean; onClose: () => void; image?: string }) {
  const { data: images } = useImages();
  const { data: networks } = useNetworks();
  const [image, setImage] = useState(initialImage);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [ports, setPorts] = useState<Pair[]>([]);
  const [env, setEnv] = useState<Pair[]>([]);
  const [vols, setVols] = useState<Pair[]>([]);
  const [network, setNetwork] = useState('bridge');
  const [restart, setRestart] = useState('no');
  const [autoRemove, setAutoRemove] = useState(false);
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (open) { setImage(initialImage); setName(''); setCommand(''); setPorts([]); setEnv([]); setVols([]); setNetwork('bridge'); setRestart('no'); setAutoRemove(false); setBusy(''); }
  }, [open, initialImage]);

  const submit = async () => {
    if (!image.trim()) return;
    const exposed: Record<string, object> = {};
    const bindings: Record<string, { HostPort: string }[]> = {};
    for (const p of ports) {
      if (!p.b.trim()) continue;
      const key = `${p.b.trim()}/${p.c || 'tcp'}`;
      exposed[key] = {};
      bindings[key] = [...(bindings[key] || []), { HostPort: p.a.trim() }];
    }
    const body = {
      Image: image.trim(),
      ...(command.trim() ? { Cmd: shellSplit(command) } : {}),
      Env: env.filter((e) => e.a.trim()).map((e) => `${e.a.trim()}=${e.b}`),
      ExposedPorts: exposed,
      Labels: { 'created-by': 'docker-inspector' },
      HostConfig: {
        PortBindings: bindings,
        Binds: vols.filter((v) => v.a.trim() && v.b.trim()).map((v) => `${v.a.trim()}:${v.b.trim()}${v.c === 'ro' ? ':ro' : ''}`),
        RestartPolicy: { Name: autoRemove ? 'no' : restart },
        AutoRemove: autoRemove,
        NetworkMode: network,
      },
    };
    const create = () => engine.post<{ Id: string; Warnings: string[] }>(`/containers/create?${q({ name: name.trim() || undefined })}`, body);
    try {
      setBusy('Creating…');
      let res;
      try { res = await create(); }
      catch (e) {
        if (e instanceof ApiError && e.status === 404 && /image/i.test(e.message)) {
          setBusy(`Pulling ${image.trim()}…`);
          await pullImage(image.trim());
          setBusy('Creating…');
          res = await create();
        } else throw e;
      }
      if (startNow) { setBusy('Starting…'); await engine.post(`/containers/${res.Id}/start`); }
      toast({ kind: 'success', title: startNow ? 'Container started' : 'Container created', message: name || image });
      queryClient.invalidateQueries({ queryKey: ['containers'] });
      onClose();
      navigate(`/containers/${res.Id}/${startNow ? 'logs' : 'overview'}`);
    } catch (e) {
      toastError('Couldn’t run container', e);
    } finally { setBusy(''); }
  };

  const imageOptions = (images || []).flatMap((i) => (i.RepoTags || []).filter((t) => t !== '<none>:<none>'));

  return (
    <Sheet open={open} onClose={onClose} title="Run a New Container" subtitle="Like docker run, but friendlier" icon={<Play size={18} />} width={620}
      footer={<>
        <span className="sheet-foot-info">{busy}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!image.trim() || !!busy} onClick={submit}>{startNow ? 'Run' : 'Create'}</Button>
      </>}>
      <div className="form">
        <Field label="Image" hint="Pulled automatically if it isn’t available locally.">
          <input className="input mono" list="di-images" autoFocus value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" spellCheck={false} />
          <datalist id="di-images">{imageOptions.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional — Docker picks one" /></Field>
        <Field label="Command"><input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Optional override, e.g. npm run dev" spellCheck={false} /></Field>
        <Field label="Ports"><Pairs rows={ports} setRows={setPorts} aPh="Host port" bPh="Container port" sep="→" third={{ options: ['tcp', 'udp'] }} /></Field>
        <Field label="Environment"><Pairs rows={env} setRows={setEnv} aPh="KEY" bPh="value" sep="=" /></Field>
        <Field label="Volumes"><Pairs rows={vols} setRows={setVols} aPh="Volume name or /host/path" bPh="/container/path" sep=":" third={{ options: ['rw', 'ro'] }} /></Field>
        <Field label="Network">
          <select className="select" value={network} onChange={(e) => setNetwork(e.target.value)}>
            {(networks || []).map((n) => <option key={n.Id} value={n.Name}>{n.Name} ({n.Driver})</option>)}
          </select>
        </Field>
        <Field label="Restart">
          <select className="select" value={restart} disabled={autoRemove} onChange={(e) => setRestart(e.target.value)}>
            <option value="no">Never</option><option value="on-failure">On failure</option><option value="unless-stopped">Unless stopped</option><option value="always">Always</option>
          </select>
        </Field>
        <Field label="Options">
          <div className="stack-8">
            <Toggle checked={autoRemove} onChange={setAutoRemove} label="Remove container when it exits (--rm)" />
            <Toggle checked={startNow} onChange={setStartNow} label="Start immediately" />
          </div>
        </Field>
      </div>
    </Sheet>
  );
}
