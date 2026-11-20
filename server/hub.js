// Live monitoring: per-container stats streams + engine event stream + host metrics.

import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import * as docker from './docker.js';
import { analyzeCrash } from './crash.js';

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

const D = 24 * 3600_000;

const newContainerAcc = () => ({ n: 0, cpu: 0, cpuMax: 0, mem: 0, memMax: 0, memLimit: 0, rx: 0, tx: 0, br: 0, bw: 0, pids: 0 });
const newHostAcc = () => ({ n: 0, cpu: 0, mem: 0, memTotal: 0, ccpu: 0, cmem: 0 });

function metaFromSummary(c) {
  const l = c.Labels || {};
  return { name: c.Names?.[0]?.replace(/^\//, ''), image: c.Image, project: l['com.docker.compose.project'] || null, service: l['com.docker.compose.service'] || null };
}
function metaFromAttrs(a = {}) {
  return { name: a.name, image: a.image, project: a['com.docker.compose.project'] || null, service: a['com.docker.compose.service'] || null };
}
function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)]);
}
function summarizeConfig(inspect, attrs = {}) {
  if (!inspect) return { image: attrs.image || null };
  const hc = inspect.HostConfig || {};
  const cfg = inspect.Config || {};
  const st = inspect.State || {};
  return {
    image: cfg.Image, imageId: inspect.Image,
    command: [...(cfg.Entrypoint || []), ...(cfg.Cmd || [])].join(' '),
    restartPolicy: hc.RestartPolicy?.Name || 'no', restartCount: inspect.RestartCount || 0,
    memoryLimit: hc.Memory || 0, cpus: hc.NanoCpus ? hc.NanoCpus / 1e9 : 0,
    startedAt: st.StartedAt, finishedAt: st.FinishedAt, error: st.Error || null,
    health: st.Health ? {
      status: st.Health.Status, failingStreak: st.Health.FailingStreak,
      log: (st.Health.Log || []).slice(-3).map((l) => ({ exitCode: l.ExitCode, end: l.End, output: (l.Output || '').trim().slice(0, 400) })),
    } : null,
    workingDir: cfg.Labels?.['com.docker.compose.project.working_dir'] || null,
  };
}

export class Hub extends EventEmitter {
  constructor({ store = null } = {}) {
    super();
    this.setMaxListeners(100);
    this.store = store;
    this.streams = new Map(); // id -> { handle, last, history[], meta }
    this.hostHistory = [];
    this.events = [];
    this.eventsHandle = null;
    this.timers = [];
    this.acc = { 10: { bucket: 0, host: newHostAcc(), containers: new Map() }, 60: { bucket: 0, host: newHostAcc(), containers: new Map() } };
    this.stopIntent = new Map(); // id -> time of the last kill/stop event (a deliberate stop is not a crash)
    this.oomAt = new Map(); // id -> time of the last oom event
    this.crashQueue = Promise.resolve();
  }

  async start() {
    if (this.store) {
      try { this.events = this.store.events({ from: Date.now() - 7 * D, limit: 1000 }); } catch {}
    }
    await this.loadPastEvents();
    this.listenEvents();
    await this.sync();
    readHostCpu();
    this.timers.push(setInterval(() => this.sync().catch(() => {}), 15000));
    this.timers.push(setInterval(() => this.tick(), 1000));
    if (this.store) {
      try { this.store.prune(); } catch {}
      this.timers.push(setInterval(() => { try { this.store.prune(); } catch {} }, 3600_000));
      this.scanForCrashes().catch((e) => console.warn('[docker-inspector] crash scan failed:', e.message));
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.eventsHandle?.close();
    for (const s of this.streams.values()) s.handle.close();
    this.streams.clear();
    for (const res of [10, 60]) this.flush(res, this.acc[res]);
  }

  async sync() {
    const running = await docker.get('/containers/json');
    const ids = new Set(running.map((c) => c.Id));
    for (const c of running) if (!this.streams.has(c.Id)) this.watch(c.Id, metaFromSummary(c));
    for (const id of [...this.streams.keys()]) if (!ids.has(id)) this.unwatch(id);
  }

  watch(id, meta) {
    if (this.streams.has(id)) return;
    const entry = { handle: null, last: null, history: [], meta };
    // Register the name right away so history stays readable even if it dies before the next flush.
    if (this.store && meta?.name) { try { this.store.upsertContainers([{ cid: id, ...meta }], Date.now()); } catch {} }
    entry.handle = docker.streamJSON(`/containers/${id}/stats?stream=1`, (raw) => {
      if (!raw.read || raw.read.startsWith('0001')) return; // container gone
      const sample = computeSample(raw, entry.last);
      entry.last = sample;
      entry.history.push(sample);
      if (entry.history.length > HISTORY) entry.history.shift();
      this.accumulate(id, sample);
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

  latestFor(id) { return this.streams.get(id)?.last || null; }

  // ---- recording (time machine)
  accumulate(id, s) {
    for (const res of [10, 60]) {
      const map = this.acc[res].containers;
      let a = map.get(id);
      if (!a) { a = newContainerAcc(); map.set(id, a); }
      a.n++; a.cpu += s.cpu; a.cpuMax = Math.max(a.cpuMax, s.cpu); a.mem += s.mem; a.memMax = Math.max(a.memMax, s.mem);
      a.memLimit = s.memLimit; a.rx += s.rxRate; a.tx += s.txRate; a.br += s.blkRRate; a.bw += s.blkWRate; a.pids = Math.max(a.pids, s.pids);
    }
  }

  flush(res, A) {
    if (!this.store || !A.bucket) return;
    try {
      if (A.host.n) {
        const h = A.host;
        this.store.writeHost(res, A.bucket, { cpu: h.cpu / h.n, mem: h.mem / h.n, memTotal: h.memTotal, ccpu: h.ccpu / h.n, cmem: h.cmem / h.n });
      }
      const rows = [];
      for (const [cid, a] of A.containers) {
        if (!a.n) continue;
        rows.push({ cid, cpu: a.cpu / a.n, cpuMax: a.cpuMax, mem: a.mem / a.n, memMax: a.memMax, memLimit: a.memLimit,
          rx: a.rx / a.n, tx: a.tx / a.n, br: a.br / a.n, bw: a.bw / a.n, pids: a.pids });
      }
      if (rows.length) this.store.writeContainers(res, A.bucket, rows);
      if (res === 60) {
        const metas = rows.map((r) => ({ cid: r.cid, ...(this.streams.get(r.cid)?.meta || {}) })).filter((m) => m.name);
        if (metas.length) this.store.upsertContainers(metas, Date.now());
      }
    } catch (e) {
      console.warn('[docker-inspector] could not write history:', e.message);
    }
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

    for (const res of [10, 60]) {
      const size = res * 1000;
      const bucket = Math.floor(now / size) * size;
      const A = this.acc[res];
      if (bucket !== A.bucket) {
        this.flush(res, A);
        this.acc[res] = { bucket, host: newHostAcc(), containers: new Map() };
      }
      const h = this.acc[res].host;
      h.n++; h.cpu += host.cpu; h.mem += host.mem; h.memTotal = host.memTotal; h.ccpu += host.ccpu; h.cmem += host.cmem;
    }
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
    if (this.store) { try { this.store.insertEvent(item); } catch {} }
    return item;
  }

  async loadPastEvents() {
    const known = new Set(this.events.map((e) => e.id));
    const since = Math.floor(Date.now() / 1000) - 24 * 3600;
    const until = Math.floor(Date.now() / 1000);
    await new Promise((resolve) => {
      docker.streamJSON(`/events?since=${since}&until=${until}`, (ev) => {
        if (isNoise(ev)) return;
        const id = `${ev.timeNano || ev.time}-${ev.Actor?.ID || ''}-${ev.Action}`;
        if (!known.has(id)) this.pushEvent(ev);
      }, { onEnd: resolve, onError: resolve });
      setTimeout(resolve, 4000);
    });
    this.events.sort((a, b) => a.time - b.time);
  }

  listenEvents() {
    const since = Math.floor(Date.now() / 1000);
    this.eventsHandle = docker.streamJSON(`/events?since=${since}`, (ev) => {
      if (isNoise(ev)) return;
      const item = this.pushEvent(ev);
      this.emit('event', item);
      if (ev.Type === 'container') {
        const id = ev.Actor?.ID;
        const a = ev.Actor?.Attributes || {};
        if (ev.Action === 'kill' || ev.Action === 'stop') this.stopIntent.set(id, Date.now());
        if (ev.Action === 'oom') this.oomAt.set(id, Date.now());
        if (ev.Action === 'rename' && this.streams.get(id)) this.streams.get(id).meta.name = a.name;
        if (ev.Action === 'die') {
          // Grab the recorded samples before the stream is dropped below.
          const entry = this.streams.get(id);
          const samples = entry ? entry.history.slice() : [];
          const meta = entry?.meta || metaFromAttrs(a);
          this.crashQueue = this.crashQueue
            .then(() => this.onDie(id, a, samples, meta))
            .catch((e) => console.warn('[docker-inspector] crash report failed:', e.message));
        }
        if (['start', 'unpause', 'restart'].includes(ev.Action)) this.watch(id, metaFromAttrs(a));
        if (['die', 'kill', 'stop', 'destroy'].includes(ev.Action)) this.unwatch(id);
      }
    }, {
      onEnd: () => setTimeout(() => this.listenEvents(), 2000),
      onError: () => setTimeout(() => this.listenEvents(), 3000),
    });
  }

  // ---- crash reports
  async onDie(id, attrs, samples, meta) {
    const now = Date.now();
    const exitCode = Number(attrs.exitCode);
    const stopAt = this.stopIntent.get(id);
    const oomAt = this.oomAt.get(id);
    this.stopIntent.delete(id);
    this.oomAt.delete(id);
    const oom = !!(oomAt && now - oomAt < 60_000);
    const intended = !!(stopAt && now - stopAt < 120_000);
    // A deliberate stop or a clean / signal-requested exit is not a crash.
    if (!oom && (intended || !Number.isFinite(exitCode) || [0, 130, 143].includes(exitCode))) return;

    const inspect = await docker.get(`/containers/${id}/json`).catch(() => null);
    const logs = await docker.fetchLogs(id, { tail: 200, tty: !!inspect?.Config?.Tty }).catch(() => []);
    const deps = inspect ? await this.downDependencies(inspect).catch(() => []) : [];
    await this.recordCrash({ id, inspect, attrs, logs, samples, oom, exitCode, deps, meta, source: 'live', t: now });
  }

  /** Compose services this container depends on that are not running. */
  async downDependencies(inspect) {
    const labels = inspect.Config?.Labels || {};
    const project = labels['com.docker.compose.project'];
    const deps = labels['com.docker.compose.depends_on'];
    if (!project || !deps) return [];
    const services = deps.split(',').map((d) => d.split(':')[0]).filter(Boolean);
    const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
    const list = await docker.get(`/containers/json?all=1&filters=${filter}`);
    return services.map((svc) => {
      const c = list.find((x) => x.Labels?.['com.docker.compose.service'] === svc);
      return { service: svc, state: c ? c.State : 'missing' };
    }).filter((d) => d.state !== 'running');
  }

  async recordCrash(ctx) {
    const insp = ctx.inspect;
    const labels = insp?.Config?.Labels || ctx.attrs || {};
    const name = (insp?.Name || '').replace(/^\//, '') || ctx.attrs?.name || ctx.meta?.name || ctx.id.slice(0, 12);
    const finishedAt = insp?.State?.FinishedAt && !insp.State.FinishedAt.startsWith('0001') ? insp.State.FinishedAt : new Date(ctx.t).toISOString();
    const prev = this.store && ctx.source === 'live' ? this.store.recentCrashFor(name, ctx.t - 15 * 60_000) : null;
    const occurrences = prev ? prev.occurrences + 1 : 1;
    const analysis = analyzeCrash({ ...ctx, occurrences, hostMemTotal: os.totalmem() });
    const report = {
      analysis,
      logs: ctx.logs.slice(-200),
      samples: downsample(ctx.samples, 300).map((s) => ({ t: s.t, cpu: Math.round(s.cpu * 100) / 100, mem: s.mem, memLimit: s.memLimit })),
      events: this.events.filter((e) => e.actorId === ctx.id && e.time >= ctx.t - 3600_000 && e.time <= ctx.t + 1000)
        .slice(-30).map((e) => ({ time: e.time, action: e.action, attributes: { exitCode: e.attributes?.exitCode, signal: e.attributes?.signal } })),
      config: summarizeConfig(insp, ctx.attrs),
    };
    const crash = {
      cid: ctx.id, name, image: insp?.Config?.Image || ctx.attrs?.image || ctx.meta?.image || null,
      project: labels['com.docker.compose.project'] || null, service: labels['com.docker.compose.service'] || null,
      t: ctx.t, exitCode: analysis.exitCode, oom: analysis.oom, kind: analysis.kind, title: analysis.title,
      summary: analysis.summary, severity: analysis.severity, source: ctx.source, finishedAt, report,
    };
    let saved = { id: null, occurrences, ...crash };
    if (this.store) {
      if (prev) saved = this.store.mergeCrash(prev.id, crash);
      else {
        const id = this.store.insertCrash(crash);
        if (!id) return; // already recorded
        saved = this.store.getCrash(id);
      }
    }
    if (ctx.source === 'live') {
      this.emit('crash', {
        id: saved.id, cid: crash.cid, name, title: saved.title, summary: saved.summary, severity: saved.severity,
        occurrences: saved.occurrences, oom: crash.oom, exitCode: crash.exitCode, t: ctx.t,
        // Notify on the first crash and once more when it turns into a loop - not on every restart.
        notify: saved.occurrences === 1 || saved.occurrences === 3,
      });
    }
  }

  /** Report crashes that happened while Docker Inspector was not running (last 30 days). */
  async scanForCrashes() {
    const filter = encodeURIComponent(JSON.stringify({ status: ['exited', 'dead'] }));
    const list = await docker.get(`/containers/json?all=1&filters=${filter}`);
    for (const c of list) {
      const m = /Exited \((\d+)\)/.exec(c.Status || '');
      if (!m) continue;
      const code = Number(m[1]);
      if ([0, 130, 143].includes(code)) continue;
      const inspect = await docker.get(`/containers/${c.Id}/json`).catch(() => null);
      if (!inspect) continue;
      const st = inspect.State || {};
      const finished = Date.parse(st.FinishedAt);
      if (!finished || finished < Date.now() - 30 * D) continue;
      if (code === 137 && !st.OOMKilled) continue; // most likely a `docker stop` that timed out
      if (this.store.crashExists(c.Id, st.FinishedAt)) continue;
      const logs = await docker.fetchLogs(c.Id, { tail: 200, tty: !!inspect.Config?.Tty }).catch(() => []);
      await this.recordCrash({ id: c.Id, inspect, attrs: {}, logs, samples: [], oom: false, exitCode: code, deps: [], meta: null, source: 'scan', t: finished });
    }
  }
}
