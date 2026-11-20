// Minimal ANSI SGR parser for log rendering.

export interface Span { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

const BASIC = (n: number) => `var(--ansi-${n})`;

function c256(n: number): string {
  if (n < 16) return BASIC(n);
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16;
  const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6;
  const map = (x: number) => (x ? 55 + x * 40 : 0);
  return `rgb(${map(r)},${map(g)},${map(b)})`;
}

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;

export function hasAnsi(s: string) { return s.includes('\x1b'); }

export function stripAnsi(s: string) { return s.replace(ESC, ''); }

export function parseAnsi(input: string): Span[] {
  const out: Span[] = [];
  let cur: Omit<Span, 'text'> = {};
  let last = 0;
  ESC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC.exec(input))) {
    if (m.index > last) out.push({ ...cur, text: input.slice(last, m.index) });
    last = ESC.lastIndex;
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(';').map((x) => Number(x || 0));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) cur = {};
      else if (c === 1) cur.bold = true;
      else if (c === 2) cur.dim = true;
      else if (c === 3) cur.italic = true;
      else if (c === 4) cur.underline = true;
      else if (c === 22) { cur.bold = false; cur.dim = false; }
      else if (c === 23) cur.italic = false;
      else if (c === 24) cur.underline = false;
      else if (c >= 30 && c <= 37) cur.fg = BASIC(c - 30);
      else if (c >= 90 && c <= 97) cur.fg = BASIC(c - 90 + 8);
      else if (c >= 40 && c <= 47) cur.bg = BASIC(c - 40);
      else if (c >= 100 && c <= 107) cur.bg = BASIC(c - 100 + 8);
      else if (c === 39) cur.fg = undefined;
      else if (c === 49) cur.bg = undefined;
      else if (c === 38 || c === 48) {
        let color: string | undefined;
        if (codes[i + 1] === 5) { color = c256(codes[i + 2]); i += 2; }
        else if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
        if (c === 38) cur.fg = color; else cur.bg = color;
      }
    }
  }
  if (last < input.length) out.push({ ...cur, text: input.slice(last) });
  return out;
}

export type Level = 'error' | 'warn' | 'info' | 'debug' | null;
const LEVEL_RE = /\b(FATAL|CRITICAL|PANIC|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)\b|"level"\s*:\s*"(\w+)"|level=(\w+)/i;

export function detectLevel(s: string): Level {
  const m = s.slice(0, 300).match(LEVEL_RE);
  if (!m) return null;
  const l = (m[1] || m[2] || m[3] || '').toLowerCase();
  if (['fatal', 'critical', 'panic', 'error', 'err'].includes(l)) return 'error';
  if (['warn', 'warning'].includes(l)) return 'warn';
  if (l === 'info') return 'info';
  if (l === 'debug' || l === 'trace') return 'debug';
  return null;
}
