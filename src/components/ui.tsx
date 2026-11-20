// Core UI primitives styled after macOS.
import { ReactNode, forwardRef, useEffect, useRef, useState } from 'react';
import { Check, Copy, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from './toast';

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem('di.' + key); return raw === null ? initial : JSON.parse(raw); } catch { return initial; }
  });
  const set = (nv: T) => { setV(nv); try { localStorage.setItem('di.' + key, JSON.stringify(nv)); } catch {} };
  return [v, set];
}

export function Button({ children, icon: Icon, variant, size, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon; variant?: 'primary' | 'danger' | 'plain' | 'tinted'; size?: 'sm' | 'lg';
}) {
  return (
    <button className={`btn${variant ? ' btn-' + variant : ''}${size ? ' btn-' + size : ''} ${className}`} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className = '', size = 16, active, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon; label: string; size?: number; active?: boolean;
}) {
  return (
    <button className={`btn-icon${active ? ' active' : ''} ${className}`} title={label} aria-label={label} {...rest}>
      <Icon size={size} strokeWidth={1.9} />
    </button>
  );
}

/** Capsule group of toolbar buttons (Liquid-glass style). */
export function Capsule({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`capsule ${className}`}>{children}</div>;
}

export function Segmented<T extends string>({ value, onChange, options, size }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: LucideIcon; title?: string }[]; size?: 'sm';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-v="${CSS.escape(value)}"]`);
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, options.length]);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const el = ref.current?.querySelector<HTMLElement>(`[data-v="${CSS.escape(value)}"]`);
      if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [value]);
  return (
    <div className={`segmented${size === 'sm' ? ' sm' : ''}`} ref={ref} role="tablist">
      {ind && <div className="seg-indicator" style={{ transform: `translateX(${ind.left}px)`, width: ind.width }} />}
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button key={o.value} data-v={o.value} role="tab" aria-selected={o.value === value} title={o.title}
            className={`seg${o.value === value ? ' on' : ''}`} onClick={() => onChange(o.value)}>
            {Icon && <Icon size={13} strokeWidth={2} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const SearchField = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void; placeholder?: string; width?: number; autoFocus?: boolean }>(
  function SearchField({ value, onChange, placeholder = 'Search', width = 220, autoFocus }, ref) {
    return (
      <div className="search" style={{ width }}>
        <Search size={14} strokeWidth={2} className="search-icon" />
        <input ref={ref} value={value} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }} />
        {value && <button className="search-clear" onClick={() => onChange('')} aria-label="Clear"><X size={10} strokeWidth={3} /></button>}
      </div>
    );
  },
);

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`check${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children && <span>{children}</span>}
    </label>
  );
}

export function StatusDot({ color, pulse, size = 8 }: { color: string; pulse?: boolean; size?: number }) {
  return <span className={`dot dot-${color}${pulse ? ' pulse' : ''}`} style={{ width: size, height: size }} />;
}

export function Pill({ children, color = 'gray', icon: Icon, title }: { children: ReactNode; color?: string; icon?: LucideIcon; title?: string }) {
  return <span className={`pill pill-${color}`} title={title}>{Icon && <Icon size={11} strokeWidth={2.4} />}{children}</span>;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Empty({ icon: Icon, title, message, action }: { icon?: LucideIcon; title: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && <div className="empty-icon"><Icon size={40} strokeWidth={1.3} /></div>}
      <div className="empty-title">{title}</div>
      {message && <div className="empty-msg">{message}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading"><Spinner /> <span>{label}</span></div>;
}

/** Inset-grouped section, like System Settings. */
export function Group({ title, children, actions, className = '', footer, flush }: {
  title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; footer?: ReactNode; flush?: boolean;
}) {
  return (
    <section className={`group ${className}`}>
      {(title || actions) && (
        <div className="group-head">
          <div className="group-title">{title}</div>
          {actions && <div className="group-actions">{actions}</div>}
        </div>
      )}
      <div className={`group-box${flush ? ' flush' : ''}`}>{children}</div>
      {footer && <div className="group-foot">{footer}</div>}
    </section>
  );
}

export function Row({ label, children, mono, copy, icon: Icon, hint }: {
  label: ReactNode; children?: ReactNode; mono?: boolean; copy?: string; icon?: LucideIcon; hint?: ReactNode;
}) {
  const empty = children === undefined || children === null || children === '' || children === false;
  return (
    <div className="row">
      <div className="row-label">{Icon && <Icon size={14} strokeWidth={2} className="row-icon" />}{label}{hint && <span className="row-hint">{hint}</span>}</div>
      <div className={`row-value${mono ? ' mono' : ''}${empty ? ' muted' : ''}`}>
        {empty ? '—' : children}
        {copy && <CopyButton text={copy} />}
      </div>
    </div>
  );
}

export async function copyText(text: string, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast({ kind: 'success', title: label });
}

export function CopyButton({ text, size = 12 }: { text: string; size?: number }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy-btn" title="Copy" onClick={(e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text).catch(() => {});
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    }}>
      {done ? <Check size={size} strokeWidth={2.5} /> : <Copy size={size} strokeWidth={2} />}
    </button>
  );
}

export function Meter({ value, color = 'accent', warn = 80, danger = 92 }: { value: number; color?: string; warn?: number; danger?: number }) {
  const c = value >= danger ? 'red' : value >= warn ? 'orange' : color;
  return <div className="meter"><div className={`meter-fill bg-${c}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

/** The app's icon glyph (used in dialogs, about, sidebar). */
export function AppGlyph({ size = 32 }: { size?: number }) {
  return <img src="/icon.svg" width={size} height={size} alt="" draggable={false} className="app-glyph" />;
}

export function Kbd({ children }: { children: ReactNode }) { return <kbd className="kbd">{children}</kbd>; }

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}{hint && <span className="field-hint">{hint}</span>}</span>
    </label>
  );
}
