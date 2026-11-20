// Live monitoring: per-container stats streams + engine event stream + host metrics.

import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import * as docker from './docker.js';

const HISTORY = 300; // samples kept per container (~5 min at 1/s)

// Events produced by inspection itself (exec sessions, `top`, archive reads) carry no state change.
const NOISE = new Set(['top', 'attach', 'resize', 'archive-path', 'extract-to-dir', 'export', 'copy']);
const isNoise = (ev) => String(ev.Action).startsWith('exec_') || NOISE.has(ev.Action);

function sum(arr, fn) { let s = 0; for (const x of arr || []) s += fn(x) || 0; return s; }

/** Convert a raw Docker stats object into a compact sample. */
export function computeSample(s, prev) {
  const cpu = s.cpu_stats || {};
  const pre = s.precpu_stats || {};
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const ncpu = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || os.cpus().length;
  const cpuPct = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * ncpu * 100 : 0;

  const ms = s.memory_stats || {};
  const st = ms.stats || {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0;
  const mem = Math.max(0, (ms.usage ?? 0) - cache);
  const memLimit = ms.limit ?? 0;

  const nets = Object.values(s.networks || {});
  const rx = sum(nets, (n) => n.rx_bytes);
  const tx = sum(nets, (n) => n.tx_bytes);

  const io = s.blkio_stats?.io_service_bytes_recursive || [];
  const blkR = sum(io, (e) => (String(e.op).toLowerCase() === 'read' ? e.value : 0));
  const blkW = sum(io, (e) => (String(e.op).toLowerCase() === 'write' ? e.value : 0));

  const t = Date.parse(s.read) || Date.now();
  const dt = prev ? Math.max(0.001, (t - prev.t) / 1000) : 0;
  const rate = (cur, old) => (prev && dt ? Math.max(0, (cur - old) / dt) : 0);

  return {
    t,
    cpu: Math.round(cpuPct * 100) / 100,
    ncpu,
    mem,
    memLimit,
    memPct: memLimit ? (mem / memLimit) * 100 : 0,
    rx, tx,
    rxRate: rate(rx, prev?.rx ?? rx),
    txRate: rate(tx, prev?.tx ?? tx),
    blkR, blkW,
    blkRRate: rate(blkR, prev?.blkR ?? blkR),
    blkWRate: rate(blkW, prev?.blkW ?? blkW),
    pids: s.pids_stats?.current ?? 0,
    pidsLimit: s.pids_stats?.limit ?? 0,
  };
}

// ---------------------------------------------------------------- host metrics

let lastCpu = null;
function readHostCpu() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    let pct = 0;
    if (lastCpu) {
      const dt = total - lastCpu.total;
      const di = idle - lastCpu.idle;
      pct = dt > 0 ? (1 - di / dt) * 100 : 0;
    }
    lastCpu = { total, idle };
    return pct;
  } catch { return 0; }
}

function readHostMem() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0) * 1024;
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    return { total, used: total - avail, swapTotal: get('SwapTotal'), swapUsed: get('SwapTotal') - get('SwapFree') };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 };
  }
}

export function hostInfo(dockerRoot) {
  let disk = null;
  for (const p of [dockerRoot, '/var/lib', '/']) {
    if (!p) continue;
    try {
      const s = fs.statfsSync(p);
      disk = { path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
      break;
    } catch {}
  }
  let osName = os.type();
  try {
    const rel = fs.readFileSync('/etc/os-release', 'utf8');
    osName = (rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || osName;
  } catch {}
  return {
    hostname: os.hostname(),
    os: osName,
    kernel: os.release(),
    arch: os.arch(),
    uptime: os.uptime(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim() || '',
    loadavg: os.loadavg(),
    mem: readHostMem(),
    disk,
  };
}

// ---------------------------------------------------------------- hub

export class Hub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.streams = new Map(); // id -> { handle, last, history[], name }
    this.hostHistory = [];
    this.events = [];
    this.eventsHandle = null;
    this.timer = null;
    this.syncTimer = null;
  }

  async start() {
    await this.loadPastEvents();
    this.listenEvents();
    await this.sync();
    this.syncTimer = setInterval(() => this.sync().catch(() => {}), 15000);
    readHostCpu();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.syncTimer);
    this.eventsHandle?.close();
    for (const s of this.streams.values()) s.handle.close();
    this.streams.clear();
  }

  async sync() {
    const running = await docker.get('/containers/json');
    const ids = new Set(running.map((c) => c.Id));
    for (const c of running) if (!this.streams.has(c.Id)) this.watch(c.Id, c.Names?.[0]?.slice(1));
    for (const id of [...this.streams.keys()]) if (!ids.has(id)) this.unwatch(id);
  }

  watch(id, name) {
    if (this.streams.has(id)) return;
    const entry = { handle: null, last: null, history: [], name };
    entry.handle = docker.streamJSON(`/containers/${id}/stats?stream=1`, (raw) => {
      if (!raw.read || raw.read.startsWith('0001')) return; // container gone
      const sample = computeSample(raw, entry.last);
      entry.last = sample;
      entry.history.push(sample);
      if (entry.history.length > HISTORY) entry.history.shift();
    }, {
      onEnd: () => { if (this.streams.get(id) === entry) this.streams.delete(id); },
      onError: () => { if (this.streams.get(id) === entry) this.streams.delete(id); },
    });
    this.streams.set(id, entry);
  }

  unwatch(id) {
    const e = this.streams.get(id);
    if (!e) return;
    e.handle.close();
    this.streams.delete(id);
  }

  tick() {
    const hostMem = readHostMem();
    const latest = {};
    let ccpu = 0, cmem = 0;
    const now = Date.now();
    for (const [id, e] of this.streams) {
      if (!e.last) continue;
      latest[id] = e.last;
      if (now - e.last.t < 5000) { ccpu += e.last.cpu; cmem += e.last.mem; }
    }
    const ncpu = os.cpus().length || 1;
    const host = { t: now, cpu: readHostCpu(), mem: hostMem.used, memTotal: hostMem.total, ccpu: ccpu / ncpu, cmem };
    this.hostHistory.push(host);
    if (this.hostHistory.length > HISTORY) this.hostHistory.shift();
    this.emit('stats', { host, containers: latest });
  }

  history() {
    const containers = {};
    for (const [id, e] of this.streams) containers[id] = e.history;
    return { host: this.hostHistory, containers };
  }

  // ---- events
  pushEvent(ev) {
    const item = {
      id: `${ev.timeNano || ev.time}-${ev.Actor?.ID || ''}-${ev.Action}`,
      time: ev.timeNano ? Math.floor(ev.timeNano / 1e6) : ev.time * 1000,
      type: ev.Type,
      action: ev.Action,
      actorId: ev.Actor?.ID,
      attributes: ev.Actor?.Attributes || {},
      scope: ev.scope,
    };
    this.events.push(item);
    if (this.events.length > 1000) this.events.shift();
    return item;
  }

  async loadPastEvents() {
    const since = Math.floor(Date.now() / 1000) - 24 * 3600;
    const until = Math.floor(Date.now() / 1000);
    await new Promise((resolve) => {
      docker.streamJSON(`/events?since=${since}&until=${until}`, (ev) => {
        if (!isNoise(ev)) this.pushEvent(ev);
      }, { onEnd: resolve, onError: resolve });
      setTimeout(resolve, 4000);
    });
  }

  listenEvents() {
    const since = Math.floor(Date.now() / 1000);
    this.eventsHandle = docker.streamJSON(`/events?since=${since}`, (ev) => {
      if (isNoise(ev)) return;
      const item = this.pushEvent(ev);
      this.emit('event', item);
      if (ev.Type === 'container') {
        const id = ev.Actor?.ID;
        if (['start', 'unpause', 'restart'].includes(ev.Action)) this.watch(id, ev.Actor?.Attributes?.name);
        if (['die', 'kill', 'stop', 'destroy', 'pause'].includes(ev.Action)) {
          // stats for a paused container stop updating; keep stream for unpause but drop on die/destroy
          if (ev.Action !== 'pause') this.unwatch(id);
        }
      }
    }, {
      onEnd: () => setTimeout(() => this.listenEvents(), 2000),
      onError: () => setTimeout(() => this.listenEvents(), 3000),
    });
  }
}
