import { useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon, AlertTriangle, ArrowRight, Box, ChevronRight, CircleCheck, Copy, EyeOff, Info, Lock, RefreshCw, Rocket, ShieldAlert, Stethoscope, Wrench, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Page } from '../components/layout';
import { Ring } from '../components/charts';
import { Button, Capsule, Empty, Group, IconButton, Loading, Pill, Segmented, Spinner, copyText } from '../components/ui';
import { MenuButton } from '../components/menu';
import { confirm } from '../components/dialog';
import { toast, toastError } from '../components/toast';
import { applyUpdate, Finding, Fix, ignoreFinding, refreshDoctor, Severity, unignoreFinding, useDoctor } from '../lib/history';
import { navigate } from '../lib/router';
import { ago } from '../lib/format';

type Category = 'all' | Finding['category'];
const SEV: { key: Severity; label: string; color: string; icon: LucideIcon }[] = [
  { key: 'critical', label: 'Critical', color: 'red', icon: AlertOctagon },
  { key: 'high', label: 'High', color: 'orange', icon: ShieldAlert },
  { key: 'medium', label: 'Medium', color: 'yellow', icon: AlertTriangle },
  { key: 'low', label: 'Low', color: 'blue', icon: Info },
  { key: 'info', label: 'Suggestions', color: 'gray', icon: Rocket },
];
const CAT_ICON: Record<string, LucideIcon> = { security: Lock, reliability: Zap, resources: Box, maintenance: Wrench };
const gradeColor = (g: string) => (g === 'A' || g === 'B' ? 'var(--green)' : g === 'C' ? 'var(--yellow)' : g === 'D' ? 'var(--orange)' : 'var(--red)');

export function DoctorView() {
  const { data, isLoading, error } = useDoctor();
  const [category, setCategory] = useState<Category>('all');
  const [scanning, setScanning] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const rescan = async () => { setScanning(true); try { await refreshDoctor(); } catch (e) { toastError('Scan failed', e); } finally { setScanning(false); } };
  useEffect(() => { refreshDoctor().catch(() => {}); }, []);

  const active = useMemo(() => (data?.findings || []).filter((f) => !f.ignored && (category === 'all' || f.category === category)), [data, category]);
  const ignored = (data?.findings || []).filter((f) => f.ignored);
  const catCount = (c: Category) => (data?.findings || []).filter((f) => !f.ignored && f.severity !== 'info' && (c === 'all' || f.category === c)).length;

  return (
    <Page title="Doctor" subtitle={data ? `Checked ${ago(data.generatedAt)} · ${data.containers.length} containers` : undefined}
      toolbar={<>
        <Segmented value={category} onChange={setCategory} options={[
          { value: 'all', label: `All ${catCount('all') || ''}`.trim() },
          { value: 'security', label: 'Security' }, { value: 'reliability', label: 'Reliability' },
          { value: 'resources', label: 'Resources' }, { value: 'maintenance', label: 'Upkeep' },
        ]} />
        <Capsule><IconButton icon={RefreshCw} label="Check again" className={scanning ? 'spinning' : ''} onClick={rescan} /></Capsule>
      </>}>
      <div className="scroll pad doctor">
        {isLoading && <Loading label="Checking your containers…" />}
        {error && <Empty icon={Stethoscope} title="Couldn’t run the checks" message={(error as Error).message} />}
        {data && (
          <>
            <div className="doctor-hero card">
              <Ring value={data.score} size={116} stroke={11} color={gradeColor(data.grade)}>
                <div className="grade" style={{ color: gradeColor(data.grade) }}>{data.grade}</div>
                <div className="ring-small">{data.score}/100</div>
              </Ring>
              <div className="doctor-summary">
                <div className="doctor-headline">
                  {data.counts.critical + data.counts.high > 0
                    ? `${data.counts.critical + data.counts.high} thing${data.counts.critical + data.counts.high === 1 ? '' : 's'} need${data.counts.critical + data.counts.high === 1 ? 's' : ''} your attention`
                    : data.counts.medium + data.counts.low > 0 ? 'Looking good, with a few improvements to make' : 'Everything looks healthy'}
                </div>
                <div className="doctor-counts">
                  {SEV.filter((s) => s.key !== 'info').map((s) => (
                    <span key={s.key} className={`count-chip cc-${s.color}${data.counts[s.key] ? '' : ' zero'}`}><b>{data.counts[s.key]}</b> {s.label.toLowerCase()}</span>
                  ))}
                </div>
                <div className="muted small">
                  Doctor audits how your containers are <i>configured</i> and how they behave: exposed ports, restart and memory settings, log growth, outdated images, crash loops.
                  {data.engine.ufw && data.engine.native ? ' Your UFW firewall is on, and Docker bypasses it for published ports - that is checked too.' : ''}
                </div>
              </div>
              <div className="doctor-containers">
                <div className="top-head">Container health</div>
                {data.containers.slice(0, 7).map((c) => (
                  <a key={c.id} className="top-row" onClick={() => navigate(`/containers/${c.id}`)}>
                    <span className="truncate">{c.name}</span>
                    <span className="grade-chip" style={{ background: gradeColor(c.grade) }}>{c.grade}</span>
                  </a>
                ))}
                {data.containers.length > 7 && <div className="muted small">+{data.containers.length - 7} more</div>}
              </div>
            </div>

            {active.filter((f) => f.severity !== 'info').length === 0 && (
              <Empty icon={CircleCheck} title={category === 'all' ? 'No problems found' : 'Nothing to fix here'} message={category === 'all' ? 'Your containers pass every check.' : 'This category is clean.'} />
            )}

            {SEV.filter((s) => s.key !== 'info').map((s) => {
              const items = active.filter((f) => f.severity === s.key);
              if (!items.length) return null;
              return (
                <section key={s.key} className="group">
                  <div className="group-head"><div className={`group-title sev-title sev-${s.color}`}><s.icon size={14} /> {s.label} <span className="muted">({items.length})</span></div></div>
                  <div className="findings">{items.map((f) => <FindingCard key={f.key} f={f} />)}</div>
                </section>
              );
            })}

            {active.some((f) => f.severity === 'info') && (
              <section className="group">
                <div className="group-head clickable" onClick={() => setShowInfo(!showInfo)}>
                  <div className="group-title sev-title"><ChevronRight size={13} className={`gh-chev${showInfo ? ' open' : ''}`} /> Suggestions <span className="muted">({active.filter((f) => f.severity === 'info').length})</span></div>
                </div>
                {showInfo && <div className="findings">{active.filter((f) => f.severity === 'info').map((f) => <FindingCard key={f.key} f={f} />)}</div>}
              </section>
            )}

            {ignored.length > 0 && (
              <section className="group">
                <div className="group-head clickable" onClick={() => setShowIgnored(!showIgnored)}>
                  <div className="group-title sev-title"><ChevronRight size={13} className={`gh-chev${showIgnored ? ' open' : ''}`} /> Ignored <span className="muted">({ignored.length})</span></div>
                </div>
                {showIgnored && (
                  <Group flush>
                    {ignored.map((f) => (
                      <div key={f.key} className="link-row static">
                        <EyeOff size={13} className="muted" /><span className="truncate">{f.target ? `${f.target.name}: ` : ''}{f.title}</span><span className="flex-1" />
                        <Button size="sm" onClick={() => unignoreFinding(f.key).then(() => unignoreFinding(`${f.check}:*`))}>Stop ignoring</Button>
                      </div>
                    ))}
                  </Group>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

function FindingCard({ f }: { f: Finding }) {
  const sev = SEV.find((s) => s.key === f.severity)!;
  const CatIcon = CAT_ICON[f.category] || Wrench;
  return (
    <div className={`finding fs-${sev.color}`}>
      <div className="finding-bar" />
      <div className="finding-main">
        <div className="finding-head">
          <div className="finding-title">{f.title}</div>
          <div className="finding-tags">
            {f.target && <a className="target-chip" onClick={() => navigate(`/containers/${f.target!.id}`)}><Box size={11} />{f.target.name}</a>}
            <span className="cat-chip"><CatIcon size={11} />{f.category}</span>
          </div>
        </div>
        <div className="finding-detail">{f.detail}</div>
        <div className="finding-actions">
          {f.fixes.map((x, i) => <FixButton key={i} fix={x} f={f} primary={i === 0} />)}
          <span className="flex-1" />
          <MenuButton className="btn-icon" title="More" items={[
            { label: f.target ? `Ignore for ${f.target.name}` : 'Ignore this', icon: EyeOff, onClick: () => ignoreFinding(f.key).then(() => toast({ kind: 'info', title: 'Ignored', message: 'You can restore it from the Ignored section.' })) },
            ...(f.target ? [{ label: 'Ignore for every container', icon: EyeOff, onClick: () => ignoreFinding(`${f.check}:*`) }] : []),
          ]}><span className="dots">···</span></MenuButton>
        </div>
      </div>
    </div>
  );
}

function FixButton({ fix, f, primary }: { fix: Fix; f: Finding; primary: boolean }) {
  const [busy, setBusy] = useState(false);
  if (fix.kind === 'copy') {
    return <Button size="sm" icon={Copy} onClick={() => copyText(fix.text, 'Copied - paste it into your compose file or terminal')}>{fix.label}</Button>;
  }
  if (fix.kind === 'navigate') {
    return <Button size="sm" onClick={() => navigate(fix.to)}>{fix.label}<ArrowRight size={12} /></Button>;
  }
  return (
    <Button size="sm" variant={primary ? 'primary' : undefined} disabled={busy || !f.target} onClick={async () => {
      const r = await confirm({ title: fix.label + '?', message: `This changes “${f.target?.name}” right away, without restarting it. You can revert it from Overview → Resources & Restart.`, confirmLabel: 'Apply' });
      if (!r.ok || !f.target) return;
      setBusy(true);
      try {
        const res = await applyUpdate(f.target.id, fix.body);
        if (res?.Warnings?.length) toast({ kind: 'warning', title: 'Applied with warnings', message: res.Warnings.join('\n') });
        else toast({ kind: 'success', title: 'Applied', message: fix.label });
      } catch (e) { toastError('Couldn’t apply the change', e); } finally { setBusy(false); }
    }}>{busy ? <Spinner size={12} /> : <Wrench size={13} />}{fix.label}</Button>
  );
}
