// Formatting helpers.

export function bytes(n: number | undefined | null, opts: { binary?: boolean; digits?: number } = {}): string {
  if (n === undefined || n === null || !isFinite(n) || n < 0) return '—';
  const base = opts.binary ? 1024 : 1000;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= base && i < units.length - 1) { v /= base; i++; }
  const digits = opts.digits ?? (v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2);
  return `${v.toFixed(digits)} ${units[i]}`;
}

export const mem = (n?: number | null) => bytes(n, { binary: true });

export function rate(n: number | undefined): string {
  if (!n || n < 1) return '0 B/s';
  return `${bytes(n)}/s`;
}

export function pct(n: number | undefined, digits = 1): string {
  if (n === undefined || !isFinite(n)) return '—';
  return `${n.toFixed(n >= 100 ? 0 : digits)}%`;
}

export function num(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

export function toMs(d: string | number | undefined | null): number {
  if (d === undefined || d === null || d === '') return 0;
  if (typeof d === 'number') return d < 1e12 ? d * 1000 : d;
  if (d.startsWith('0001-')) return 0;
  return Date.parse(d) || 0;
}

export function ago(d: string | number | undefined | null): string {
  const t = toMs(d);
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 45) return 'just now';
  if (s < 90) return '1 minute ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const days = Math.round(h / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
  const months = Math.round(days / 30.4);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const y = Math.round(days / 365);
  return y === 1 ? '1 year ago' : `${y} years ago`;
}

export function duration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function nsDuration(ns?: number): string {
  if (!ns) return '—';
  const s = ns / 1e9;
  if (s < 1) return `${Math.round(ns / 1e6)}ms`;
  return duration(s);
}

export function date(d: string | number | undefined | null): string {
  const t = toMs(d);
  if (!t) return '—';
  return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function time(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const shortId = (id?: string) => (id || '').replace(/^sha256:/, '').slice(0, 12);

export function plural(n: number, word: string, pluralWord = word + 's') {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
}

export function cmd(v: string[] | string | null | undefined): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

export function cpus(nano?: number) {
  if (!nano) return 'Unlimited';
  return `${(nano / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} CPUs`;
}

const URL_CREDS = /:\/\/[^/\s:@]+:[^@\s]+@/;
const SECRET_WORDS = new Set(['PASSWORD', 'PASS', 'PASSWD', 'PWD', 'SECRET', 'SECRETS', 'TOKEN', 'APIKEY', 'KEY', 'PRIVATE', 'CREDENTIAL', 'CREDENTIALS', 'SALT', 'DSN', 'JWT', 'PASSPHRASE', 'SIGNATURE']);
const NOT_SECRET_SUFFIX = new Set(['FILE', 'PATH', 'DIR', 'SECONDS', 'TTL', 'TIMEOUT', 'ENABLED', 'HOST', 'PORT', 'USER', 'USERNAME', 'NAME', 'ID', 'LIMIT', 'SIZE', 'INTERVAL', 'MODE', 'TYPE', 'LENGTH', 'COUNT', 'HEADER', 'URL_PATH']);

/** Heuristic: does this env var probably hold a credential? */
export function isSecretKey(k: string, v = ''): boolean {
  if (URL_CREDS.test(v)) return true;
  const segs = k.toUpperCase().split(/[_\-.]+/).filter(Boolean);
  if (!segs.length || NOT_SECRET_SUFFIX.has(segs[segs.length - 1])) return false;
  return segs.some((s) => SECRET_WORDS.has(s)) || /(PASSWORD|SECRET|TOKEN|APIKEY)$/.test(k.toUpperCase());
}
