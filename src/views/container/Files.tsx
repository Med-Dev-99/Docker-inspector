import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, ChevronRight, Download, File, FileText, Folder, FolderOpen, Link2, RotateCw, X, HardDrive } from 'lucide-react';
import { api, downloadEngine } from '../../lib/api';
import { useRoute } from '../../lib/router';
import { Button, Capsule, Empty, IconButton, Loading, SearchField, CopyButton } from '../../components/ui';
import { toastError } from '../../components/toast';
import { bytes, date } from '../../lib/format';
import { containerDo } from '../../lib/actions';

interface Entry { type: 'd' | 'f' | 'l'; size: number; mtime: number; mode: string; owner: string; group: string; target: string; name: string }

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const parent = (p: string) => { const s = p.replace(/\/+$/, '').split('/'); s.pop(); return s.join('/') || '/'; };
const TEXT_EXT = /\.(txt|md|json|ya?ml|toml|ini|conf|cfg|env|sh|bash|py|js|ts|tsx|jsx|go|rs|rb|php|java|kt|c|h|cpp|hpp|cs|sql|xml|html?|css|scss|log|csv|properties|lock|gitignore|dockerfile|service|pem|crt)$/i;

export function FilesTab({ c }: { c: any }) {
  const route = useRoute();
  const running = c.State.Status === 'running';
  const [path, setPath] = useState<string>(route.query.get('path') || c.Config.WorkingDir || '/');
  const [preview, setPreview] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);

  const list = useQuery({
    queryKey: ['files', c.Id, path],
    queryFn: () => api<{ path: string; entries: Entry[] }>(`/api/files/${c.Id}/list?path=${encodeURIComponent(path)}`),
    enabled: running,
    retry: false,
  });
  const file = useQuery({
    queryKey: ['file', c.Id, preview],
    queryFn: () => api<{ content: string; binary: boolean; size: number; truncated: boolean }>(`/api/files/${c.Id}/read?path=${encodeURIComponent(preview!)}`),
    enabled: running && !!preview,
    retry: false,
  });

  const entries = useMemo(() => {
    const e = [...(list.data?.entries || [])];
    e.sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name));
    return filter ? e.filter((x) => x.name.toLowerCase().includes(filter.toLowerCase())) : e;
  }, [list.data, filter]);

  if (!running) {
    return <Empty icon={FolderOpen} title="Container is not running" message="The file browser runs commands inside the container, so it needs to be running."
      action={<Button variant="primary" onClick={() => containerDo(c.Id, c.Name.slice(1), 'start')}>Start Container</Button>} />;
  }

  const crumbs = path.split('/').filter(Boolean);
  const open = (e: Entry) => {
    const p = join(path, e.name);
    if (e.type === 'd' || (e.type === 'l' && !/\.[a-z0-9]+$/i.test(e.name))) { setPath(p); setPreview(null); setFilter(''); }
    else setPreview(p);
  };
  const download = (p: string) => downloadEngine(`/containers/${c.Id}/archive?path=${encodeURIComponent(p)}`, `${p.split('/').pop() || 'root'}.tar`)
    .catch((e) => toastError('Download failed', e));

  const mounts: any[] = c.Mounts || [];
  const mountFor = (p: string) => mounts.find((m) => p === m.Destination || p.startsWith(m.Destination + '/'));
  const mount = mountFor(path);

  return (
    <div className="files">
      <div className="subbar">
        <Capsule>
          <IconButton icon={ArrowUp} label="Enclosing folder" disabled={path === '/'} onClick={() => { setPath(parent(path)); setPreview(null); }} />
          <IconButton icon={RotateCw} label="Refresh" onClick={() => list.refetch()} />
        </Capsule>
        {editing ? (
          <input className="input input-sm path-input" autoFocus defaultValue={path}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPath((e.target as HTMLInputElement).value || '/'); setEditing(false); setPreview(null); } if (e.key === 'Escape') setEditing(false); }} />
        ) : (
          <div className="crumbs" onDoubleClick={() => setEditing(true)} title="Double-click to type a path">
            <button className="crumb" onClick={() => setPath('/')}><HardDrive size={12} /> /</button>
            {crumbs.map((p, i) => (
              <span key={i} className="crumb-wrap">
                <ChevronRight size={11} className="crumb-sep" />
                <button className="crumb" onClick={() => { setPath('/' + crumbs.slice(0, i + 1).join('/')); setPreview(null); }}>{p}</button>
              </span>
            ))}
          </div>
        )}
        <div className="flex-1" />
        {mount && <span className="subbar-info" title={mount.Source}><Folder size={12} /> {mount.Type === 'volume' ? `volume ${mount.Name?.slice(0, 24)}` : `bind ${mount.Source}`}</span>}
        <SearchField value={filter} onChange={setFilter} placeholder="Filter" width={170} />
        <Button size="sm" icon={Download} onClick={() => download(path)}>Download folder</Button>
      </div>
      <div className={`files-body${preview ? ' with-preview' : ''}`}>
        <div className="files-list">
          {list.isLoading && <Loading />}
          {list.error && <Empty icon={FolderOpen} title="Can’t read this folder" message={(list.error as Error).message} />}
          {list.data && (
            <table className="table files-table">
              <thead><tr><th>Name</th><th className="r">Size</th><th>Modified</th><th>Permissions</th><th>Owner</th></tr></thead>
              <tbody>
                {entries.map((e) => {
                  const p = join(path, e.name);
                  const Icon = e.type === 'd' ? Folder : e.type === 'l' ? Link2 : TEXT_EXT.test(e.name) ? FileText : File;
                  return (
                    <tr key={e.name} className={preview === p ? 'selected' : ''} onDoubleClick={() => open(e)} onClick={() => (e.type === 'f' ? setPreview(p) : undefined)}>
                      <td className="files-name">
                        <Icon size={15} strokeWidth={1.8} className={e.type === 'd' ? 'tint-blue' : e.type === 'l' ? 'tint-purple' : 'muted'} />
                        <button className="link-plain" onClick={(ev) => { ev.stopPropagation(); open(e); }}>{e.name}</button>
                        {e.type === 'l' && <span className="muted mono small">→ {e.target}</span>}
                        {mountFor(p) && mountFor(p)?.Destination === p && <span className="pill pill-orange">mount</span>}
                      </td>
                      <td className="r mono small">{e.type === 'd' ? '—' : bytes(e.size)}</td>
                      <td className="small muted">{e.mtime ? date(e.mtime) : '—'}</td>
                      <td className="mono small muted">{e.mode}</td>
                      <td className="small muted">{e.owner}{e.group !== e.owner ? `:${e.group}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {list.data && entries.length === 0 && <Empty icon={Folder} title={filter ? 'No matches' : 'Empty folder'} />}
        </div>
        {preview && (
          <div className="files-preview">
            <div className="preview-head">
              <FileText size={14} />
              <span className="truncate mono small" title={preview}>{preview}</span>
              <CopyButton text={preview} />
              <div className="flex-1" />
              <IconButton icon={Download} label="Download" onClick={() => download(preview)} />
              <IconButton icon={X} label="Close preview" onClick={() => setPreview(null)} />
            </div>
            <div className="preview-body">
              {file.isLoading && <Loading />}
              {file.error && <Empty title="Can’t open file" message={(file.error as Error).message} />}
              {file.data?.binary && <Empty icon={File} title="Binary file" message={`${bytes(file.data.size)}${file.data.truncated ? '+' : ''} — download it to inspect.`} />}
              {file.data && !file.data.binary && (
                <>
                  {file.data.truncated && <div className="preview-note">Showing the first 512 KB.</div>}
                  <pre className="code">{file.data.content || <span className="muted">(empty file)</span>}</pre>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
