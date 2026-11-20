// Collapsible JSON tree viewer.
import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

function matches(v: unknown, q: string): boolean {
  if (!q) return true;
  if (v === null || typeof v !== 'object') return String(v).toLowerCase().includes(q);
  return Object.entries(v as object).some(([k, x]) => k.toLowerCase().includes(q) || matches(x, q));
}

function Value({ v, q }: { v: unknown; q: string }) {
  if (v === null) return <span className="j-null">null</span>;
  if (typeof v === 'string') return <span className="j-str">"{hl(v, q)}"</span>;
  if (typeof v === 'number') return <span className="j-num">{hl(String(v), q)}</span>;
  if (typeof v === 'boolean') return <span className="j-bool">{String(v)}</span>;
  return null;
}

function hl(s: string, q: string) {
  if (!q) return s;
  const i = s.toLowerCase().indexOf(q);
  if (i < 0) return s;
  return <>{s.slice(0, i)}<mark>{s.slice(i, i + q.length)}</mark>{s.slice(i + q.length)}</>;
}

function Node({ k, v, depth, q, defaultOpen }: { k?: string; v: unknown; depth: number; q: string; defaultOpen: number }) {
  const isObj = v !== null && typeof v === 'object';
  const [open, setOpen] = useState(depth < defaultOpen);
  const entries = useMemo(() => (isObj ? Object.entries(v as object) : []), [v, isObj]);
  const forced = !!q && isObj && matches(v, q);
  const isOpen = open || forced;
  if (q && !matches(v, q) && !(k && k.toLowerCase().includes(q))) return null;
  const isArr = Array.isArray(v);
  const key = k !== undefined && <span className="j-key">{hl(k, q)}<span className="j-punct">: </span></span>;
  if (!isObj) return <div className="j-line" style={{ paddingLeft: depth * 16 + 16 }}>{key}<Value v={v} q={q} /></div>;
  const empty = entries.length === 0;
  return (
    <>
      <div className="j-line j-toggle" style={{ paddingLeft: depth * 16 }} onClick={() => !empty && setOpen(!isOpen)}>
        <span className={`j-chev${isOpen ? ' open' : ''}${empty ? ' hidden' : ''}`}><ChevronRight size={12} strokeWidth={2.5} /></span>
        {key}
        <span className="j-punct">{isArr ? '[' : '{'}</span>
        {(!isOpen || empty) && <><span className="j-count">{empty ? '' : isArr ? ` ${entries.length} items ` : ` ${entries.length} keys `}</span><span className="j-punct">{isArr ? ']' : '}'}</span></>}
      </div>
      {isOpen && !empty && (
        <>
          {entries.map(([ck, cv]) => <Node key={ck} k={isArr ? undefined : ck} v={cv} depth={depth + 1} q={q} defaultOpen={defaultOpen} />)}
          <div className="j-line" style={{ paddingLeft: depth * 16 + 16 }}><span className="j-punct">{isArr ? ']' : '}'}</span></div>
        </>
      )}
    </>
  );
}

export function JsonView({ data, query = '', defaultOpen = 2 }: { data: unknown; query?: string; defaultOpen?: number }) {
  return <div className="json"><Node v={data} depth={0} q={query.toLowerCase()} defaultOpen={defaultOpen} /></div>;
}
