import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Sheet } from '../../components/dialog';
import { Button, Field } from '../../components/ui';
import { engine } from '../../lib/api';
import { queryClient } from '../../lib/docker';
import { toast, toastError } from '../../components/toast';

export function UpdateResourcesSheet({ open, onClose, c }: { open: boolean; onClose: () => void; c: any }) {
  const hc = c.HostConfig;
  const [policy, setPolicy] = useState(hc.RestartPolicy?.Name || 'no');
  const [retries, setRetries] = useState(String(hc.RestartPolicy?.MaximumRetryCount || 0));
  const [memory, setMemory] = useState('');
  const [cpu, setCpu] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPolicy(hc.RestartPolicy?.Name || 'no');
    setRetries(String(hc.RestartPolicy?.MaximumRetryCount || 0));
    setMemory(hc.Memory ? String(Math.round(hc.Memory / 1024 / 1024)) : '');
    setCpu(hc.NanoCpus ? String(hc.NanoCpus / 1e9) : '');
  }, [open]);

  const submit = async () => {
    setBusy(true);
    const body: any = { RestartPolicy: { Name: policy, ...(policy === 'on-failure' ? { MaximumRetryCount: Number(retries) || 0 } : {}) } };
    if (memory !== '' && Number(memory) > 0) { body.Memory = Math.round(Number(memory) * 1024 * 1024); body.MemorySwap = -1; }
    if (cpu !== '' && Number(cpu) > 0) body.NanoCpus = Math.round(Number(cpu) * 1e9);
    try {
      const r = await engine.post(`/containers/${c.Id}/update`, body);
      if (r?.Warnings?.length) toast({ kind: 'warning', title: 'Updated with warnings', message: r.Warnings.join('\n') });
      else toast({ kind: 'success', title: 'Container updated', message: 'New limits apply immediately.' });
      queryClient.invalidateQueries({ queryKey: ['container', c.Id] });
      onClose();
    } catch (e) { toastError('Update failed', e); } finally { setBusy(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Resources & Restart Policy" subtitle={c.Name.slice(1)} icon={<SlidersHorizontal size={18} />} width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={submit}>Apply</Button></>}>
      <div className="form">
        <Field label="Restart policy">
          <select className="select" value={policy} onChange={(e) => setPolicy(e.target.value)}>
            <option value="no">Never</option>
            <option value="on-failure">On failure</option>
            <option value="unless-stopped">Unless stopped</option>
            <option value="always">Always</option>
          </select>
        </Field>
        {policy === 'on-failure' && (
          <Field label="Max retries"><input className="input" type="number" min={0} value={retries} onChange={(e) => setRetries(e.target.value)} /></Field>
        )}
        <Field label="Memory limit" hint="In MiB. Leave empty to keep the current value.">
          <input className="input" type="number" min={6} placeholder="Unlimited" value={memory} onChange={(e) => setMemory(e.target.value)} />
        </Field>
        <Field label="CPU limit" hint="Number of CPUs, e.g. 0.5 or 2.">
          <input className="input" type="number" min={0.01} step={0.25} placeholder="Unlimited" value={cpu} onChange={(e) => setCpu(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}
