import { useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { Sheet } from '../../components/dialog';
import { Button, Field, Toggle } from '../../components/ui';
import { engine } from '../../lib/api';
import { queryClient } from '../../lib/docker';
import { toast, toastError } from '../../components/toast';
import { navigate } from '../../lib/router';

export function CreateNetworkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('bridge');
  const [subnet, setSubnet] = useState('');
  const [gateway, setGateway] = useState('');
  const [internal, setInternal] = useState(false);
  const [attachable, setAttachable] = useState(true);
  const [ipv6, setIpv6] = useState(false);
  useEffect(() => { if (open) { setName(''); setDriver('bridge'); setSubnet(''); setGateway(''); setInternal(false); setIpv6(false); } }, [open]);
  const submit = async () => {
    try {
      const r = await engine.post('/networks/create', {
        Name: name.trim(), Driver: driver, Internal: internal, Attachable: attachable, EnableIPv6: ipv6,
        Labels: { 'created-by': 'docker-inspector' },
        ...(subnet ? { IPAM: { Driver: 'default', Config: [{ Subnet: subnet, ...(gateway ? { Gateway: gateway } : {}) }] } } : {}),
      });
      toast({ kind: 'success', title: 'Network created', message: name });
      queryClient.invalidateQueries({ queryKey: ['networks'] });
      onClose();
      navigate(`/networks/${r.Id}`);
    } catch (e) { toastError('Couldn’t create network', e); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="New Network" icon={<Network size={18} />} width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={submit}>Create</Button></>}>
      <div className="form">
        <Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-network" /></Field>
        <Field label="Driver">
          <select className="select" value={driver} onChange={(e) => setDriver(e.target.value)}>
            <option value="bridge">bridge</option><option value="macvlan">macvlan</option><option value="ipvlan">ipvlan</option><option value="overlay">overlay (swarm)</option>
          </select>
        </Field>
        <Field label="Subnet" hint="Optional CIDR, e.g. 172.30.0.0/16"><input className="input mono" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="Automatic" /></Field>
        <Field label="Gateway"><input className="input mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="Automatic" disabled={!subnet} /></Field>
        <Field label="Options">
          <div className="stack-8">
            <Toggle checked={internal} onChange={setInternal} label="Internal (no external access)" />
            <Toggle checked={attachable} onChange={setAttachable} label="Attachable" />
            <Toggle checked={ipv6} onChange={setIpv6} label="Enable IPv6" />
          </div>
        </Field>
      </div>
    </Sheet>
  );
}
