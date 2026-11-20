// Tests for the SQLite history store. Uses a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/store.js';

const withStore = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-store-'));
  const store = await openStore(dir);
  assert.ok(store, 'node:sqlite should be available');
  try { await fn(store, dir); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
};

const row = (cid, over = {}) => ({ cid, cpu: 10, cpuMax: 20, mem: 100e6, memMax: 120e6, memLimit: 256e6, rx: 1, tx: 2, br: 3, bw: 4, pids: 5, ...over });

test('stores and reads back container and host series with gaps preserved', async () => {
  await withStore((s) => {
    const now = Date.now();
    const t0 = Math.floor((now - 600_000) / 10_000) * 10_000;
    s.upsertContainers([{ cid: 'a', name: 'web', image: 'nginx', project: 'shop', service: 'web' }], now);
    for (let i = 0; i < 20; i++) {
      s.writeHost(10, t0 + i * 10_000, { cpu: 5 + i, mem: 1e9, memTotal: 8e9, ccpu: 1, cmem: 1e8 });
      s.writeContainers(10, t0 + i * 10_000, [row('a', { cpu: i })]);
    }
    const host = s.hostSeries(t0, t0 + 200_000);
    assert.equal(host.points.length, 20);
    assert.equal(host.step, 10_000);
    const c = s.containerSeries('a', t0, t0 + 200_000);
    assert.equal(c.points.length, 20);
    assert.equal(c.points[19].cpu, 19);
    // wide ranges are bucketed down to at most ~maxPoints
    const wide = s.containerSeries('a', now - 7 * 86400_000, now, 100);
    assert.ok(wide.step >= 60_000);
  });
});

test('summary joins container names and counts crashes', async () => {
  await withStore((s) => {
    const now = Date.now();
    const t = Math.floor(now / 10_000) * 10_000 - 20_000;
    s.upsertContainers([{ cid: 'a', name: 'web' }], now);
    s.writeContainers(10, t, [row('a', { cpu: 30, cpuMax: 90 })]);
    s.insertCrash({ cid: 'a', name: 'web', t: now - 1000, kind: 'oom', title: 'Out of memory', severity: 'critical', finishedAt: 'x', report: {}, oom: true });
    const [r] = s.summary(now - 3600_000, now);
    assert.equal(r.name, 'web');
    assert.equal(r.maxCpu, 90);
    assert.equal(r.crashes, 1);
  });
});

test('crash loops merge into one report and unread/ack work', async () => {
  await withStore((s) => {
    const now = Date.now();
    const id = s.insertCrash({ cid: 'a', name: 'worker', t: now - 5000, kind: 'x', title: 'First', severity: 'high', finishedAt: 'f1', report: {} });
    assert.ok(id);
    assert.equal(s.insertCrash({ cid: 'a', name: 'worker', t: now - 5000, kind: 'x', title: 'Dup', severity: 'high', finishedAt: 'f1', report: {} }), null, 'same (cid, finishedAt) is ignored');
    const prev = s.recentCrashFor('worker', now - 60_000);
    assert.equal(prev.id, id);
    const merged = s.mergeCrash(id, { cid: 'a', t: now, kind: 'x', title: 'Second', severity: 'critical', finishedAt: 'f2', report: {} });
    assert.equal(merged.occurrences, 2);
    assert.equal(merged.title, 'Second');
    assert.equal(s.unackedCount(), 1);
    s.ackCrash(id);
    assert.equal(s.unackedCount(), 0);
    s.deleteCrash(id);
    assert.equal(s.listCrashes().length, 0);
  });
});

test('events can be filtered by container and ignores round-trip', async () => {
  await withStore((s) => {
    const now = Date.now();
    s.insertEvent({ id: '1', time: now - 2000, type: 'container', action: 'start', actorId: 'a', attributes: { name: 'web' } });
    s.insertEvent({ id: '2', time: now - 1000, type: 'container', action: 'die', actorId: 'b', attributes: { name: 'db', exitCode: '1' } });
    assert.equal(s.events({ from: now - 5000, to: now }).length, 2);
    assert.deepEqual(s.events({ from: now - 5000, to: now, actor: 'b' }).map((e) => e.action), ['die']);
    s.addIgnore('exposed-port:db:5432');
    assert.ok(s.ignores().has('exposed-port:db:5432'));
    s.removeIgnore('exposed-port:db:5432');
    assert.equal(s.ignores().size, 0);
  });
});

test('prune drops data older than the retention window only', async () => {
  await withStore((s) => {
    const now = Date.now();
    s.writeHost(10, now - 3 * 86400_000, { cpu: 1, mem: 1, memTotal: 1, ccpu: 0, cmem: 0 });
    s.writeHost(10, now - 60_000, { cpu: 1, mem: 1, memTotal: 1, ccpu: 0, cmem: 0 });
    s.prune(now);
    const n = s.db.prepare('SELECT count(*) AS n FROM h10').get().n;
    assert.equal(n, 1);
  });
});
