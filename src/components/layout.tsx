// Window chrome: traffic lights, sidebar, toolbar and page scaffolding.
import { ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { Activity, AlertOctagon, Box, Database, Gauge, HardDrive, History, Layers, Moon, Network, Server, Settings, Rocket, Stethoscope, Sun, SunMoon, Bell, BellOff, Command, PanelLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { navigate, useRoute } from '../lib/router';
import { socket } from '../lib/ws';
import { useContainers, useImages, useMeta, useVolumes, useNetworks, project, prefs, DesktopSettings } from '../lib/docker';
import { useCrashes, useDoctor } from '../lib/history';
import { MenuButton } from './menu';
import { AppGlyph, StatusDot } from './ui';

// ------------------------------------------------------------------ prefs / theme
export type Theme = 'auto' | 'light' | 'dark';
const prefListeners = new Set<() => void>();
let prefState = prefs();
export function setPref(key: string, value: unknown) {
  prefState = { ...prefState, [key]: value };
  try { localStorage.setItem('di.prefs', JSON.stringify(prefState)); } catch {}
  prefListeners.forEach((l) => l());
}
export function usePrefs() {
  return useSyncExternalStore((l) => { prefListeners.add(l); return () => { prefListeners.delete(l); }; }, () => prefState);
}
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
let themeChoice: Theme = 'auto';
function resolveTheme() {
  const dark = themeChoice === 'dark' || (themeChoice === 'auto' && darkMq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
darkMq.addEventListener('change', resolveTheme);
/** Settings owned by the Electron main process (background monitoring, login item, notifications). */
export function useDesktopSettings() {
  const [s, setS] = useState<DesktopSettings | null>(null);
  useEffect(() => {
    const d = window.desktop;
    if (!d?.getSettings) return;
    d.getSettings().then(setS).catch(() => {});
    return d.onSettings(setS);
  }, []);
  return s;
}

export function applyTheme(t: Theme) {
  themeChoice = t;
  resolveTheme();
}

// ------------------------------------------------------------------ traffic lights
export function TrafficLights() {
  if (!window.desktop) return <div className="traffic-spacer" />;
  return (
    <div className="traffic">
      <button className="tl tl-close" onClick={() => window.desktop!.close()} aria-label="Close">
        <svg viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" /></svg>
      </button>
      <button className="tl tl-min" onClick={() => window.desktop!.minimize()} aria-label="Minimize">
        <svg viewBox="0 0 12 12"><path d="M2.8 6h6.4" /></svg>
      </button>
      <button className="tl tl-max" onClick={() => window.desktop!.toggleMaximize()} aria-label="Zoom">
        <svg viewBox="0 0 12 12"><path className="fill" d="M3.3 4.4v4.3h4.3zM8.7 7.6V3.3H4.4z" /></svg>
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ sidebar
function useSocketStatus() {
  return useSyncExternalStore((l) => socket.onStatus(l), () => socket.status);
}

function NavItem({ icon: Icon, label, to, badge, active, tint }: { icon: LucideIcon; label: string; to: string; badge?: ReactNode; active: boolean; tint: string }) {
  return (
    <a className={`nav-item${active ? ' active' : ''}`} href={'#' + to} onClick={(e) => { e.preventDefault(); navigate(to); }}>
      <span className={`nav-icon tint-${tint}`}><Icon size={15} strokeWidth={2} /></span>
      <span className="nav-label">{label}</span>
      {badge !== undefined && badge !== null && <span className="nav-badge">{badge}</span>}
    </a>
  );
}

export function Sidebar({ onPalette }: { onPalette: () => void }) {
  const route = useRoute();
  const section = route.parts[0] || 'overview';
  const { data: containers } = useContainers();
  const { data: images } = useImages();
  const { data: volumes } = useVolumes();
  const { data: networks } = useNetworks();
  const { data: meta } = useMeta();
  const status = useSocketStatus();
  const p = usePrefs();
  const ds = useDesktopSettings();
  const { data: crashes } = useCrashes();
  const { data: doctor } = useDoctor();
  const unread = crashes?.unread || 0;
  const urgent = doctor ? doctor.counts.critical + doctor.counts.high : 0;

  const running = containers?.filter((c) => c.State === 'running').length;
  const projects = new Map<string, { total: number; running: number }>();
  for (const c of containers || []) {
    const pr = project(c.Labels);
    if (!pr) continue;
    const e = projects.get(pr) || { total: 0, running: 0 };
    e.total++;
    if (c.State === 'running') e.running++;
    projects.set(pr, e);
  }
  const activeProject = section === 'containers' ? route.query.get('project') : null;
  const sortedProjects = [...projects.entries()].sort((a, b) => (b[1].running > 0 ? 1 : 0) - (a[1].running > 0 ? 1 : 0) || a[0].localeCompare(b[0]));

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <TrafficLights />
        <button className="btn-icon sidebar-cmd no-drag" title="Quick Open (Ctrl+K)" onClick={onPalette}><Command size={14} strokeWidth={2} /></button>
      </div>
      <nav className="sidebar-scroll">
        <div className="nav-group">
          <NavItem icon={Gauge} label="Overview" to="/overview" active={section === 'overview'} tint="blue" />
          <NavItem icon={Box} label="Containers" to="/containers" active={section === 'containers' && !activeProject} tint="blue"
            badge={containers ? <><b>{running}</b>/{containers.length}</> : null} />
          <NavItem icon={Layers} label="Images" to="/images" active={section === 'images'} tint="purple" badge={images?.length} />
          <NavItem icon={Database} label="Volumes" to="/volumes" active={section === 'volumes'} tint="orange" badge={volumes?.length} />
          <NavItem icon={Network} label="Networks" to="/networks" active={section === 'networks'} tint="teal" badge={networks?.length} />
        </div>
        <div className="nav-heading">Monitor</div>
        <div className="nav-group">
          <NavItem icon={Stethoscope} label="Doctor" to="/doctor" active={section === 'doctor'} tint="green"
            badge={doctor ? <span className={`grade-badge g-${doctor.grade}`} title={`${urgent} urgent`}>{doctor.grade}</span> : null} />
          <NavItem icon={AlertOctagon} label="Crash reports" to="/crashes" active={section === 'crashes'} tint="red"
            badge={unread ? <span className="badge-red">{unread}</span> : crashes?.crashes.length ?? null} />
          <NavItem icon={History} label="Timeline" to="/timeline" active={section === 'timeline'} tint="indigo" />
          <NavItem icon={HardDrive} label="Disk Usage" to="/storage" active={section === 'storage'} tint="pink" />
          <NavItem icon={Activity} label="Activity" to="/activity" active={section === 'activity'} tint="green" />
          <NavItem icon={Server} label="Engine" to="/system" active={section === 'system'} tint="gray" />
        </div>
        {sortedProjects.length > 0 && (
          <>
            <div className="nav-heading">Compose Projects</div>
            <div className="nav-group">
              {sortedProjects.map(([name, s]) => (
                <a key={name} className={`nav-item nav-project${activeProject === name ? ' active' : ''}`} href={`#/containers?project=${encodeURIComponent(name)}`}
                  onClick={(e) => { e.preventDefault(); navigate(`/containers?project=${encodeURIComponent(name)}`); }} title={name}>
                  <span className="nav-icon"><StatusDot color={s.running ? (s.running === s.total ? 'green' : 'orange') : 'gray'} /></span>
                  <span className="nav-label">{name}</span>
                  <span className="nav-badge">{s.running}/{s.total}</span>
                </a>
              ))}
            </div>
          </>
        )}
      </nav>
      <div className="sidebar-foot">
        <div className="engine-status" title={meta ? `Socket ${meta.socket} · API ${meta.apiVersion}` : ''}>
          <StatusDot color={status === 'open' ? 'green' : status === 'connecting' ? 'yellow' : 'red'} pulse={status === 'open'} />
          <div className="engine-text">
            <div className="engine-name">Docker Engine</div>
            <div className="engine-sub">{status === 'open' ? `v${meta?.engine?.Version ?? ''} · Connected` : status === 'connecting' ? 'Connecting…' : 'Disconnected — retrying'}</div>
          </div>
        </div>
        <MenuButton className="btn-icon" title="Settings" items={() => [
          { header: true, label: 'Appearance' },
          { label: 'Automatic', icon: SunMoon, checked: (p.theme || 'auto') === 'auto', onClick: () => { setPref('theme', 'auto'); applyTheme('auto'); } },
          { label: 'Light', icon: Sun, checked: p.theme === 'light', onClick: () => { setPref('theme', 'light'); applyTheme('light'); } },
          { label: 'Dark', icon: Moon, checked: p.theme === 'dark', onClick: () => { setPref('theme', 'dark'); applyTheme('dark'); } },
          { separator: true },
          { header: true, label: 'Notifications' },
          { label: p.alerts === false ? 'In-app crash alerts off' : 'In-app crash alerts on', icon: p.alerts === false ? BellOff : Bell, checked: p.alerts !== false, onClick: () => setPref('alerts', p.alerts === false) },
          ...(ds ? [
            { label: 'Desktop notifications', icon: Bell, checked: ds.notifications, onClick: () => window.desktop!.setSettings({ notifications: !ds.notifications }) } as const,
            { separator: true } as const,
            { header: true, label: 'Background' } as const,
            { label: 'Keep monitoring when closed', icon: History, checked: ds.runInBackground, onClick: () => window.desktop!.setSettings({ runInBackground: !ds.runInBackground }) } as const,
            { label: 'Start at login', icon: Rocket, checked: ds.startAtLogin, onClick: () => window.desktop!.setSettings({ startAtLogin: !ds.startAtLogin }) } as const,
          ] : []),
        ]}>
          <Settings size={15} strokeWidth={1.9} />
        </MenuButton>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ page scaffolding
export function Toolbar({ title, subtitle, children, leading }: { title?: ReactNode; subtitle?: ReactNode; children?: ReactNode; leading?: ReactNode }) {
  return (
    <header className="toolbar drag">
      {leading}
      {title !== undefined && (
        <div className="toolbar-titles">
          <div className="toolbar-title">{title}</div>
          {subtitle && <div className="toolbar-subtitle">{subtitle}</div>}
        </div>
      )}
      <div className="toolbar-spacer" />
      <div className="toolbar-items no-drag">{children}</div>
    </header>
  );
}

export function Page({ title, subtitle, toolbar, children, className = '' }: { title: ReactNode; subtitle?: ReactNode; toolbar?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`page ${className}`}>
      <Toolbar title={title} subtitle={subtitle}>{toolbar}</Toolbar>
      <div className="page-body">{children}</div>
    </div>
  );
}

/** Mail-style split: list column + detail column. */
export function Split({ list, detail, listWidth = 360 }: { list: ReactNode; detail: ReactNode; listWidth?: number }) {
  const [w, setW] = useState(() => {
    try { return Number(localStorage.getItem('di.listWidth')) || listWidth; } catch { return listWidth; }
  });
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = w;
    const move = (ev: MouseEvent) => setW(Math.min(560, Math.max(280, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  useEffect(() => { try { localStorage.setItem('di.listWidth', String(w)); } catch {} }, [w]);
  return (
    <div className="split">
      <div className="split-list" style={{ width: w }}>{list}</div>
      <div className="split-handle" onMouseDown={onDown} />
      <div className="split-detail">{detail}</div>
    </div>
  );
}

export function useWindowState() {
  const [focused, setFocused] = useState(true);
  const [maximized, setMax] = useState(false);
  useEffect(() => {
    if (!window.desktop) return;
    window.desktop.isMaximized().then(setMax);
    const a = window.desktop.onMaximizeChange(setMax);
    const b = window.desktop.onFocusChange(setFocused);
    return () => { a(); b(); };
  }, []);
  return { focused, maximized };
}

export { AppGlyph, PanelLeft };
