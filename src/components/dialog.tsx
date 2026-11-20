// Modal sheets and macOS-style alert dialogs.
import { ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert, X } from 'lucide-react';
import { AppGlyph } from './ui';

export function Sheet({ open, onClose, title, subtitle, icon, children, footer, width = 520, className = '' }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; icon?: ReactNode;
  children: ReactNode; footer?: ReactNode; width?: number; className?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); setClosing(false); }
    else if (mounted) { setClosing(true); const t = setTimeout(() => { setMounted(false); setClosing(false); }, 160); return () => clearTimeout(t); }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className={`overlay${closing ? ' closing' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet ${className}`} style={{ width }} role="dialog" aria-modal="true">
        <div className="sheet-head">
          {icon && <div className="sheet-icon">{icon}</div>}
          <div className="sheet-titles">
            <div className="sheet-title">{title}</div>
            {subtitle && <div className="sheet-subtitle">{subtitle}</div>}
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close"><X size={14} strokeWidth={2.4} /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ confirm()
interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  checkbox?: string;
  checkboxDefault?: boolean;
}
interface Pending extends ConfirmOpts { resolve: (v: { ok: boolean; checked: boolean }) => void }

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirm(opts: ConfirmOpts): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    pending?.resolve({ ok: false, checked: false });
    pending = { ...opts, resolve };
    emit();
  });
}

export function DialogHost() {
  const p = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => pending);
  const [checked, setChecked] = useState(false);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p) { setChecked(!!p.checkboxDefault); setTimeout(() => okRef.current?.focus(), 30); }
  }, [p]);
  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  if (!p) return null;
  const done = (ok: boolean) => {
    p.resolve({ ok, checked });
    pending = null;
    emit();
  };
  return createPortal(
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) done(false); }}>
      <div className="alert" role="alertdialog">
        <div className="alert-icon">
          <AppGlyph size={56} />
          {p.destructive && <div className="alert-badge"><TriangleAlert size={16} strokeWidth={2.4} /></div>}
        </div>
        <div className="alert-title">{p.title}</div>
        {p.message && <div className="alert-msg">{p.message}</div>}
        {p.checkbox && (
          <label className="check alert-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{p.checkbox}</span>
          </label>
        )}
        <div className="alert-buttons">
          <button className="btn btn-lg" onClick={() => done(false)}>{p.cancelLabel || 'Cancel'}</button>
          <button ref={okRef} className={`btn btn-lg ${p.destructive ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>
            {p.confirmLabel || 'OK'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
