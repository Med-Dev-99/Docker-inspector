import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Cpu } from 'lucide-react';
import { engine } from '../../lib/api';
import { Button, Empty, Loading, SearchField } from '../../components/ui';
import { containerDo } from '../../lib/actions';
import { mem } from '../../lib/format';

export function ProcessesTab({ c }: { c: any }) {
  const running = c.State.Status === 'running' || c.State.Status === 'paused';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['top', c.Id],
    queryFn: () => engine.get<{ Titles: string[]; Processes: string[][] }>(`/containers/${c.Id}/top?ps_args=${encodeURIComponent('aux')}`)
      .catch(() => engine.get<{ Titles: string[]; Processes: string[][] }>(`/containers/${c.Id}/top`)),
    enabled: running,
    refetchInterval: 3000,
  });

  const rows = useMemo(() => {
    let r = data?.Processes || [];
    if (filter) r = r.filter((p) => p.join(' ').toLowerCase().includes(filter.toLowerCase()));
    if (sort) {
      r = [...r].sort((a, b) => {
        const x = a[sort.col], y = b[sort.col];
        const nx = Number(x), ny = Number(y);
        return (isNaN(nx) || isNaN(ny) ? x.localeCompare(y) : nx - ny) * sort.dir;
      });
    }
    return r;
  }, [data, filter, sort]);

  if (!running) {
    return <Empty icon={Cpu} title="Container is not running" message="Process list is available while the container runs."
      action={<Button variant="primary" onClick={() => containerDo(c.Id, c.Name.slice(1), 'start')}>Start Container</Button>} />;
  }
  if (isLoading) return <Loading />;
  if (error) return <Empty icon={Cpu} title="Couldn’t list processes" message={(error as Error).message} />;
  const titles = data?.Titles || [];
  const cmdCol = titles.findIndex((t) => t === 'COMMAND' || t === 'CMD');
  const kibCols = new Set(titles.map((t, i) => (t === 'VSZ' || t === 'RSS' ? i : -1)).filter((i) => i >= 0));

  return (
    <div className="processes">
      <div className="subbar">
        <SearchField value={filter} onChange={setFilter} placeholder="Filter processes" />
        <div className="flex-1" />
        <span className="subbar-info"><span className="live-dot" /> {rows.length} processes · refreshing every 3s</span>
      </div>
      <div className="scroll">
        <table className="table proc-table">
          <thead>
            <tr>
              {titles.map((t, i) => (
                <th key={t} className={i === cmdCol ? 'cmd' : ''} onClick={() => setSort(sort?.col === i ? { col: i, dir: sort.dir === 1 ? -1 : 1 } : { col: i, dir: -1 })}>
                  {t}{sort?.col === i && (sort.dir === 1 ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={i}>
                {p.map((v, j) => (
                  <td key={j} className={j === cmdCol ? 'mono cmd' : 'mono small'} title={j === cmdCol ? v : undefined}>
                    {kibCols.has(j) && /^\d+$/.test(v) ? mem(Number(v) * 1024) : v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
