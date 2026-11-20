import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { JsonView } from '../../components/json';
import { Capsule, IconButton, SearchField, Segmented, copyText } from '../../components/ui';
import { saveBlob } from '../../lib/api';

export function InspectTab({ data, name }: { data: unknown; name: string }) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const text = JSON.stringify(data, null, 2);
  return (
    <div className="inspect">
      <div className="subbar">
        <SearchField value={q} onChange={setQ} placeholder="Search keys and values" width={280} />
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'tree', label: 'Tree' }, { value: 'raw', label: 'Raw' }]} />
        <div className="flex-1" />
        <Capsule>
          <IconButton icon={Copy} label="Copy JSON" onClick={() => copyText(text, 'JSON copied')} />
          <IconButton icon={Download} label="Save JSON" onClick={() => saveBlob(new Blob([text], { type: 'application/json' }), `${name}.json`)} />
        </Capsule>
      </div>
      <div className="scroll inspect-body">
        {mode === 'tree' ? <JsonView data={data} query={q} /> : <pre className="code">{text}</pre>}
      </div>
    </div>
  );
}
