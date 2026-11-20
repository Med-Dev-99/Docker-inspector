// Persistent history ("time machine") backed by Node's built-in SQLite (node:sqlite).
// No native modules: works the same in Electron, plain Node and the container image.
//
// Tables
//   h10 / h60   host samples, 10 s buckets (kept 48 h) and 1 min buckets (kept DI_HISTORY_DAYS, default 7)
//   m10 / m60   per-container samples, same resolutions
//   containers  id -> name/image/project registry, so history stays readable after a container is removed
//   events      engine events (kept 30 days)
//   crashes     crash reports (kept 90 days)
//   ignores     Doctor findings the user chose to ignore

import fs from 'node:fs';
import path from 'node:path';

const H = 3600_000;
const D = 24 * H;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS containers (
  cid TEXT PRIMARY KEY, name TEXT, image TEXT, project TEXT, service TEXT, first_seen INTEGER, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS h10 (t INTEGER PRIMARY KEY, cpu REAL, mem INTEGER, mem_total INTEGER, ccpu REAL, cmem INTEGER);
CREATE TABLE IF NOT EXISTS h60 (t INTEGER PRIMARY KEY, cpu REAL, mem INTEGER, mem_total INTEGER, ccpu REAL, cmem INTEGER);
CREATE TABLE IF NOT EXISTS m10 (
  cid TEXT NOT NULL, t INTEGER NOT NULL, cpu REAL, cpu_max REAL, mem INTEGER, mem_max INTEGER, mem_limit INTEGER,
  rx REAL, tx REAL, br REAL, bw REAL, pids INTEGER, PRIMARY KEY (cid, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS m60 (
  cid TEXT NOT NULL, t INTEGER NOT NULL, cpu REAL, cpu_max REAL, mem INTEGER, mem_max INTEGER, mem_limit INTEGER,
  rx REAL, tx REAL, br REAL, bw REAL, pids INTEGER, PRIMARY KEY (cid, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS m10_t ON m10 (t);
CREATE INDEX IF NOT EXISTS m60_t ON m60 (t);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, t INTEGER NOT NULL, type TEXT, action TEXT, actor TEXT, name TEXT, attrs TEXT
);
CREATE INDEX IF NOT EXISTS events_t ON events (t);
CREATE INDEX IF NOT EXISTS events_actor ON events (actor, t);
CREATE TABLE IF NOT EXISTS crashes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cid TEXT, name TEXT, image TEXT, project TEXT, service TEXT,
  t INTEGER NOT NULL, last_t INTEGER NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1,
  exit_code INTEGER, oom INTEGER NOT NULL DEFAULT 0, kind TEXT, title TEXT, summary TEXT, severity TEXT,
  source TEXT, finished_at TEXT, report TEXT, acked INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS crashes_key ON crashes (cid, finished_at);
CREATE INDEX IF NOT EXISTS crashes_last ON crashes (last_t);
CREATE TABLE IF NOT EXISTS ignores (key TEXT PRIMARY KEY, t INTEGER);
`;

const n = (v) => (v === undefined || v === null || Number.isNaN(v) ? null : v);

/** Open (or create) the history database. Returns null when SQLite is unavailable. */
export async function openStore(dir, { historyDays = Number(process.env.DI_HISTORY_DAYS) || 7 } = {}) {
  let DatabaseSync;
  // node:sqlite still prints an ExperimentalWarning on some Node versions; keep the console clean.
  const original = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : original.call(process, w, ...rest));
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    console.warn(`[docker-inspector] History disabled: node:sqlite is not available (${e.message}).`);
    return null;
  } finally {
    process.emitWarning = original;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'history.db');
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    return new Store(db, file, historyDays);
  } catch (e) {
    console.warn(`[docker-inspector] History disabled: cannot open database in ${dir} (${e.message}).`);
    return null;
  }
}

export class Store {
  constructor(db, file, historyDays) {
    this.db = db;
    this.file = file;
    this.historyDays = historyDays;
    const p = (sql) => db.prepare(sql);
    this.q = {
      upsertContainer: p(`INSERT INTO containers (cid, name, image, project, service, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cid) DO UPDATE SET name = excluded.name, image = excluded.image, project = excluded.project,
        service = excluded.service, last_seen = excluded.last_seen`),
      insHost10: p('INSERT OR REPLACE INTO h10 (t, cpu, mem, mem_total, ccpu, cmem) VALUES (?, ?, ?, ?, ?, ?)'),
      insHost60: p('INSERT OR REPLACE INTO h60 (t, cpu, mem, mem_total, ccpu, cmem) VALUES (?, ?, ?, ?, ?, ?)'),
      insM10: p('INSERT OR REPLACE INTO m10 (cid, t, cpu, cpu_max, mem, mem_max, mem_limit, rx, tx, br, bw, pids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      insM60: p('INSERT OR REPLACE INTO m60 (cid, t, cpu, cpu_max, mem, mem_max, mem_limit, rx, tx, br, bw, pids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      insEvent: p('INSERT OR IGNORE INTO events (id, t, type, action, actor, name, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    };
  }

  close() { try { this.db.close(); } catch {} }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ------------------------------------------------------------- writes
  upsertContainers(list, t) {
    this.tx(() => { for (const c of list) this.q.upsertContainer.run(c.cid, n(c.name), n(c.image), n(c.project), n(c.service), t, t); });
  }

  writeHost(res, t, s) {
    (res === 10 ? this.q.insHost10 : this.q.insHost60).run(t, n(s.cpu), n(Math.round(s.mem)), n(s.memTotal), n(s.ccpu), n(Math.round(s.cmem)));
  }

  writeContainers(res, t, rows) {
    const st = res === 10 ? this.q.insM10 : this.q.insM60;
    this.tx(() => {
      for (const r of rows) {
        st.run(r.cid, t, n(r.cpu), n(r.cpuMax), n(Math.round(r.mem)), n(Math.round(r.memMax)), n(r.memLimit),
          n(r.rx), n(r.tx), n(r.br), n(r.bw), n(r.pids));
      }
    });
  }

  insertEvent(e) {
    this.q.insEvent.run(e.id, e.time, n(e.type), n(e.action), n(e.actorId), n(e.attributes?.name), JSON.stringify(e.attributes || {}));
  }

  /** Delete data older than the retention windows. */
  prune(now = Date.now()) {
    const keep = this.historyDays * D;
    this.tx(() => {
      this.db.prepare('DELETE FROM h10 WHERE t < ?').run(now - 48 * H);
      this.db.prepare('DELETE FROM m10 WHERE t < ?').run(now - 48 * H);
      this.db.prepare('DELETE FROM h60 WHERE t < ?').run(now - keep);
      this.db.prepare('DELETE FROM m60 WHERE t < ?').run(now - keep);
      this.db.prepare('DELETE FROM events WHERE t < ?').run(now - 30 * D);
      this.db.prepare('DELETE FROM crashes WHERE last_t < ?').run(now - 90 * D);
      this.db.prepare('DELETE FROM containers WHERE last_seen < ? AND cid NOT IN (SELECT cid FROM crashes WHERE cid IS NOT NULL)').run(now - keep);
    });
  }

  // ------------------------------------------------------------- reads: time series
  /** Pick a table + bucket size so a range never returns more than ~maxPoints points. */
  plan(from, to, maxPoints = 720) {
    const span = Math.max(1, to - from);
    const fine = span <= 12 * H && from >= Date.now() - 48 * H;
    const res = fine ? 10_000 : 60_000;
    const step = Math.max(res, Math.ceil(span / maxPoints / res) * res);
    return { fine, res, step };
  }

  hostSeries(from, to, maxPoints) {
    const { fine, step } = this.plan(from, to, maxPoints);
    const rows = this.db.prepare(`SELECT (t / ?) * ? AS t, avg(cpu) AS cpu, avg(mem) AS mem, max(mem_total) AS memTotal,
      avg(ccpu) AS ccpu, avg(cmem) AS cmem FROM ${fine ? 'h10' : 'h60'} WHERE t BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`).all(step, step, from, to);
    return { step, points: rows };
  }

  containerSeries(cid, from, to, maxPoints) {
    const { fine, step } = this.plan(from, to, maxPoints);
    const rows = this.db.prepare(`SELECT (t / ?) * ? AS t, avg(cpu) AS cpu, max(cpu_max) AS cpuMax, avg(mem) AS mem, max(mem_max) AS memMax,
      max(mem_limit) AS memLimit, avg(rx) AS rxRate, avg(tx) AS txRate, avg(br) AS blkRRate, avg(bw) AS blkWRate, max(pids) AS pids
      FROM ${fine ? 'm10' : 'm60'} WHERE cid = ? AND t BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`).all(step, step, cid, from, to);
    return { step, points: rows };
  }

  /** Per-container aggregates over a period (busiest containers). */
  summary(from, to) {
    const { fine } = this.plan(from, to);
    const rows = this.db.prepare(`SELECT m.cid AS cid, c.name AS name, c.image AS image, c.project AS project, c.service AS service,
      avg(m.cpu) AS avgCpu, max(m.cpu_max) AS maxCpu, avg(m.mem) AS avgMem, max(m.mem_max) AS maxMem, max(m.mem_limit) AS memLimit,
      count(*) AS samples, min(m.t) AS first, max(m.t) AS last
      FROM ${fine ? 'm10' : 'm60'} m LEFT JOIN containers c ON c.cid = m.cid WHERE m.t BETWEEN ? AND ? GROUP BY m.cid`).all(from, to);
    const crashes = this.db.prepare('SELECT cid, sum(occurrences) AS n FROM crashes WHERE last_t BETWEEN ? AND ? GROUP BY cid').all(from, to);
    const byCid = new Map(crashes.map((c) => [c.cid, c.n]));
    return rows.map((r) => ({ ...r, crashes: byCid.get(r.cid) || 0 }));
  }

  /** What was running at a given moment. */
  snapshot(t) {
    const fine = t >= Date.now() - 48 * H;
    const win = fine ? 15_000 : 60_000;
    const host = this.db.prepare(`SELECT t, cpu, mem, mem_total AS memTotal, ccpu, cmem FROM ${fine ? 'h10' : 'h60'}
      WHERE t BETWEEN ? AND ? ORDER BY abs(t - ?) LIMIT 1`).get(t - win, t + win, t) || null;
    const rows = this.db.prepare(`SELECT m.cid AS cid, m.t AS t, m.cpu AS cpu, m.mem AS mem, m.mem_limit AS memLimit, m.rx AS rxRate, m.tx AS txRate,
      c.name AS name, c.image AS image, c.project AS project FROM ${fine ? 'm10' : 'm60'} m LEFT JOIN containers c ON c.cid = m.cid
      WHERE m.t BETWEEN ? AND ?`).all(t - win, t + win);
    const best = new Map();
    for (const r of rows) {
      const cur = best.get(r.cid);
      if (!cur || Math.abs(r.t - t) < Math.abs(cur.t - t)) best.set(r.cid, r);
    }
    return { t, host, containers: [...best.values()].sort((a, b) => b.cpu - a.cpu) };
  }

  /** Highest memory a container reached since `since` (for right-sizing). */
  peakMem(cid, since) {
    const a = this.db.prepare('SELECT max(mem_max) AS m FROM m60 WHERE cid = ? AND t >= ?').get(cid, since)?.m || 0;
    const b = this.db.prepare('SELECT max(mem_max) AS m FROM m10 WHERE cid = ? AND t >= ?').get(cid, since)?.m || 0;
    return Math.max(a, b);
  }

  coverage() {
    const first = this.db.prepare('SELECT min(t) AS t FROM h60').get()?.t ?? this.db.prepare('SELECT min(t) AS t FROM h10').get()?.t ?? null;
    return { first, historyDays: this.historyDays };
  }

  knownContainers() {
    return this.db.prepare('SELECT cid, name, image, project, service, first_seen AS firstSeen, last_seen AS lastSeen FROM containers').all();
  }

  // ------------------------------------------------------------- reads: events
  events({ from = 0, to = Date.now(), actor, limit = 1000 } = {}) {
    const rows = actor
      ? this.db.prepare('SELECT * FROM events WHERE actor = ? AND t BETWEEN ? AND ? ORDER BY t DESC LIMIT ?').all(actor, from, to, limit)
      : this.db.prepare('SELECT * FROM events WHERE t BETWEEN ? AND ? ORDER BY t DESC LIMIT ?').all(from, to, limit);
    return rows.reverse().map((r) => ({ id: r.id, time: r.t, type: r.type, action: r.action, actorId: r.actor, attributes: safeJSON(r.attrs, {}) }));
  }

  lastEventTime() {
    return this.db.prepare('SELECT max(t) AS t FROM events').get()?.t || 0;
  }

  // ------------------------------------------------------------- crashes
  crashExists(cid, finishedAt) {
    return !!this.db.prepare('SELECT 1 FROM crashes WHERE cid = ? AND finished_at = ?').get(cid, finishedAt);
  }

  /** The most recent report for a container name within a window (to merge crash loops). */
  recentCrashFor(name, since) {
    return this.db.prepare('SELECT * FROM crashes WHERE name = ? AND last_t >= ? ORDER BY last_t DESC LIMIT 1').get(name, since) || null;
  }

  insertCrash(c) {
    const r = this.db.prepare(`INSERT OR IGNORE INTO crashes (cid, name, image, project, service, t, last_t, occurrences, exit_code, oom, kind, title,
      summary, severity, source, finished_at, report, acked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      n(c.cid), n(c.name), n(c.image), n(c.project), n(c.service), c.t, c.t, c.occurrences || 1, n(c.exitCode), c.oom ? 1 : 0,
      n(c.kind), n(c.title), n(c.summary), n(c.severity), n(c.source), n(c.finishedAt), JSON.stringify(c.report || {}), c.acked ? 1 : 0);
    return r.changes ? Number(r.lastInsertRowid) : null;
  }

  mergeCrash(id, c) {
    this.db.prepare(`UPDATE crashes SET cid = ?, last_t = ?, occurrences = occurrences + 1, exit_code = ?, oom = ?, kind = ?, title = ?,
      summary = ?, severity = ?, finished_at = ?, report = ?, acked = 0 WHERE id = ?`).run(
      n(c.cid), c.t, n(c.exitCode), c.oom ? 1 : 0, n(c.kind), n(c.title), n(c.summary), n(c.severity), n(c.finishedAt), JSON.stringify(c.report || {}), id);
    return this.getCrash(id);
  }

  listCrashes({ limit = 200 } = {}) {
    return this.db.prepare(`SELECT id, cid, name, image, project, service, t, last_t AS lastT, occurrences, exit_code AS exitCode, oom, kind,
      title, summary, severity, source, acked FROM crashes ORDER BY last_t DESC LIMIT ?`).all(limit)
      .map((r) => ({ ...r, oom: !!r.oom, acked: !!r.acked }));
  }

  getCrash(id) {
    const r = this.db.prepare('SELECT * FROM crashes WHERE id = ?').get(id);
    if (!r) return null;
    return {
      id: r.id, cid: r.cid, name: r.name, image: r.image, project: r.project, service: r.service, t: r.t, lastT: r.last_t,
      occurrences: r.occurrences, exitCode: r.exit_code, oom: !!r.oom, kind: r.kind, title: r.title, summary: r.summary,
      severity: r.severity, source: r.source, finishedAt: r.finished_at, acked: !!r.acked, report: safeJSON(r.report, {}),
    };
  }

  crashesFor(name, since) {
    return this.db.prepare(`SELECT id, t, last_t AS lastT, occurrences, title, kind, oom FROM crashes WHERE name = ? AND last_t >= ?
      ORDER BY last_t DESC`).all(name, since).map((r) => ({ ...r, oom: !!r.oom }));
  }

  ackCrash(id) { this.db.prepare('UPDATE crashes SET acked = 1 WHERE id = ?').run(id); }
  ackAll() { this.db.prepare('UPDATE crashes SET acked = 1').run(); }
  deleteCrash(id) { this.db.prepare('DELETE FROM crashes WHERE id = ?').run(id); }
  unackedCount() { return this.db.prepare('SELECT count(*) AS n FROM crashes WHERE acked = 0').get().n; }

  // ------------------------------------------------------------- doctor ignores
  ignores() { return new Set(this.db.prepare('SELECT key FROM ignores').all().map((r) => r.key)); }
  addIgnore(key) { this.db.prepare('INSERT OR REPLACE INTO ignores (key, t) VALUES (?, ?)').run(key, Date.now()); }
  removeIgnore(key) { this.db.prepare('DELETE FROM ignores WHERE key = ?').run(key); }
}

function safeJSON(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
