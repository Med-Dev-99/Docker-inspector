import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { Sheet } from '../../components/dialog';
import { Button, Field } from '../../components/ui';
import { engine } from '../../lib/api';
import { queryClient } from '../../lib/docker';
import { toast, toastError } from '../../components/toast';
import { navigate } from '../../lib/router';

export function CreateVolumeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('local');
  useEffect(() => { if (open) { setName(''); setDriver('local'); } }, [open]);
  const submit = async () => {
    try {
      const v = await engine.post('/volumes/create', { Name: name.trim() || undefined, Driver: driver, Labels: { 'created-by': 'docker-inspector' } });
      toast({ kind: 'success', title: 'Volume created', message: v.Name });
      queryClient.invalidateQueries({ queryKey: ['volumes'] });
      onClose();
      navigate(`/volumes/${encodeURIComponent(v.Name)}`);
    } catch (e) { toastError('Couldn’t create volume', e); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="New Volume" icon={<Database size={18} />} width={440}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Create</Button></>}>
      <div className="form">
        <Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave empty for a random name" onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
        <Field label="Driver"><input className="input mono" value={driver} onChange={(e) => setDriver(e.target.value)} /></Field>
      </div>
    </Sheet>
  );
}
