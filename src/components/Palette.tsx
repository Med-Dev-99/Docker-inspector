// Spotlight-style quick open (Ctrl+K).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Database, Gauge, HardDrive, Layers, Network, Search, Activity, Server, Sparkles, CloudDownload, CornerDownLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useContainers, useImages, useVolumes, useNetworks, cName, imageName, stateColor, isAnonymousVolume } from '../lib/docker';
import { navigate } from '../lib/router';
import { StatusDot } from './ui';

interface Item { id: string; label: string; sub?: string; icon: LucideIcon; to?: string; run?: () => void; dot?: string; kind: string }

export function Palette({ open, onClose, onAction }: { open: boolean; onClose: () => void; onAction: (a: 'prune' | 'pull') => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: containers } = useContainers();
  const { data: images } = useImages();
  const { data: volumes } = useVolumes();
  const { data: networks } = useNetworks();

  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      { id: 'p-overview', label: 'Overview', icon: Gauge, to: '/overview', kind: 'Go to' },
      { id: 'p-containers', label: 'Containers', icon: Box, to: '/containers', kind: 'Go to' },
      { id: 'p-images', label: 'Images', icon: Layers, to: '/images', kind: 'Go to' },
      { id: 'p-volumes', label: 'Volumes', icon: Database, to: '/volumes', kind: 'Go to' },
      { id: 'p-networks', label: 'Networks', icon: Network, to: '/networks', kind: 'Go to' },
      { id: 'p-storage', label: 'Disk Usage', icon: HardDrive, to: '/storage', kind: 'Go to' },
      { id: 'p-activity', label: 'Activity', icon: Activity, to: '/activity', kind: 'Go to' },
      { id: 'p-system', label: 'Engine', icon: Server, to: '/system', kind: 'Go to' },
      { id: 'a-prune', label: 'Clean up disk space…', icon: Sparkles, run: () => onAction('prune'), kind: 'Action' },
      { id: 'a-pull', label: 'Pull an image…', icon: CloudDownload, run: () => onAction('pull'), kind: 'Action' },
      ...(containers || []).map((c) => ({ id: c.Id, label: cName(c), sub: `${c.Image} · ${c.Status}`, icon: Box, to: `/containers/${c.Id}`, dot: stateColor(c.State, c.Status), kind: 'Container' })),
      ...(images || []).map((i) => ({ id: i.Id, label: imageName(i), sub: i.Id.slice(7, 19), icon: Layers, to: `/images/${encodeURIComponent(i.Id)}`, kind: 'Image' })),
      ...(volumes || []).filter((v) => !isAnonymousVolume(v.Name)).map((v) => ({ id: 'v' + v.Name, label: v.Name, sub: v.Driver, icon: Database, to: `/volumes/${encodeURIComponent(v.Name)}`, kind: 'Volume' })),
      ...(networks || []).map((n) => ({ id: n.Id, label: n.Name, sub: n.Driver, icon: Network, to: `/networks/${n.Id}`, kind: 'Network' })),
    ];
    if (!q) return all.filter((i) => i.kind !== 'Image' && i.kind !== 'Volume' && i.kind !== 'Network').slice(0, 30);
    const s = q.toLowerCase();
    const score = (i: Item) => {
      const l = i.label.toLowerCase();
      if (l === s) return 0;
      if (l.startsWith(s)) return 1;
      if (l.includes(s)) return 2;
      if (i.sub?.toLowerCase().includes(s)) return 3;
      return 9;
    };
    const ranked = all.map((i) => [score(i), i] as const).filter(([sc]) => sc < 9).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    // Group by kind, ordering groups by their best match (Spotlight-style).
    const order: string[] = [];
    for (const i of ranked) if (!order.includes(i.kind)) order.push(i.kind);
    return order.flatMap((k) => ranked.filter((i) => i.kind === k).slice(0, 12));
  }, [q, containers, images, volumes, networks, onAction]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('.pal-item.active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  if (!open) return null;
  const choose = (i: Item) => { onClose(); if (i.run) i.run(); else if (i.to) navigate(i.to); };

  return createPortal(
    <div className="overlay palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <div className="pal-input">
          <Search size={18} strokeWidth={2} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a container, image, volume, network…" spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active]); }
            }} />
        </div>
        <div className="pal-list" ref={listRef}>
          {items.length === 0 && <div className="pal-empty">No results</div>}
          {items.map((i, idx) => {
            const Icon = i.icon;
            const showKind = idx === 0 || items[idx - 1].kind !== i.kind;
            return (
              <div key={i.kind + i.id}>
                {showKind && <div className="pal-kind">{i.kind === 'Go to' ? 'Navigate' : i.kind === 'Action' ? 'Actions' : i.kind + 's'}</div>}
                <div className={`pal-item${idx === active ? ' active' : ''}`} onMouseEnter={() => setActive(idx)} onClick={() => choose(i)}>
                  <span className="pal-icon"><Icon size={15} strokeWidth={2} /></span>
                  <span className="pal-label truncate">{i.label}</span>
                  {i.dot && <StatusDot color={i.dot} size={7} />}
                  {i.sub && <span className="pal-sub truncate">{i.sub}</span>}
                  {idx === active && <CornerDownLeft size={13} className="pal-enter" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
