import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Clock, Download, Eraser, WrapText, ScrollText } from 'lucide-react';
import { socket } from '../../lib/ws';
import { parseAnsi, stripAnsi, hasAnsi, detectLevel, Level, Span } from '../../lib/ansi';
import { saveBlob } from '../../lib/api';
import { Capsule, IconButton, SearchField, Segmented, Empty, useLocalState, Spinner } from '../../components/ui';

interface Line { n: number; t: number; ts: string; stream: 'stdout' | 'stderr'; text: string; plain: string; spans?: Span[]; level: Level }

const MAX_LINES = 10000;
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

function fmtTs(ts: string) {
  const d = new Date(ts);
  if (isNaN(+d)) return ts;
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  return today ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`;
}

const LogLine = memo(function LogLine({ l, showTs, q }: { l: Line; showTs: boolean; q: string }) {
  let content: React.ReactNode;
  if (l.spans) {
    content = l.spans.map((s, i) => (
      <span key={i} style={{ color: s.fg, background: s.bg, fontWeight: s.bold ? 600 : undefined, opacity: s.dim ? 0.65 : undefined, fontStyle: s.italic ? 'italic' : undefined, textDecoration: s.underline ? 'underline' : undefined }}>{s.text}</span>
    ));
  } else if (q) {
    const parts: React.ReactNode[] = [];
    const lower = l.text.toLowerCase();
    let i = 0, k = 0, j;
    while ((j = lower.indexOf(q, i)) >= 0) {
      parts.push(l.text.slice(i, j), <mark key={k++}>{l.text.slice(j, j + q.length)}</mark>);
      i = j + q.length;
    }
    parts.push(l.text.slice(i));
    content = parts;
  } else content = l.text;
  return (
    <div className={`log-line ${l.stream}${l.level ? ' lvl-' + l.level : ''}`}>
      <span className="log-gutter" />
      {showTs && <span className="log-ts">{l.ts ? fmtTs(l.ts) : ''}</span>}
      <span className="log-text">{content}</span>
    </div>
  );
});

export function LogsTab({ c }: { c: any }) {
  const [tail, setTail] = useLocalState('logs.tail', '1000');
  const [showTs, setShowTs] = useLocalState('logs.ts', true);
  const [wrap, setWrap] = useLocalState('logs.wrap', true);
  const [streamF, setStreamF] = useState<'all' | 'stdout' | 'stderr'>('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [, setVer] = useState(0);
  const [status, setStatus] = useState<'loading' | 'live' | 'ended'>('loading');
  const lines = useRef<Line[]>([]);
  const counter = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  followRef.current = follow;

  useEffect(() => {
    lines.current = [];
    setStatus('loading');
    const partial: Record<string, string> = { stdout: '', stderr: '' };
    let pendingRender = false;
    const scheduleRender = () => {
      if (pendingRender) return;
      pendingRender = true;
      requestAnimationFrame(() => { pendingRender = false; setVer((v) => v + 1); });
    };
    const ingest = (stream: 'stdout' | 'stderr', data: string) => {
      const chunk = partial[stream] + data;
      const parts = chunk.split('\n');
      partial[stream] = parts.pop() || '';
      for (let raw of parts) {
        if (raw.endsWith('\r')) raw = raw.slice(0, -1);
        const m = raw.match(TS_RE);
        const ts = m ? m[1] : '';
        const text = m ? raw.slice(m[0].length) : raw;
        const ansi = hasAnsi(text);
        const plain = ansi ? stripAnsi(text) : text;
        lines.current.push({ n: counter.current++, t: ts ? Date.parse(ts) : 0, ts, stream, text, plain, spans: ansi ? parseAnsi(text) : undefined, level: detectLevel(plain) });
      }
      if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES);
      scheduleRender();
    };
    let gotData = false;
    const sess = socket.session({ type: 'logs.open', id: c.Id, tail: tail === 'all' ? 'all' : Number(tail) }, (msg) => {
      if (msg.type === 'logs.data') {
        if (!gotData) { gotData = true; setStatus('live'); }
        for (const [stream, data] of msg.chunks as ['stdout' | 'stderr', string][]) ingest(stream, data);
      } else if (msg.type === 'logs.end' || msg.type === 'disconnected') {
        for (const s of ['stdout', 'stderr'] as const) if (partial[s]) ingest(s, '\n');
        setStatus('ended');
      } else if (msg.type === 'error') {
        ingest('stderr', `[docker-inspector] ${msg.message}\n`);
        setStatus('ended');
      }
    });
    const t = setTimeout(() => setStatus((s) => (s === 'loading' ? 'live' : s)), 1200);
    return () => { clearTimeout(t); sess.close(); };
  }, [c.Id, tail, c.State.StartedAt]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => lines.current.filter((l) =>
    (streamF === 'all' || l.stream === streamF) && (!q || l.plain.toLowerCase().includes(q))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [lines.current.length, lines.current[lines.current.length - 1]?.n, streamF, q]);

  useEffect(() => {
    if (followRef.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== followRef.current) setFollow(atBottom);
  };

  const download = () => {
    const text = lines.current.map((l) => `${l.ts ? l.ts + ' ' : ''}${l.stream === 'stderr' ? '[stderr] ' : ''}${l.plain}`).join('\n');
    saveBlob(new Blob([text], { type: 'text/plain' }), `${c.Name.replace(/^\//, '')}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  };

  const errors = useMemo(() => lines.current.filter((l) => l.level === 'error').length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines.current.length, lines.current[lines.current.length - 1]?.n]);

  return (
    <div className="logs">
      <div className="subbar">
        <SearchField value={query} onChange={setQuery} placeholder="Filter logs" width={200} />
        <Segmented size="sm" value={streamF} onChange={setStreamF} options={[
          { value: 'all', label: 'All' }, { value: 'stdout', label: 'stdout' }, { value: 'stderr', label: 'stderr' },
        ]} />
        <select className="select select-sm" value={tail} onChange={(e) => setTail(e.target.value)} title="Initial lines to load">
          <option value="200">Last 200</option><option value="1000">Last 1,000</option><option value="5000">Last 5,000</option><option value="all">All</option>
        </select>
        <div className="flex-1" />
        <span className="subbar-info">
          {status === 'loading' ? <><Spinner size={11} /> Loading</> : status === 'live' ? <><span className="live-dot" /> Live</> : 'Stream ended'}
          <span className="sep">·</span>{visible.length.toLocaleString()} lines{errors > 0 && <><span className="sep">·</span><span className="text-red">{errors} errors</span></>}
        </span>
        <Capsule>
          <IconButton icon={Clock} label="Timestamps" active={showTs} onClick={() => setShowTs(!showTs)} />
          <IconButton icon={WrapText} label="Wrap lines" active={wrap} onClick={() => setWrap(!wrap)} />
          <IconButton icon={Eraser} label="Clear" onClick={() => { lines.current = []; setVer((v) => v + 1); }} />
          <IconButton icon={Download} label="Download logs" onClick={download} />
        </Capsule>
      </div>
      <div className={`log-view${wrap ? ' wrap' : ''}`} ref={scroller} onScroll={onScroll}>
        {visible.length === 0 && status !== 'loading' && (
          <Empty icon={ScrollText} title={q ? 'No matching lines' : 'No logs yet'} message={q ? 'Try a different filter.' : 'Output written to stdout/stderr appears here in real time.'} />
        )}
        {visible.map((l) => <LogLine key={l.n} l={l} showTs={showTs} q={q} />)}
      </div>
      {!follow && (
        <button className="jump-bottom" onClick={() => { setFollow(true); scroller.current!.scrollTop = scroller.current!.scrollHeight; }}>
          <ArrowDown size={13} strokeWidth={2.4} /> Follow
        </button>
      )}
    </div>
  );
}
