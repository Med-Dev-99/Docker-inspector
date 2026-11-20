import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Sheet } from '../../components/dialog';
import { Button, Field } from '../../components/ui';
import { engine } from '../../lib/api';
import { queryClient } from '../../lib/docker';
import { toast, toastError } from '../../components/toast';

export function RenameSheet({ open, onClose, id, name }: { open: boolean; onClose: () => void; id: string; name: string }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setValue(name); }, [open, name]);
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(value) && value !== name;
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await engine.post(`/containers/${id}/rename?name=${encodeURIComponent(value)}`);
      toast({ kind: 'success', title: 'Container renamed', message: `${name} → ${value}` });
      queryClient.invalidateQueries({ queryKey: ['containers'] });
      queryClient.invalidateQueries({ queryKey: ['container', id] });
      onClose();
    } catch (e) { toastError('Rename failed', e); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Rename Container" subtitle={name} icon={<Pencil size={18} />} width={440}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || busy} onClick={submit}>Rename</Button></>}>
      <Field label="New name" hint="Letters, digits, “_”, “.” and “-”.">
        <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
    </Sheet>
  );
}
