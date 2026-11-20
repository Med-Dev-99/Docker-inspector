import { useCallback, useEffect, useState } from 'react';
import { Sidebar, usePrefs, applyTheme, useWindowState } from './components/layout';
import { Toaster } from './components/toast';
import { DialogHost } from './components/dialog';
import { MenuHost, closeMenu } from './components/menu';
import { Palette } from './components/Palette';
import { useRoute, navigate } from './lib/router';
import { useLiveUpdates, queryClient } from './lib/docker';
import { startStats } from './lib/stats';
import { socket } from './lib/ws';
import { DashboardView } from './views/Dashboard';
import { ContainersView } from './views/Containers';
import { ImagesView } from './views/Images';
import { VolumesView } from './views/Volumes';
import { NetworksView } from './views/Networks';
import { StorageView } from './views/Storage';
import { ActivityView } from './views/Activity';
import { SystemView } from './views/System';
import { TimelineView } from './views/Timeline';
import { CrashesView } from './views/Crashes';
import { DoctorView } from './views/Doctor';
import { toast } from './components/toast';
import { PruneSheet } from './views/sheets/Prune';
import { PullImageSheet } from './views/sheets/PullImage';

export function App() {
  const route = useRoute();
  const prefs = usePrefs();
  const { focused, maximized } = useWindowState();
  const [palette, setPalette] = useState(false);
  const [prune, setPrune] = useState(false);
  const [pull, setPull] = useState(false);
  useLiveUpdates();

  useEffect(() => { socket.start(); startStats(); }, []);
  useEffect(() => { applyTheme(prefs.theme || 'auto'); }, [prefs.theme]);
  useEffect(() => { if (!route.parts.length) navigate('/overview', true); }, [route.parts.length]);
  useEffect(() => { setPalette(false); closeMenu(); }, [route.path]);

  // Crash reports pushed by the backend: refresh lists and show an actionable toast.
  useEffect(() => socket.subscribe('crashes', ({ crash }) => {
    queryClient.invalidateQueries({ queryKey: ['crashes'] });
    queryClient.invalidateQueries({ queryKey: ['doctor'] });
    queryClient.invalidateQueries({ queryKey: ['hist-events'] });
    if (!crash.notify || prefs.alerts === false) return;
    toast({
      kind: crash.severity === 'critical' ? 'error' : 'warning',
      title: crash.occurrences >= 3 ? `${crash.name} is stuck in a crash loop` : `${crash.name} crashed`,
      message: `${crash.title}. ${crash.summary}`,
      action: crash.id ? { label: 'See why', onClick: () => navigate(`/crashes/${crash.id}`) } : undefined,
    });
  }), [prefs.alerts]);

  // Tray menu / notification clicks ask the UI to open a page.
  useEffect(() => window.desktop?.onNavigate?.((r) => navigate(r)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      if (mod && !e.shiftKey && /^[1-8]$/.test(e.key) && !(e.target as HTMLElement).closest('.xterm')) {
        e.preventDefault();
        navigate(['/overview', '/containers', '/images', '/volumes', '/networks', '/storage', '/activity', '/system'][Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onAction = useCallback((a: 'prune' | 'pull') => (a === 'prune' ? setPrune(true) : setPull(true)), []);

  const section = route.parts[0] || 'overview';
  let view;
  switch (section) {
    case 'containers': view = <ContainersView />; break;
    case 'images': view = <ImagesView />; break;
    case 'volumes': view = <VolumesView />; break;
    case 'networks': view = <NetworksView />; break;
    case 'storage': view = <StorageView />; break;
    case 'activity': view = <ActivityView />; break;
    case 'system': view = <SystemView />; break;
    case 'timeline': view = <TimelineView />; break;
    case 'crashes': view = <CrashesView />; break;
    case 'doctor': view = <DoctorView />; break;
    default: view = <DashboardView />;
  }

  return (
    <div className={`window${focused ? '' : ' inactive'}${maximized ? ' maximized' : ''}${window.desktop ? ' desktop' : ''}`}>
      <Sidebar onPalette={() => setPalette(true)} />
      <main className="content">{view}</main>
      <Toaster />
      <DialogHost />
      <MenuHost />
      <Palette open={palette} onClose={() => setPalette(false)} onAction={onAction} />
      <PruneSheet open={prune} onClose={() => setPrune(false)} />
      <PullImageSheet open={pull} onClose={() => setPull(false)} />
    </div>
  );
}
