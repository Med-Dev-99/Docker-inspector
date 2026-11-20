// Crash analysis: turns an exit code, the last log lines, recorded metrics and the container's
// configuration into a plain-English verdict ("why did it die?") with evidence and fixes.
// Pure functions - no I/O - so they are easy to test.

const SIGNALS = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
  9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
};

const SIGNAL_INFO = {
  SIGKILL: ['Killed', 'It was force-killed with SIGKILL: by `docker kill`, by a stop that ran past its timeout, or by the out-of-memory killer.'],
  SIGSEGV: ['Segmentation fault', 'The program crashed while accessing invalid memory (SIGSEGV): a bug in native code, an incompatible library, or a binary built for another system.'],
  SIGABRT: ['Aborted', 'The program aborted itself (SIGABRT), usually because of a failed assertion or a fatal error inside a native library.'],
  SIGTERM: ['Terminated', 'It received SIGTERM and shut down - a stop request that did not come through Docker Inspector.'],
  SIGINT: ['Interrupted', 'It received SIGINT (the Ctrl+C signal) and stopped.'],
  SIGILL: ['Illegal CPU instruction', 'The CPU could not execute an instruction (SIGILL): the binary needs CPU features this machine lacks or was built for another architecture.'],
  SIGBUS: ['Bus error', 'A memory access failed at the hardware level (SIGBUS), often a memory-mapped file that shrank or a full /dev/shm.'],
  SIGFPE: ['Arithmetic error', 'The program hit a fatal arithmetic error (SIGFPE), such as an integer division by zero.'],
  SIGPIPE: ['Broken pipe', 'It wrote to a pipe or socket that had been closed (SIGPIPE).'],
  SIGHUP: ['Hang-up signal', 'It received SIGHUP, typically sent when a controlling terminal closes.'],
};

/** Plain-English meaning of an exit code. */
export function explainExit(code) {
  if (!Number.isFinite(code)) return { title: 'Stopped unexpectedly', short: 'unknown exit code', text: 'The container stopped, but Docker did not report an exit code.' };
  if (code === 0) return { title: 'Exited normally', short: 'success', text: 'The main process finished successfully (exit code 0).' };
  if (code === 1) return { title: 'Application error', short: 'general application error', text: 'The application stopped with a general error (exit code 1). The cause is almost always in the last log lines.' };
  if (code === 2) return {
    title: 'Invalid usage or arguments', short: 'misuse / invalid arguments',
    text: 'Exit code 2 usually means invalid command-line arguments, a missing required setting or a shell syntax error.',
    fix: 'Check the command, the entrypoint and the required environment variables.',
  };
  if (code === 125) return {
    title: 'Docker could not start it', short: 'container failed to run',
    text: 'Exit code 125 means the container failed before its command ran: an error in how it was created, such as an invalid option or a missing mount.',
  };
  if (code === 126) return {
    title: 'Command is not executable', short: 'command not executable',
    text: 'The entrypoint or command exists but cannot be run (exit code 126): it is missing execute permission or it is a directory.',
    fix: 'Make the script executable in the Dockerfile (`RUN chmod +x ...`) or run it through a shell (`sh script.sh`).',
  };
  if (code === 127) return {
    title: 'Command not found', short: 'command not found',
    text: 'The entrypoint or command does not exist in the image (exit code 127): a typo, a package that is not installed, or a script saved with Windows (CRLF) line endings.',
    fix: 'Check the command and entrypoint. If it is a shell script, convert it to Unix (LF) line endings.',
  };
  if (code > 128 && code < 160) {
    const sig = SIGNALS[code - 128] || `signal ${code - 128}`;
    const [title, text] = SIGNAL_INFO[sig] || [`Stopped by ${sig}`, `The process was stopped by ${sig}.`];
    return { title, short: `killed by ${sig}`, signal: sig, text: `${text} (exit code ${code})` };
  }
  if (code === 255) return { title: 'Fatal error', short: 'fatal error / exit(-1)', text: 'Exit code 255 usually means the program called exit(-1) or hit a fatal error before it could report a proper code.' };
  return { title: 'Exited with an error', short: 'application-specific error', text: `The application chose exit code ${code}; its meaning is specific to the program. The last log lines usually say why.` };
}

// Ordered from most to least specific: the first pattern that matches wins.
const PATTERNS = [
  { id: 'node-heap', re: /JavaScript heap out of memory|Reached heap limit|FATAL ERROR: .*(Allocation failed|heap)/i, title: 'Node.js ran out of heap memory',
    explain: 'The Node.js process exhausted its JavaScript heap. This is Node’s own limit, so it can happen even when the container has memory left.',
    fix: 'Raise the heap with NODE_OPTIONS=--max-old-space-size=<MB> (keep it below the container limit) or fix the leak.' },
  { id: 'java-oom', re: /java\.lang\.OutOfMemoryError/i, title: 'Java ran out of memory',
    explain: 'The JVM threw OutOfMemoryError: the heap (-Xmx) or another JVM memory area was exhausted.',
    fix: 'Increase -Xmx / MaxRAMPercentage (and the container memory), or find the leak with a heap dump.' },
  { id: 'memory', re: /\bMemoryError\b|Cannot allocate memory|out of memory|failed to allocate|std::bad_alloc/i, title: 'The process ran out of memory',
    explain: 'The application reported that it could not allocate more memory.',
    fix: 'Give the container more memory or reduce what the application keeps in memory.' },
  { id: 'disk-full', re: /No space left on device|ENOSPC|disk quota exceeded|could not extend file/i, title: 'Disk full',
    explain: 'A write failed because the disk (or the volume it writes to) is full.',
    fix: 'Free space with Clean Up (Disk Usage page) or enlarge the disk/volume.' },
  { id: 'port-in-use', re: /address already in use|EADDRINUSE|Only one usage of each socket address|port is already allocated/i, title: 'Port already in use',
    explain: 'It tried to listen on a port that another process or container already uses.',
    fix: 'Stop whatever else uses the port, or map this container to a different host port.' },
  { id: 'exec-format', re: /exec format error/i, title: 'Wrong CPU architecture',
    explain: 'The image contains binaries built for a different CPU architecture (for example arm64 vs amd64).',
    fix: 'Pull or build the image for this machine’s platform (`--platform linux/amd64` or `linux/arm64`).' },
  { id: 'entrypoint-missing', re: /exec: "?[^"\n]+"?: (executable file not found|no such file or directory)|exec .*: no such file or directory|: not found$|command not found/i, title: 'Command or file not found',
    explain: 'The entrypoint, command or a script it calls does not exist inside the image.',
    fix: 'Check the CMD/ENTRYPOINT path. If it is a shell script, make sure it uses Unix line endings and that its interpreter (bash, sh) exists in the image.' },
  { id: 'missing-module', re: /Cannot find module|ModuleNotFoundError|ImportError|No module named|ClassNotFoundException|NoClassDefFoundError|cannot open shared object file|Could not load file or assembly/i, title: 'Missing module or library',
    explain: 'The code imports a package or library that is not installed in the image.',
    fix: 'Rebuild the image and check the dependency install step (requirements.txt, package.json, ...).' },
  { id: 'db-auth', re: /password authentication failed|Access denied for user|authentication failed|WRONGPASS|NOAUTH|role ".*" does not exist|database ".*" does not exist/i, title: 'Database login failed',
    explain: 'The database rejected the credentials or the database/user does not exist.',
    fix: 'Make sure the credentials in its environment variables match the database (and that the database was initialised with them).' },
  { id: 'dependency-down', re: /ECONNREFUSED|Connection refused|could not connect to server|connection to server .* failed|Can't connect to (MySQL|local MySQL)|Connection reset by peer|ETIMEDOUT|timed out connecting|dial tcp .*: connect:/i, title: 'Could not reach a service it depends on',
    explain: 'It tried to connect to another service (database, API, cache, ...) that was not running or not ready yet.',
    fix: 'Start the dependency first. In Compose add a healthcheck to it and use `depends_on: { <service>: { condition: service_healthy } }`, or retry the connection on startup.' },
  { id: 'dns', re: /getaddrinfo (ENOTFOUND|EAI_AGAIN)|Name or service not known|Temporary failure in name resolution|no such host|could not translate host name|Unknown host/i, title: 'Host name could not be resolved',
    explain: 'It could not resolve a host name, so it never reached the service.',
    fix: 'Check the host name. Containers can only reach each other by name when they share a Docker network.' },
  { id: 'permission', re: /permission denied|EACCES|Operation not permitted|read-only file system/i, title: 'Permission denied',
    explain: 'The process was not allowed to read or write a file, directory or device.',
    fix: 'Check the ownership of mounted volumes and the user the container runs as (the `user:` setting / USER in the Dockerfile).' },
  { id: 'config', re: /nginx: \[emerg\]|invalid (config|configuration)|configuration (error|file .* (is )?invalid)|yaml: |YAMLException|SyntaxError|IndentationError|ParseError|Unexpected token|could not parse|failed to parse|unknown (option|flag|directive)/i, title: 'Invalid configuration or syntax',
    explain: 'It failed to parse its code or configuration.',
    fix: 'Fix the file mentioned in the log line, then restart.' },
  { id: 'python', re: /Traceback \(most recent call last\)/, title: 'Unhandled Python exception', pick: 'exception',
    explain: 'The Python program raised an exception that nothing caught.' },
  { id: 'go-panic', re: /^panic: |goroutine \d+ \[running\]/, title: 'Go panic', pick: 'panic',
    explain: 'The Go program panicked.' },
  { id: 'java-exception', re: /Exception in thread|^Caused by: /, title: 'Unhandled Java exception', pick: 'java',
    explain: 'The Java program threw an exception that nothing caught.' },
  { id: 'js-error', re: /UnhandledPromiseRejection|Uncaught (Exception|TypeError|ReferenceError|Error)|^\s*(TypeError|ReferenceError|RangeError|Error): |node:internal/, title: 'Unhandled JavaScript error', pick: 'js',
    explain: 'The Node.js program threw an error that nothing caught.' },
  { id: 'segfault', re: /Segmentation fault|core dumped|SIGSEGV/i, title: 'Segmentation fault',
    explain: 'A native component crashed while accessing invalid memory.' },
  { id: 'fatal', re: /\b(FATAL|CRITICAL|PANIC)\b|Fatal error|\bfatal: /, title: 'A fatal error was logged',
    explain: 'The application logged a fatal error just before it stopped.' },
];

const EXCEPTION_LINE = /^\s*([A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Failure|Warning))(:|$)/;
const ERRORISH = /error|fatal|exception|panic|failed|failure|refused|denied|cannot|can't|unable/i;

/** Find the most informative line in the last log lines. */
export function analyzeLogs(lines) {
  const tail = lines.slice(-150);
  const offset = lines.length - tail.length;
  let best = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const text = tail[i].text || '';
    const limit = best ? best.p : PATTERNS.length;
    for (let p = 0; p < limit; p++) {
      if (PATTERNS[p].re.test(text)) { best = { p, i }; break; }
    }
    if (best?.p === 0) break;
  }

  let lastError = null;
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 40); i--) {
    if (tail[i].stream === 'stderr' || ERRORISH.test(tail[i].text)) { lastError = { index: offset + i, text: tail[i].text }; break; }
  }
  if (!best) return { match: null, index: lastError?.index ?? null, line: lastError?.text ?? null, lastError };

  const pattern = PATTERNS[best.p];
  let index = best.i;
  // For stack traces, point at the line that names the actual error instead of the trace header.
  if (pattern.pick) {
    for (let j = tail.length - 1; j >= best.i; j--) {
      const t = tail[j].text;
      const hit = pattern.pick === 'exception' ? EXCEPTION_LINE.test(t)
        : pattern.pick === 'panic' ? /^panic: /.test(t)
        : pattern.pick === 'java' ? /^(Caused by: |Exception in thread )/.test(t)
        : /^\s*\w*Error(: | \[)|Error: /.test(t);
      if (hit) { index = j; break; }
    }
  }
  const line = tail[index].text;
  let title = pattern.title;
  if (pattern.pick === 'exception') {
    const m = line.match(EXCEPTION_LINE);
    if (m) title = `Unhandled Python exception: ${m[1].split('.').pop()}`;
  }
  return { match: { ...pattern, title }, index: offset + index, line, lastError };
}

// ------------------------------------------------------------------ helpers
const MiB = 1024 * 1024;
export function fmtBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  const v = b >= 100 || i === 0 ? Math.round(b) : Math.round(b * 10) / 10;
  return `${v} ${u[i]}`;
}
export function fmtDuration(ms) {
  if (ms < 1000) return 'less than a second';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} days`;
}
/** A sensible memory limit: 1.5x the observed peak, rounded up to 64 MB, at least 128 MB. */
export function suggestLimit(peak) {
  return Math.max(128 * MiB, Math.ceil((peak * 1.5) / (64 * MiB)) * 64 * MiB);
}
const clip = (s, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------ main analysis
/**
 * @param ctx.inspect      container inspect document (may be null if the container is gone)
 * @param ctx.attrs        attributes of the `die` event
 * @param ctx.logs         [{ stream, text, ts }] - last log lines, oldest first
 * @param ctx.samples      [{ t, cpu, mem, memLimit, ncpu }] - 1 s samples recorded before the crash
 * @param ctx.oom          an `oom` event was seen just before `die`
 * @param ctx.deps         [{ service, state }] compose dependencies that were not running
 * @param ctx.occurrences  how many times it crashed in the current crash loop window
 * @param ctx.source       'live' (seen happening) or 'scan' (found at startup)
 */
export function analyzeCrash(ctx) {
  const { inspect, attrs = {}, logs = [], samples = [], deps = [], occurrences = 1, source = 'live' } = ctx;
  const st = inspect?.State || {};
  const hc = inspect?.HostConfig || {};
  const name = (inspect?.Name || '').replace(/^\//, '') || attrs.name || 'container';
  const code = Number.isFinite(ctx.exitCode) ? ctx.exitCode : Number(st.ExitCode ?? attrs.exitCode);
  const oomKilled = !!(ctx.oom || st.OOMKilled);
  const exit = explainExit(code);
  const logInfo = analyzeLogs(logs);
  // Without a limit Docker reports the host's total memory as "limit"; only trust a real one.
  const sampleLimit = samples.findLast?.((s) => s.memLimit)?.memLimit || 0;
  const limit = hc.Memory || (!inspect && sampleLimit && ctx.hostMemTotal && sampleLimit < ctx.hostMemTotal * 0.95 ? sampleLimit : 0);
  const evidence = [];
  const suggestions = [];
  const policy = hc.RestartPolicy?.Name || 'no';

  // ---- metrics
  const mem = samples.map((s) => s.mem).filter((v) => Number.isFinite(v) && v > 0);
  const peak = mem.length ? Math.max(...mem) : 0;
  const windowMs = samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0;
  const quarter = mem.slice(0, Math.max(1, Math.floor(mem.length / 4)));
  const early = quarter.length ? quarter.reduce((a, b) => a + b, 0) / quarter.length : 0;
  const late = mem.length ? mem[mem.length - 1] : 0;
  const growing = mem.length > 10 && late > early * 1.8 && late - early > 50 * MiB;

  // ---- verdict
  let kind;
  let title;
  let summary;
  let severity = 'high';
  if (oomKilled) {
    kind = 'oom';
    severity = 'critical';
    title = 'Out of memory';
    summary = limit
      ? `It used up its ${fmtBytes(limit)} memory limit, so the kernel killed it (OOM).`
      : 'The kernel’s out-of-memory killer stopped it. It has no memory limit, so the whole machine was running short of memory.';
    if (limit) {
      const target = suggestLimit(Math.max(peak, limit));
      suggestions.push({
        text: `Give it more memory (for example ${fmtBytes(target)}) or find what is using it.`,
        command: `docker update --memory ${Math.round(target / MiB)}m --memory-swap ${Math.round((target * 2) / MiB)}m ${name}`,
      });
    } else {
      suggestions.push({ text: 'Set a memory limit so a single container cannot exhaust the whole machine, and look for other memory-hungry processes.' });
    }
    if (logInfo.match && ['node-heap', 'java-oom', 'memory'].includes(logInfo.match.id) && logInfo.match.fix) suggestions.push({ text: logInfo.match.fix });
  } else if (logInfo.match) {
    kind = logInfo.match.id;
    title = logInfo.match.title;
    summary = logInfo.match.explain;
    if (logInfo.match.fix) suggestions.push({ text: logInfo.match.fix });
    if (['node-heap', 'java-oom', 'memory', 'segfault'].includes(kind)) severity = 'critical';
  } else {
    kind = `exit-${Number.isFinite(code) ? code : 'unknown'}`;
    title = exit.title;
    summary = exit.text;
    if (exit.fix) suggestions.push({ text: exit.fix });
  }

  // ---- evidence
  evidence.push({ icon: 'exit', text: `Exit code ${Number.isFinite(code) ? code : '?'} - ${exit.short}${exit.signal && !exit.short.includes(exit.signal) ? ` (${exit.signal})` : ''}.` });
  if (oomKilled) evidence.push({ icon: 'memory', text: st.OOMKilled ? 'Docker reports OOMKilled = true.' : 'The kernel sent an out-of-memory event just before it stopped.' });

  if (logInfo.line) {
    evidence.push({ icon: 'log', text: `${logInfo.match ? 'The log says' : 'Last error in the log'}: “${clip(logInfo.line.trim())}”`, logIndex: logInfo.index });
  } else if (!logs.length) {
    evidence.push({ icon: 'log', text: 'No log output was available (the container may have been removed right away).' });
  }

  const started = Date.parse(st.StartedAt || '');
  const finished = Date.parse(st.FinishedAt || '');
  const ranMs = started > 0 && finished > started ? finished - started : null;
  if (ranMs !== null) {
    const startup = ranMs < 15_000 && !oomKilled;
    evidence.push({ icon: 'clock', text: `It ran for ${fmtDuration(ranMs)} before stopping${startup ? ' - it failed while starting up' : ''}.` });
    if (startup && !oomKilled && !logInfo.match) {
      suggestions.push({ text: 'Because it fails right at startup, look at its configuration: command, environment variables, mounted files and services it needs.' });
    }
  }

  if (peak && oomKilled && limit && peak < limit * 0.8) {
    // Recorded memory was far below the limit: it exploded faster than the 1 s sampling could see.
    evidence.push({ icon: 'trend', text: `Memory was only ${fmtBytes(late || peak)} at the last measurement, then shot up to the ${fmtBytes(limit)} limit within about a second - a sudden spike (a huge allocation or runaway loop) rather than a slow leak.` });
  } else if (peak && (oomKilled || windowMs >= 5000)) {
    const pct = limit ? Math.round((peak / limit) * 100) : null;
    evidence.push({ icon: 'memory', text: `Memory peaked at ${fmtBytes(peak)}${limit ? ` (${pct}% of its ${fmtBytes(limit)} limit)` : ' (no memory limit set)'} in the ${fmtDuration(windowMs)} before it stopped.` });
    if (growing) {
      evidence.push({ icon: 'trend', text: `Memory grew from about ${fmtBytes(early)} to ${fmtBytes(late)} - a steady climb like this often means a memory leak.` });
      if (!oomKilled) suggestions.push({ text: 'Watch its memory curve in the Timeline: if it climbs until every crash, look for a leak.' });
    } else if (!oomKilled && limit && peak > limit * 0.9) {
      evidence.push({ icon: 'memory', text: 'It was running very close to its memory limit.' });
    }
  }
  const cpus = samples.map((s) => s.cpu).filter(Number.isFinite);
  if (cpus.length > 5 && hc.NanoCpus) {
    const avg = cpus.reduce((a, b) => a + b, 0) / cpus.length;
    const cap = (hc.NanoCpus / 1e9) * 100;
    if (avg > cap * 0.9) evidence.push({ icon: 'cpu', text: `CPU was maxed out at its limit (${(hc.NanoCpus / 1e9).toFixed(2)} CPUs).` });
  }

  const health = st.Health;
  if (health && (health.Status === 'unhealthy' || health.FailingStreak > 0)) {
    const last = (health.Log || []).slice(-1)[0];
    evidence.push({ icon: 'health', text: `Its health check was failing (${health.FailingStreak || 0} times in a row)${last?.Output ? `: “${clip(last.Output.trim(), 160)}”` : ''}.` });
  }

  for (const d of deps) {
    evidence.push({ icon: 'link', text: `Its dependency “${d.service}” was ${d.state === 'missing' ? 'not created' : d.state === 'running' ? 'running but maybe not ready' : 'not running'} at that moment.` });
  }
  if (deps.some((d) => d.state !== 'running') && !suggestions.some((s) => s.text.includes('depends_on'))) {
    suggestions.push({ text: 'Start its dependencies first, or let Compose wait for them: give them a healthcheck and use `depends_on` with `condition: service_healthy`.' });
  }

  const restarts = inspect?.RestartCount || 0;
  if (occurrences >= 3 || restarts >= 3) {
    severity = 'critical';
    evidence.push({ icon: 'loop', text: `It has crashed ${Math.max(occurrences, restarts)} times in a row - it is stuck in a crash loop (restart policy: ${policy}).` });
    suggestions.push({ text: 'Docker keeps restarting it and it keeps failing. Fix the cause above, or stop it so it stops wasting resources.' });
  } else if (policy === 'no' && source === 'live') {
    suggestions.push({ text: 'It will stay stopped. If it should keep running, use the restart policy “unless-stopped” (Overview → Resources & Restart → Edit).' });
  }
  if (source === 'scan') evidence.push({ icon: 'info', text: 'Found when Docker Inspector started, so no metrics were recorded for the moments before this crash.' });

  return {
    kind, title, summary, severity,
    exitCode: Number.isFinite(code) ? code : null,
    signal: exit.signal || null,
    oom: oomKilled,
    evidence, suggestions,
    logIndex: logInfo.index,
    ranMs, peakMem: peak || null, memLimit: limit || null,
  };
}
