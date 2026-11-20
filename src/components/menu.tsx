// Dropdown menus and right-click context menus.
import { ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export type MenuItem =
  | { separator: true }
  | { label: string; icon?: LucideIcon; onClick?: () => void; destructive?: boolean; disabled?: boolean; shortcut?: string; checked?: boolean; header?: false }
  | { header: true; label: string };

let state: { x: number; y: number; items: MenuItem[]; anchor?: DOMRect } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openMenu(x: number, y: number, items: MenuItem[], anchor?: DOMRect) {
  state = { x, y, items, anchor };
  emit();
}
export function closeMenu() { if (state) { state = null; emit(); } }

export function onContextMenu(items: MenuItem[] | (() => MenuItem[])) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, typeof items === 'function' ? items() : items);
  };
}

export function MenuHost() {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    if (!s || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let x = s.x, y = s.y;
    if (s.anchor) {
      x = s.anchor.right - r.width;
      y = s.anchor.bottom + 6;
      if (x < 8) x = s.anchor.left;
      if (y + r.height > innerHeight - 8) y = s.anchor.top - r.height - 6;
    } else {
      if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
      if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
    }
    setPos({ x, y });
    setActive(-1);
  }, [s]);

  useEffect(() => {
    if (!s) return;
    const close = () => closeMenu();
    const onKey = (e: KeyboardEvent) => {
      const actionable = s.items.map((it, i) => ('onClick' in it && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = actionable.indexOf(active);
        const n = e.key === 'ArrowDown' ? actionable[(idx + 1) % actionable.length] : actionable[(idx - 1 + actionable.length) % actionable.length];
        setActive(n ?? -1);
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        const it = s.items[active] as any;
        closeMenu();
        it.onClick?.();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [s, active]);

  if (!s) return null;
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {s.items.map((it, i) => {
        if ('separator' in it) return <div key={i} className="menu-sep" />;
        if (it.header) return <div key={i} className="menu-header">{it.label}</div>;
        const Icon = it.icon;
        return (
          <button
            key={i}
            className={`menu-item${it.destructive ? ' destructive' : ''}${active === i ? ' active' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => { closeMenu(); it.onClick?.(); }}
          >
            <span className="menu-icon">{it.checked !== undefined ? (it.checked ? '✓' : '') : Icon ? <Icon size={14} strokeWidth={2} /> : null}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

export function MenuButton({ items, children, className = 'btn btn-icon', title }: { items: MenuItem[] | (() => MenuItem[]); children: ReactNode; className?: string; title?: string }) {
  return (
    <button
      className={className}
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (state) { closeMenu(); return; }
        openMenu(r.left, r.bottom, typeof items === 'function' ? items() : items, r);
      }}
    >
      {children}
    </button>
  );
}
