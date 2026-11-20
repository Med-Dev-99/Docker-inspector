// Doctor: audits running configuration (not image CVEs) for security, reliability, resource and
// maintenance problems, and scores every container. Findings carry ready-to-use fixes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as docker from './docker.js';
import { hostInfo } from './hub.js';
import { fmtBytes, suggestLimit } from './crash.js';

// Points lost per finding on a container, and per kind of finding for the overall score.
const WEIGHT = { critical: 30, high: 15, medium: 7, low: 3, info: 0 };
const GLOBAL_WEIGHT = { critical: 20, high: 6, medium: 2.5, low: 1, info: 0 };
const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const SENSITIVE_PORTS = {
  5432: 'PostgreSQL', 3306: 'MySQL/MariaDB', 27017: 'MongoDB', 6379: 'Redis', 6380: 'Redis', 9200: 'Elasticsearch',
  9300: 'Elasticsearch', 5984: 'CouchDB', 11211: 'Memcached', 2375: 'the Docker API', 2376: 'the Docker API',
  5672: 'RabbitMQ', 15672: 'RabbitMQ management', 8086: 'InfluxDB', 9042: 'Cassandra', 7474: 'Neo4j', 7687: 'Neo4j',
  1433: 'SQL Server', 1521: 'Oracle', 26257: 'CockroachDB', 8529: 'ArangoDB', 9092: 'Kafka', 2181: 'ZooKeeper',
};
const DANGEROUS_CAPS = ['ALL', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_RAWIO', 'DAC_READ_SEARCH', 'NET_ADMIN', 'SYS_TIME', 'BPF'];
const MiB = 1024 * 1024;

// Same heuristic as the UI (src/lib/format.ts).
const URL_CREDS = /:\/\/[^/\s:@]+:[^@\s]+@/;
const SECRET_WORDS = new Set(['PASSWORD', 'PASS', 'PASSWD', 'PWD', 'SECRET', 'SECRETS', 'TOKEN', 'APIKEY', 'KEY', 'PRIVATE', 'CREDENTIAL', 'CREDENTIALS', 'SALT', 'DSN', 'JWT', 'PASSPHRASE', 'SIGNATURE']);
const NOT_SECRET_SUFFIX = new Set(['FILE', 'PATH', 'DIR', 'SECONDS', 'TTL', 'TIMEOUT', 'ENABLED', 'HOST', 'PORT', 'USER', 'USERNAME', 'NAME', 'ID', 'LIMIT', 'SIZE', 'INTERVAL', 'MODE', 'TYPE', 'LENGTH', 'COUNT', 'HEADER', 'URL_PATH']);
function isSecretKey(k, v = '') {
  if (URL_CREDS.test(v)) return true;
  const segs = k.toUpperCase().split(/[_\-.]+/).filter(Boolean);
  if (!segs.length || NOT_SECRET_SUFFIX.has(segs[segs.length - 1])) return false;
  return segs.some((s) => SECRET_WORDS.has(s)) || /(PASSWORD|SECRET|TOKEN|APIKEY)$/.test(k.toUpperCase());
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function readUfw() {
  try { return /^\s*ENABLED\s*=\s*yes/mi.test(fs.readFileSync('/etc/ufw/ufw.conf', 'utf8')); } catch { return null; }
}
function readDaemonJson() {
  try { return JSON.parse(fs.readFileSync('/etc/docker/daemon.json', 'utf8')); } catch (e) { return e.code === 'ENOENT' ? {} : null; }
}
const ago = (ms) => {
  const d = Date.now() - ms;
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60000))} min ago`;
  if (d < 2 * 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  return `${Math.round(d / 86400_000)} days ago`;
};

function healthSnippet(image, port) {
  const img = image.toLowerCase();
  const test = img.includes('postgres') ? '["CMD-SHELL", "pg_isready -U $${POSTGRES_USER:-postgres}"]'
    : img.includes('redis') ? '["CMD", "redis-cli", "ping"]'
    : img.includes('mysql') || img.includes('mariadb') ? '["CMD", "mysqladmin", "ping", "-h", "localhost"]'
    : img.includes('mongo') ? '["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand(\'ping\')"]'
    : `["CMD-SHELL", "wget -qO- http://localhost:${port || 80}/ >/dev/null || exit 1"]`;
  return `healthcheck:\n  test: ${test}\n  interval: 30s\n  timeout: 5s\n  retries: 3\n  start_period: 20s`;
}

// --------------------------------------------------------------------------- checks
async function compute({ info, store, hub }) {
  const [list, images] = await Promise.all([docker.get('/containers/json?all=1'), docker.get('/images/json')]);
  const df = await docker.get('/system/df').catch(() => null);
  const selfId = process.env.DI_CONTAINER ? os.hostname() : null;
  const inspects = (await mapLimit(list, 8, (c) => docker.get(`/containers/${c.Id}/json`).catch(() => null))).filter(Boolean);

  const tagToImage = new Map();
  for (const img of images) for (const t of img.RepoTags || []) tagToImage.set(t, img);
  const imageEnvCache = new Map();
  const imageEnv = async (id) => {
    if (!imageEnvCache.has(id)) imageEnvCache.set(id, docker.get(`/images/${id}/json`).then((x) => new Set(x?.Config?.Env || [])).catch(() => new Set()));
    return imageEnvCache.get(id);
  };

  const osName = String(info.OperatingSystem || '');
  const desktop = osName.includes('Docker Desktop');
  const local = docker.SOCKET_PATH.startsWith('/');
  const native = local && !desktop;
  const ufw = readUfw();
  const daemonCfg = process.env.DI_CONTAINER ? null : readDaemonJson();
  const host = hostInfo(info.DockerRootDir);
  const now = Date.now();

  const findings = [];
  const add = (f) => findings.push({ fixes: [], ...f, key: f.key || `${f.check}:${f.target?.name || '*'}` });

  // Root check needs the process list of running containers (docker top works for any image).
  const running = inspects.filter((i) => i.State?.Running);
  const tops = new Map(await mapLimit(running, 6, async (i) => [i.Id, await docker.get(`/containers/${i.Id}/top`).catch(() => null)]));

  let unboundedLogs = 0;
  for (const i of inspects) {
    if (selfId && i.Id.startsWith(selfId)) continue;
    const name = i.Name.replace(/^\//, '');
    const labels = i.Config?.Labels || {};
    const target = { id: i.Id, name, project: labels['com.docker.compose.project'] || null, running: !!i.State?.Running };
    const hc = i.HostConfig || {};
    const cfg = i.Config || {};
    const st = i.State || {};
    const ref = cfg.Image || '';

    // ------------------------------------------------ security
    const sock = (i.Mounts || []).find((m) => /docker\.sock$/.test(m.Source || '') || /docker\.sock$/.test(m.Destination || ''));
    if (sock) add({
      check: 'docker-socket', severity: 'critical', category: 'security', target,
      title: 'Has full control of Docker (and the host)',
      detail: `It mounts the Docker socket (${sock.Source}). Anything running inside can start privileged containers and take over the whole machine${sock.RW === false ? ' - mounting it read-only does not prevent that' : ''}.`,
      fixes: [{ kind: 'copy', label: 'Copy safer alternative', text: '# Give it only the API calls it needs through a socket proxy\n# (https://github.com/Tecnativa/docker-socket-proxy):\nservices:\n  socket-proxy:\n    image: tecnativa/docker-socket-proxy\n    environment:\n      CONTAINERS: 1   # read-only access to container info\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n  your-app:\n    environment:\n      DOCKER_HOST: tcp://socket-proxy:2375' }],
    });
    if (hc.Privileged) add({
      check: 'privileged', severity: 'critical', category: 'security', target,
      title: 'Runs in privileged mode',
      detail: 'A privileged container gets almost every capability of the host and access to all devices. Escaping it to the host is trivial.',
      fixes: [{ kind: 'copy', label: 'Copy fix', text: '# Remove `privileged: true` and grant only what it needs, e.g.:\ncap_add:\n  - NET_ADMIN\ndevices:\n  - /dev/fuse' }],
    });
    const caps = (hc.CapAdd || []).map((c) => c.replace(/^CAP_/, '')).filter((c) => DANGEROUS_CAPS.includes(c));
    if (!hc.Privileged && caps.length) add({
      check: 'dangerous-caps', severity: 'high', category: 'security', target,
      title: `Has powerful capabilities: ${caps.join(', ')}`,
      detail: 'These Linux capabilities give it partial control over the host (kernel, network or other processes). Keep them only if it really needs them.',
    });
    if (hc.NetworkMode === 'host') add({
      check: 'host-network', severity: 'medium', category: 'security', target,
      title: 'Shares the host’s network',
      detail: 'With network_mode: host every port it opens is opened directly on the host, outside Docker’s network isolation and port publishing rules.',
    });
    if (hc.PidMode === 'host') add({
      check: 'host-pid', severity: 'medium', category: 'security', target,
      title: 'Can see every process on the host',
      detail: 'With pid: host it can inspect (and with enough privileges, signal) all processes of the machine.',
    });

    if (target.running) {
      const seen = new Set();
      for (const [key, binds] of Object.entries(i.NetworkSettings?.Ports || {})) {
        if (!binds) continue;
        const [cport, proto] = key.split('/');
        for (const b of binds) {
          const ip = b.HostIp || '';
          if (!(ip === '' || ip === '0.0.0.0' || ip === '::')) continue;
          if (seen.has(`${b.HostPort}/${proto}`)) continue;
          seen.add(`${b.HostPort}/${proto}`);
          const svc = SENSITIVE_PORTS[cport] || SENSITIVE_PORTS[b.HostPort];
          const bypass = native && ufw === true;
          const suffix = proto === 'udp' ? '/udp' : '';
          add({
            check: 'exposed-port', key: `exposed-port:${name}:${b.HostPort}`, target,
            severity: svc ? (bypass ? 'critical' : 'high') : bypass ? 'high' : 'medium',
            category: 'security',
            title: bypass ? `Port ${b.HostPort} bypasses your UFW firewall` : `Port ${b.HostPort} is open to your network`,
            detail: `${svc ? `${svc} (port ${cport})` : `Port ${cport}/${proto}`} is published on all network interfaces, so other machines can connect to it.`
              + (bypass ? ' UFW is enabled, but Docker inserts its own firewall rules before UFW’s, so UFW does not block this port.' : '')
              + (svc ? ' Databases and admin services should never be reachable from outside.' : '')
              + ' If only this computer needs it, bind it to 127.0.0.1.',
            fixes: [
              { kind: 'copy', label: 'Copy Compose fix', text: `ports:\n  - "127.0.0.1:${b.HostPort}:${cport}${suffix}"` },
              { kind: 'copy', label: 'Copy docker run flag', text: `-p 127.0.0.1:${b.HostPort}:${cport}${suffix}` },
            ],
          });
        }
      }

      const top = tops.get(i.Id);
      const uidCol = top?.Titles?.indexOf('UID') ?? -1;
      if (!hc.UsernsMode && uidCol >= 0 && top.Processes?.length && top.Processes.every((p) => p[uidCol] === 'root' || p[uidCol] === '0')) add({
        check: 'root-user', severity: 'low', category: 'security', target,
        title: 'Runs as root',
        detail: 'All of its processes run as root. If someone breaks into the application, they are root inside the container - one step away from the host.',
        fixes: [{ kind: 'copy', label: 'Copy fix', text: '# Dockerfile\nUSER 1000\n\n# or in Compose\nuser: "1000:1000"' }],
      });
    }

    const env = cfg.Env || [];
    if (env.length) {
      const inherited = await imageEnv(i.Image);
      const secrets = env.filter((e) => !inherited.has(e)).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])
        .filter(([k, v]) => k && v && isSecretKey(k, v)).map(([k]) => k);
      if (secrets.length) add({
        check: 'env-secrets', severity: 'low', category: 'security', target,
        title: `${secrets.length === 1 ? 'A secret is' : `${secrets.length} secrets are`} stored in environment variables`,
        detail: `${secrets.join(', ')} ${secrets.length === 1 ? 'is' : 'are'} stored in plain text in the container’s configuration, so anyone who can run docker inspect (or read the compose file) can see ${secrets.length === 1 ? 'it' : 'them'}.`,
        fixes: [{ kind: 'copy', label: 'Copy Compose secrets example', text: 'secrets:\n  db_password:\n    file: ./db_password.txt\nservices:\n  app:\n    secrets: [db_password]\n    environment:\n      DB_PASSWORD_FILE: /run/secrets/db_password' }],
      });
    }

    // ------------------------------------------------ reliability
    if (target.running && ['', 'no'].includes(hc.RestartPolicy?.Name || '') && !hc.AutoRemove) add({
      check: 'no-restart-policy', severity: 'low', category: 'reliability', target,
      title: 'Won’t come back after a crash or reboot',
      detail: 'Its restart policy is “no”, so if it crashes or the machine reboots it stays down until someone starts it.',
      fixes: [{ kind: 'update', label: 'Restart unless stopped', body: { RestartPolicy: { Name: 'unless-stopped' } } }],
    });
    if (target.running && (!cfg.Healthcheck || cfg.Healthcheck.Test?.[0] === 'NONE')) {
      const firstPort = Object.keys(cfg.ExposedPorts || {})[0]?.split('/')[0];
      add({
        check: 'no-healthcheck', severity: 'info', category: 'reliability', target,
        title: 'No health check',
        detail: 'Docker only knows whether the process is alive, not whether it actually works (accepts connections, answers requests). Health checks also let Compose start services in the right order.',
        fixes: [{ kind: 'copy', label: 'Copy health check', text: healthSnippet(ref, firstPort) }],
      });
    }
    if (target.running && st.Health?.Status === 'unhealthy') {
      const last = (st.Health.Log || []).slice(-1)[0];
      add({
        check: 'unhealthy', severity: 'high', category: 'reliability', target,
        title: 'Health check is failing',
        detail: `It has failed its health check ${st.Health.FailingStreak} times in a row${last?.Output ? `: “${last.Output.trim().slice(0, 200)}”` : ''}.`,
        fixes: [{ kind: 'navigate', label: 'Open logs', to: `/containers/${i.Id}/logs` }],
      });
    }
    const recent = store ? store.crashesFor(name, now - 3600_000) : [];
    const loopCount = recent.reduce((a, c) => a + c.occurrences, 0);
    if (st.Restarting || loopCount >= 3) add({
      check: 'crash-loop', severity: 'critical', category: 'reliability', target,
      title: 'Stuck in a crash loop',
      detail: `It crashed ${Math.max(loopCount, i.RestartCount || 0)} times recently and Docker keeps restarting it.`,
      fixes: recent[0] ? [{ kind: 'navigate', label: 'View crash report', to: `/crashes/${recent[0].id}` }] : [{ kind: 'navigate', label: 'Open logs', to: `/containers/${i.Id}/logs` }],
    });
    const oomRecent = store ? store.crashesFor(name, now - 86400_000).find((c) => c.oom) : null;
    if (oomRecent) add({
      check: 'oom-recent', severity: 'high', category: 'resources', target,
      title: 'Ran out of memory recently',
      detail: `It was killed for running out of memory ${ago(oomRecent.lastT)}.`,
      fixes: [{ kind: 'navigate', label: 'View crash report', to: `/crashes/${oomRecent.id}` }],
    });
    if (!target.running && st.Status === 'exited' && ![0, 130, 137, 143].includes(st.ExitCode) && !st.Restarting && ['', 'no'].includes(hc.RestartPolicy?.Name || '')) {
      const finished = Date.parse(st.FinishedAt);
      if (finished > now - 30 * 86400_000) {
        const report = store ? store.crashesFor(name, finished - 60_000)[0] : null;
        add({
          check: 'exited-error', severity: 'low', category: 'reliability', target,
          title: `Exited with error code ${st.ExitCode}`,
          detail: `It stopped ${ago(finished)} with exit code ${st.ExitCode} and has not been restarted.`,
          fixes: [report ? { kind: 'navigate', label: 'Why did it fail?', to: `/crashes/${report.id}` } : { kind: 'navigate', label: 'Open logs', to: `/containers/${i.Id}/logs` }],
        });
      }
    }

    // ------------------------------------------------ resources
    if (target.running) {
      const latest = hub?.latestFor(i.Id);
      const peak = Math.max(store ? store.peakMem(i.Id, now - 7 * 86400_000) : 0, latest?.mem || 0);
      if (!hc.Memory) {
        const tgt = peak ? suggestLimit(peak) : 0;
        add({
          check: 'no-memory-limit', severity: 'low', category: 'resources', target,
          title: 'No memory limit',
          detail: `A memory leak here can use up all ${fmtBytes(host.mem.total)} of the machine’s memory and slow everything down.${peak ? ` It has used at most ${fmtBytes(peak)} in the recorded history.` : ''}`,
          fixes: tgt
            ? [{ kind: 'update', label: `Limit to ${fmtBytes(tgt)}`, body: { Memory: tgt, MemorySwap: tgt * 2 } }, { kind: 'copy', label: 'Copy Compose setting', text: `mem_limit: ${Math.round(tgt / MiB)}m` }]
            : [{ kind: 'copy', label: 'Copy Compose setting', text: 'mem_limit: 512m' }],
        });
      } else if (latest && latest.mem > hc.Memory * 0.9) {
        const tgt = suggestLimit(Math.max(peak, hc.Memory));
        add({
          check: 'memory-pressure', severity: 'medium', category: 'resources', target,
          title: `Using ${Math.round((latest.mem / hc.Memory) * 100)}% of its memory limit`,
          detail: `It is using ${fmtBytes(latest.mem)} of its ${fmtBytes(hc.Memory)} limit and is at risk of being killed for running out of memory.`,
          fixes: [{ kind: 'update', label: `Raise to ${fmtBytes(tgt)}`, body: { Memory: tgt, MemorySwap: tgt * 2 } }],
        });
      }
    }

    // ------------------------------------------------ maintenance
    if ((hc.LogConfig?.Type || 'json-file') === 'json-file' && !hc.LogConfig?.Config?.['max-size']) {
      unboundedLogs++;
      add({
        check: 'unbounded-logs', severity: 'medium', category: 'maintenance', target,
        title: 'Log file grows without limit',
        detail: 'It uses the json-file log driver without rotation, so its log file keeps growing until the disk is full.',
        fixes: [{ kind: 'copy', label: 'Copy Compose fix', text: 'logging:\n  driver: json-file\n  options:\n    max-size: "10m"\n    max-file: "3"' }],
      });
    }
    if (ref && !ref.startsWith('sha256:') && !ref.includes('@')) {
      const lastPart = ref.slice(ref.lastIndexOf('/') + 1);
      const tagged = lastPart.includes(':');
      const tag = tagged ? lastPart.split(':').pop() : 'latest';
      if (tag === 'latest') add({
        check: 'latest-tag', severity: 'low', category: 'maintenance', target,
        title: 'Uses the :latest tag',
        detail: `“${ref}” can point to a different version after the next pull, so recreating the container may silently upgrade (or break) it. Pin a version tag.`,
      });
      const full = tagged ? ref : `${ref}:latest`;
      const current = tagToImage.get(full) || tagToImage.get(full.replace(/^docker\.io\/(library\/)?/, ''));
      if (current && current.Id !== i.Image) {
        const wd = labels['com.docker.compose.project.working_dir'];
        const svc = labels['com.docker.compose.service'];
        add({
          check: 'outdated-image', severity: 'medium', category: 'maintenance', target,
          title: 'Runs an outdated image',
          detail: `“${full}” was rebuilt or pulled ${ago(current.Created * 1000)}, but this container still runs the previous version. Recreate it to use the new image (the old one also keeps taking disk space).`,
          fixes: [wd && svc
            ? { kind: 'copy', label: 'Copy recreate command', text: `cd "${wd}" && docker compose up -d ${svc}` }
            : { kind: 'copy', label: 'Copy hint', text: `# Recreate ${name} with the same options and the image ${full}` }],
        });
      }
    }
  }

  // ------------------------------------------------ engine / host
  if (host.disk) {
    const freePct = (host.disk.free / host.disk.total) * 100;
    const sev = freePct < 5 ? 'critical' : freePct < 10 ? 'high' : freePct < 15 ? 'medium' : null;
    if (sev) add({
      check: 'disk-space', severity: sev, category: 'maintenance', target: null,
      title: `Disk almost full (${Math.round(100 - freePct)}% used)`,
      detail: `Only ${fmtBytes(host.disk.free)} is free on the disk that holds Docker’s data. When it fills up, containers and databases start failing.`,
      fixes: [{ kind: 'navigate', label: 'Open Clean Up', to: '/storage?cleanup=1' }],
    });
  }
  if (df) {
    let reclaim = 0;
    for (const img of df.Images || []) if (img.Containers === 0) reclaim += Math.max(0, img.Size - Math.max(0, img.SharedSize));
    for (const c of df.Containers || []) if (!['running', 'paused', 'restarting'].includes(c.State)) reclaim += c.SizeRw || 0;
    for (const b of df.BuildCache || []) if (!b.InUse && !b.Shared) reclaim += b.Size;
    const sev = reclaim > 20e9 ? 'medium' : reclaim > 5e9 ? 'low' : null;
    if (sev) add({
      check: 'reclaimable', severity: sev, category: 'maintenance', target: null,
      title: `${fmtBytes(reclaim)} of disk space can be reclaimed`,
      detail: 'Unused images, stopped containers and build cache are taking up space.',
      fixes: [{ kind: 'navigate', label: 'Open Clean Up', to: '/storage?cleanup=1' }],
    });
  }
  if (unboundedLogs && native && daemonCfg && !daemonCfg['log-opts']?.['max-size']) add({
    check: 'daemon-log-rotation', severity: 'medium', category: 'maintenance', target: null,
    title: 'Docker has no default log rotation',
    detail: `${unboundedLogs} container${unboundedLogs === 1 ? '' : 's'} keep unlimited logs. Set a default once in /etc/docker/daemon.json and restart Docker; it applies to containers created afterwards.`,
    fixes: [{ kind: 'copy', label: 'Copy daemon.json', text: '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" }\n}\n\n# then: sudo systemctl restart docker' }],
  });
  if (native && !info.LiveRestoreEnabled) add({
    check: 'live-restore', severity: 'info', category: 'reliability', target: null,
    title: 'Containers stop whenever Docker restarts',
    detail: 'Without live-restore, updating or restarting the Docker daemon stops all running containers.',
    fixes: [{ kind: 'copy', label: 'Copy daemon.json setting', text: '"live-restore": true' }],
  });
  if (!process.env.DI_CONTAINER && local) {
    const desktopSock = path.join(os.homedir(), '.docker/desktop/docker.sock');
    const both = fs.existsSync('/var/run/docker.sock') && fs.existsSync(desktopSock);
    if (both) {
      const other = desktop ? '/var/run/docker.sock' : desktopSock;
      add({
        check: 'two-engines', severity: 'info', category: 'maintenance', target: null,
        title: 'Two Docker engines on this machine',
        detail: `Docker Inspector is connected to ${docker.SOCKET_PATH} (${osName}). ${desktop ? 'The native Docker Engine' : 'Docker Desktop'} also runs here with its own separate containers, images and volumes, so the two can show different things.`,
        fixes: [{ kind: 'copy', label: 'Copy command to inspect the other one', text: `DOCKER_HOST=unix://${other} npm start` }],
      });
    }
  }

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.check.localeCompare(b.check) || (a.target?.name || '').localeCompare(b.target?.name || ''));
  return {
    generatedAt: now,
    engine: { os: osName, native, desktop, ufw, endpoint: docker.SOCKET_PATH },
    containers: inspects.filter((i) => !(selfId && i.Id.startsWith(selfId))).map((i) => ({
      id: i.Id, name: i.Name.replace(/^\//, ''), project: i.Config?.Labels?.['com.docker.compose.project'] || null, running: !!i.State?.Running,
    })),
    findings,
  };
}

const grade = (s) => (s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 65 ? 'C' : s >= 45 ? 'D' : 'F');

/** Mark ignored findings and compute container + overall scores. */
function score(result, ignores) {
  const findings = result.findings.map((f) => ({ ...f, ignored: ignores.has(f.key) || ignores.has(`${f.check}:*`) }));
  const active = findings.filter((f) => !f.ignored);
  const per = new Map();
  for (const f of active) if (f.target) per.set(f.target.id, (per.get(f.target.id) || 0) + WEIGHT[f.severity]);
  const containers = result.containers.map((c) => {
    const s = Math.max(0, 100 - (per.get(c.id) || 0));
    return { ...c, score: s, grade: grade(s), issues: active.filter((f) => f.target?.id === c.id && f.severity !== 'info').length };
  }).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  // Overall: each kind of problem costs its worst severity, damped for repeats, so 20 similar low findings don't sink the score.
  const byCheck = new Map();
  for (const f of active) {
    const e = byCheck.get(f.check) || { n: 0, sev: 'info' };
    e.n++;
    if (RANK[f.severity] < RANK[e.sev]) e.sev = f.severity;
    byCheck.set(f.check, e);
  }
  let penalty = 0;
  for (const e of byCheck.values()) penalty += GLOBAL_WEIGHT[e.sev] * (1 + 0.5 * Math.log2(e.n));
  const overall = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of active) counts[f.severity]++;
  return { ...result, findings, containers, score: overall, grade: grade(overall), counts };
}

let cache = null;
export async function runDoctor({ info, store, hub, fresh = false }) {
  if (fresh || !cache || Date.now() - cache.t > 20_000) {
    cache = { t: Date.now(), result: await compute({ info, store, hub }) };
  }
  return score(cache.result, store ? store.ignores() : new Set());
}
export function invalidateDoctor() { cache = null; }
