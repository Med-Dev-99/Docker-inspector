import { useEffect, useState } from 'react';
import { Tag } from 'lucide-react';
import { Sheet } from '../../components/dialog';
import { Button, Field } from '../../components/ui';
import { engine, q } from '../../lib/api';
import { queryClient, splitRepoTag } from '../../lib/docker';
import { toast, toastError } from '../../components/toast';

export function TagSheet({ open, onClose, id, label }: { open: boolean; onClose: () => void; id: string; label: string }) {
  const [ref, setRef] = useState('');
  useEffect(() => { if (open) setRef(label.includes('<none>') ? '' : label); }, [open, label]);
  const submit = async () => {
    const { repo, tag } = splitRepoTag(ref.trim());
    try {
      await engine.post(`/images/${encodeURIComponent(id)}/tag?${q({ repo, tag })}`);
      toast({ kind: 'success', title: 'Image tagged', message: `${repo}:${tag}` });
      queryClient.invalidateQueries({ queryKey: ['images'] });
      queryClient.invalidateQueries({ queryKey: ['image', id] });
      onClose();
    } catch (e) { toastError('Tagging failed', e); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add Tag" subtitle={label} icon={<Tag size={18} />} width={460}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ref.trim()} onClick={submit}>Add Tag</Button></>}>
      <Field label="Repository:tag" hint="e.g. myapp:v2 or registry.example.com/team/myapp:latest">
        <input className="input mono" autoFocus value={ref} onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} spellCheck={false} />
      </Field>
    </Sheet>
  );
}
