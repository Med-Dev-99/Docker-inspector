import { useEffect, useRef, useState } from 'react';
import { CloudDownload } from 'lucide-react';
import { Sheet } from '../../components/dialog';
import { Button, Field, Meter } from '../../components/ui';
import { streamNdjson, q } from '../../lib/api';
import { queryClient, splitRepoTag } from '../../lib/docker';
import { toast } from '../../components/toast';
import { bytes } from '../../lib/format';

interface LayerState { id: string; status: string; current?: number; total?: number }

/** Pull an image, reporting progress. Resolves when finished; throws on error. */
export async function pullImage(ref: string, onProgress?: (layers: Map<string, LayerState>, line?: string) => void, signal?: AbortSignal) {
  const { repo, tag } = splitRepoTag(ref.trim());
  const layers = new Map<string, LayerState>();
  let error: string | null = null;
  await streamNdjson(`/api/engine/images/create?${q({ fromImage: repo, tag })}`, { method: 'POST' }, (o) => {
    if (o.error) { error = o.errorDetail?.message || o.error; return; }
    if (o.id && o.status && !/^(Pulling from|Digest|Status)/.test(o.status)) {
      layers.set(o.id, { id: o.id, status: o.status, current: o.progressDetail?.current, total: o.progressDetail?.total });
    }
    onProgress?.(layers, o.id ? undefined : o.status);
  }, signal);
  if (error) throw new Error(error);
  queryClient.invalidateQueries({ queryKey: ['images'] });
  queryClient.invalidateQueries({ queryKey: ['df'] });
}

export function PullImageSheet({ open, onClose, initial = '' }: { open: boolean; onClose: () => void; initial?: string }) {
  const [ref, setRef] = useState(initial);
  const [running, setRunning] = useState(false);
  const [layers, setLayers] = useState<LayerState[]>([]);
  const [line, setLine] = useState('');
  const [err, setErr] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => { if (open) { setRef(initial); setLayers([]); setLine(''); setErr(''); } }, [open, initial]);

  const start = async () => {
    if (!ref.trim()) return;
    setRunning(true); setErr(''); setLayers([]); setLine('Connecting to registry…');
    ctrl.current = new AbortController();
    try {
      await pullImage(ref, (m, l) => { setLayers([...m.values()]); if (l) setLine(l); }, ctrl.current.signal);
      toast({ kind: 'success', title: 'Image pulled', message: ref });
      onClose();
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e.message || String(e));
    } finally { setRunning(false); }
  };

  const totalBytes = layers.reduce((a, l) => a + (l.total || 0), 0);
  const curBytes = layers.reduce((a, l) => a + (l.status === 'Download complete' || l.status === 'Pull complete' || l.status === 'Already exists' ? l.total || 0 : l.current || 0), 0);
  const done = layers.filter((l) => /complete|exists/i.test(l.status)).length;

  return (
    <Sheet open={open} onClose={() => { ctrl.current?.abort(); onClose(); }} title="Pull Image" subtitle="Download an image from a registry" icon={<CloudDownload size={18} />} width={560}
      footer={<><Button onClick={() => { ctrl.current?.abort(); onClose(); }}>{running ? 'Cancel' : 'Close'}</Button><Button variant="primary" disabled={running || !ref.trim()} onClick={start}>{running ? 'Pulling…' : 'Pull'}</Button></>}>
      <div className="form">
        <Field label="Image" hint="e.g. nginx:alpine, postgres:17, ghcr.io/org/app:1.2">
          <input className="input mono" autoFocus value={ref} disabled={running} placeholder="nginx:latest" spellCheck={false}
            onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && start()} />
        </Field>
        {(running || layers.length > 0) && (
          <div className="pull-progress">
            <div className="pull-summary"><span>{line}</span><span className="muted">{done}/{layers.length} layers{totalBytes ? ` · ${bytes(curBytes)} of ${bytes(totalBytes)}` : ''}</span></div>
            <Meter value={layers.length ? (done / layers.length) * 100 : 0} />
            <div className="pull-layers">
              {layers.map((l) => (
                <div key={l.id} className="pull-layer">
                  <span className="mono small">{l.id}</span>
                  <span className="small muted">{l.status}</span>
                  {l.total ? <Meter value={((l.current || 0) / l.total) * 100} /> : <span />}
                </div>
              ))}
            </div>
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
      </div>
    </Sheet>
  );
}
