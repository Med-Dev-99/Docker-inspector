// macOS notification-style toasts.
import { useSyncExternalStore } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';

export interface Toast { id: number; kind: 'success' | 'error' | 'info' | 'warning'; title: string; message?: string; leaving?: boolean }

let items: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { items = [...items]; listeners.forEach((l) => l()); };

export function toast(t: Omit<Toast, 'id'>) {
  const id = nextId++;
  items.push({ ...t, id });
  if (items.length > 4) items.shift();
  emit();
  setTimeout(() => dismiss(id), t.kind === 'error' ? 7000 : 4200);
  return id;
}

export function dismiss(id: number) {
  const t = items.find((x) => x.id === id);
  if (!t || t.leaving) return;
  t.leaving = true;
  emit();
  setTimeout(() => { items = items.filter((x) => x.id !== id); emit(); }, 220);
}

export const toastError = (title: string, e: unknown) => toast({ kind: 'error', title, message: e instanceof Error ? e.message : String(e) });

const ICONS = { success: CircleCheck, error: CircleX, info: Info, warning: TriangleAlert };

export function Toaster() {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => items);
  return (
    <div className="toaster">
      {list.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}${t.leaving ? ' leaving' : ''}`}>
            <div className="toast-icon"><Icon size={18} strokeWidth={2.2} /></div>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-msg">{t.message}</div>}
            </div>
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={12} strokeWidth={2.5} /></button>
          </div>
        );
      })}
    </div>
  );
}
