import { useEffect, useRef, useState } from 'react';
import { RotateCw, SquareTerminal, Trash2 } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { socket } from '../../lib/ws';
import { Button, Capsule, Empty, IconButton, useLocalState } from '../../components/ui';
import { containerDo } from '../../lib/actions';

function theme(dark: boolean) {
  return dark ? {
    background: '#161618', foreground: '#e6e6e9', cursor: '#0a84ff', cursorAccent: '#161618', selectionBackground: 'rgba(10,132,255,0.35)',
    black: '#1d1d20', red: '#ff6b62', green: '#5ad97a', yellow: '#ffd75f', blue: '#5aa9ff', magenta: '#d38aff', cyan: '#5fd7e6', white: '#d7d7db',
    brightBlack: '#6e6e76', brightRed: '#ff8a80', brightGreen: '#7ee59a', brightYellow: '#ffe28a', brightBlue: '#82bfff', brightMagenta: '#e0a8ff', brightCyan: '#86e5f0', brightWhite: '#ffffff',
  } : {
    background: '#fbfbfd', foreground: '#1d1d1f', cursor: '#007aff', cursorAccent: '#fbfbfd', selectionBackground: 'rgba(0,122,255,0.22)',
    black: '#1d1d1f', red: '#d12f26', green: '#1f8a3b', yellow: '#a36b00', blue: '#0060df', magenta: '#9b3dc8', cyan: '#0b7f90', white: '#8e8e93',
    brightBlack: '#6e6e73', brightRed: '#ff3b30', brightGreen: '#28a745', brightYellow: '#c98a00', brightBlue: '#007aff', brightMagenta: '#af52de', brightCyan: '#1aa0b5', brightWhite: '#3a3a3c',
  };
}

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

export function TerminalTab({ c }: { c: any }) {
  const running = c.State.Status === 'running';
  const [shell, setShell] = useLocalState('term.shell', 'auto');
  const [user, setUser] = useLocalState('term.user', '');
  const [gen, setGen] = useState(0);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'exited'>('connecting');
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!running || !host.current) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "SF Mono", "Ubuntu Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 10000,
      theme: theme(isDark()),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    try { fit.fit(); } catch {}
    setStatus('connecting');
    const cmd = shell === 'auto' ? undefined : shell === 'bash' ? ['bash', '-l'] : [shell];
    const sess = socket.session({ type: 'exec.open', id: c.Id, cmd, user: user || undefined, cols: term.cols, rows: term.rows }, (msg) => {
      if (msg.type === 'exec.ready') { setStatus('ready'); term.focus(); }
      else if (msg.type === 'exec.data') term.write(msg.data);
      else if (msg.type === 'exec.exit') {
        setStatus('exited');
        term.write(`\r\n\x1b[2m[process exited${msg.code !== null && msg.code !== undefined ? ` with code ${msg.code}` : ''} — press Reconnect to start a new session]\x1b[0m\r\n`);
      } else if (msg.type === 'error') {
        setStatus('exited');
        term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
      } else if (msg.type === 'disconnected') {
        setStatus('exited');
        term.write('\r\n\x1b[2m[connection lost]\x1b[0m\r\n');
      }
    });
    const d1 = term.onData((data) => sess.send({ type: 'exec.input', data }));
    const d2 = term.onResize(({ cols, rows }) => sess.send({ type: 'exec.resize', cols, rows }));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host.current);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => { term.options.theme = theme(isDark()); };
    mq.addEventListener('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      d1.dispose(); d2.dispose(); ro.disconnect(); mo.disconnect();
      mq.removeEventListener('change', onTheme);
      sess.close();
      term.dispose();
      termRef.current = null;
    };
  }, [c.Id, running, gen, shell, user]);

  if (!running) {
    return <Empty icon={SquareTerminal} title="Container is not running" message="Start the container to open an interactive shell inside it."
      action={<Button variant="primary" onClick={() => containerDo(c.Id, c.Name.slice(1), 'start')}>Start Container</Button>} />;
  }

  return (
    <div className="terminal-wrap">
      <div className="subbar">
        <label className="subbar-field">Shell
          <select className="select select-sm" value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value="auto">Automatic</option><option value="bash">bash</option><option value="sh">sh</option><option value="ash">ash</option><option value="zsh">zsh</option>
          </select>
        </label>
        <label className="subbar-field">User
          <input className="input input-sm" style={{ width: 110 }} placeholder={c.Config.User || 'default'} defaultValue={user}
            onKeyDown={(e) => { if (e.key === 'Enter') setUser((e.target as HTMLInputElement).value.trim()); }}
            onBlur={(e) => setUser(e.target.value.trim())} />
        </label>
        <div className="flex-1" />
        <span className="subbar-info">
          {status === 'ready' ? <><span className="live-dot" /> Connected · {c.Name.slice(1)}</> : status === 'connecting' ? 'Connecting…' : 'Session ended'}
        </span>
        <Capsule>
          <IconButton icon={Trash2} label="Clear screen" onClick={() => termRef.current?.clear()} />
          <IconButton icon={RotateCw} label="Reconnect" onClick={() => setGen((g) => g + 1)} />
        </Capsule>
      </div>
      <div className="terminal" ref={host} />
    </div>
  );
}
