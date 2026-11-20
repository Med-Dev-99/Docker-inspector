// Single multiplexed WebSocket to the backend: topics (stats, events) + sessions (logs, exec).
import { TOKEN } from './api';

type Listener = (msg: any) => void;
export type SocketStatus = 'connecting' | 'open' | 'closed';

let seq = 0;

class Socket {
  ws: WebSocket | null = null;
  status: SocketStatus = 'connecting';
  topics = new Map<string, Set<Listener>>();
  sessions = new Map<string, Listener>();
  statusListeners = new Set<() => void>();
  queue: string[] = [];
  started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private setStatus(s: SocketStatus) {
    this.status = s;
    for (const l of this.statusListeners) l();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.setStatus('open');
      for (const t of this.topics.keys()) ws.send(JSON.stringify({ type: 'sub', topic: t }));
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.sid) { this.sessions.get(msg.sid)?.(msg); return; }
      const topic = msg.type === 'stats' ? 'stats' : msg.type === 'event' ? 'events' : msg.type === 'crash' ? 'crashes' : null;
      if (topic) for (const l of this.topics.get(topic) || []) l(msg);
    };
    ws.onclose = () => {
      this.setStatus('closed');
      for (const l of this.sessions.values()) l({ type: 'disconnected' });
      this.sessions.clear();
      setTimeout(() => this.connect(), 1500);
    };
  }

  private send(msg: object) {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  subscribe(topic: 'stats' | 'events' | 'crashes', fn: Listener) {
    this.start();
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
      this.send({ type: 'sub', topic });
    }
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  /** Open a streaming session (logs.open / exec.open). */
  session(open: Record<string, unknown>, onMessage: Listener) {
    this.start();
    const sid = `s${++seq}-${Date.now().toString(36)}`;
    this.sessions.set(sid, onMessage);
    this.send({ ...open, sid });
    return {
      sid,
      send: (msg: Record<string, unknown>) => this.send({ ...msg, sid }),
      close: () => {
        if (!this.sessions.has(sid)) return;
        this.sessions.delete(sid);
        this.send({ type: 'close', sid });
      },
    };
  }

  onStatus(fn: () => void) {
    this.statusListeners.add(fn);
    return () => { this.statusListeners.delete(fn); };
  }
}

export const socket = new Socket();
