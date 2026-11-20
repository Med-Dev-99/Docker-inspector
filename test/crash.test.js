// Unit tests for the crash analyser. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCrash, analyzeLogs, explainExit, suggestLimit, fmtBytes } from '../server/crash.js';

const MiB = 1024 * 1024;
const lines = (...l) => l.map((t) => ({ stream: t.startsWith('!') ? 'stderr' : 'stdout', text: t.replace(/^!/, '') }));
const inspect = (o = {}) => ({
  Name: '/demo-api',
  State: { ExitCode: 1, StartedAt: '2026-11-20T10:00:00Z', FinishedAt: '2026-11-20T10:30:00Z', ...o.State },
  HostConfig: { Memory: 0, RestartPolicy: { Name: 'no' }, ...o.HostConfig },
  RestartCount: o.RestartCount || 0,
  Config: { Image: 'demo' },
});

test('exit codes are explained in plain English', () => {
  assert.equal(explainExit(0).title, 'Exited normally');
  assert.equal(explainExit(127).title, 'Command not found');
  assert.equal(explainExit(137).signal, 'SIGKILL');
  assert.equal(explainExit(139).title, 'Segmentation fault');
  assert.equal(explainExit(143).signal, 'SIGTERM');
  assert.match(explainExit(42).text, /specific to the program/);
  assert.equal(explainExit(NaN).short, 'unknown exit code');
});

test('OOM with steadily growing memory is called a leak and offers a docker update command', () => {
  const samples = Array.from({ length: 120 }, (_, i) => ({ t: i * 1000, cpu: 40, mem: (100 + i * 3.4) * MiB, memLimit: 512 * MiB }));
  const r = analyzeCrash({
    inspect: inspect({ State: { ExitCode: 137, OOMKilled: true }, HostConfig: { Memory: 512 * MiB } }),
    logs: lines('processing batch 41'), samples, exitCode: 137,
  });
  assert.equal(r.kind, 'oom');
  assert.equal(r.severity, 'critical');
  assert.ok(r.evidence.some((e) => /steady climb/.test(e.text)));
  assert.match(r.suggestions[0].command, /^docker update --memory \d+m --memory-swap \d+m demo-api$/);
});

test('OOM that jumps past the limit between samples is described as a spike, not a leak', () => {
  const samples = Array.from({ length: 8 }, (_, i) => ({ t: i * 1000, cpu: 5, mem: 2 * MiB, memLimit: 64 * MiB }));
  const r = analyzeCrash({ inspect: inspect({ State: { ExitCode: 137, OOMKilled: true }, HostConfig: { Memory: 64 * MiB } }), logs: [], samples, exitCode: 137 });
  assert.ok(r.evidence.some((e) => /sudden spike/.test(e.text)));
  assert.ok(!r.evidence.some((e) => /steady climb/.test(e.text)));
});

test('a Python traceback is reduced to the exception line and classified', () => {
  const r = analyzeCrash({
    inspect: inspect({ State: { FinishedAt: '2026-11-20T10:00:02Z' } }), exitCode: 1,
    logs: lines('Starting worker...', '!Traceback (most recent call last):', '!  File "/app/main.py", line 3, in <module>', "!ModuleNotFoundError: No module named 'pandas'"),
  });
  assert.equal(r.kind, 'missing-module');
  assert.ok(r.evidence.some((e) => e.text.includes("No module named 'pandas'")));
  assert.ok(r.evidence.some((e) => /starting up/.test(e.text)));
});

test('crash loop with a stopped dependency and connection refused', () => {
  const r = analyzeCrash({
    inspect: inspect({ RestartCount: 6, HostConfig: { RestartPolicy: { Name: 'always' } }, State: { FinishedAt: '2026-11-20T10:00:04Z' } }),
    exitCode: 1, occurrences: 4, deps: [{ service: 'db', state: 'exited' }],
    logs: lines('connecting to db:5432', '!Error: connect ECONNREFUSED 172.20.0.3:5432'),
  });
  assert.equal(r.kind, 'dependency-down');
  assert.equal(r.severity, 'critical');
  assert.ok(r.evidence.some((e) => /crash loop/.test(e.text)));
  assert.ok(r.evidence.some((e) => /“db”/.test(e.text)));
  assert.ok(r.suggestions.some((s) => /service_healthy/.test(s.text)));
});

test('the most specific log pattern wins over a generic FATAL line at the end', () => {
  const a = analyzeLogs(lines('!FATAL: password authentication failed for user "shop"', 'retrying', '!FATAL: shutting down'));
  assert.equal(a.match.id, 'db-auth');
  assert.match(a.line, /password authentication failed/);
});

test('without any log match the exit code explains the crash', () => {
  const r = analyzeCrash({ inspect: inspect({ State: { ExitCode: 139 } }), exitCode: 139, logs: [] });
  assert.equal(r.title, 'Segmentation fault');
  assert.ok(r.evidence.some((e) => /No log output/.test(e.text)));
});

test('a memory limit equal to the host memory (i.e. no limit) is not trusted', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, cpu: 1, mem: 50 * MiB, memLimit: 32 * 1024 * MiB }));
  const r = analyzeCrash({ inspect: null, exitCode: 1, samples, logs: [], hostMemTotal: 32 * 1024 * MiB, attrs: { name: 'gone' } });
  assert.equal(r.memLimit, null);
});

test('helpers format sizes and suggest sensible limits', () => {
  assert.equal(fmtBytes(512 * MiB), '512 MB');
  assert.equal(suggestLimit(10 * MiB), 128 * MiB);
  assert.equal(suggestLimit(300 * MiB), 512 * MiB);
});
