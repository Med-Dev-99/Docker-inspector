// Minimal Docker Engine API client over the local unix socket (or plain TCP).
// No external dependencies: plain node:http with `socketPath`.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Where the Docker Engine lives. Honors DOCKER_HOST:
 *   unix:///path/to/docker.sock   (default: /var/run/docker.sock, rootless and Desktop sockets auto-detected)
 *   tcp://host:2375               (plain TCP only - no TLS)
 */
function resolveEndpoint() {
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith('tcp://')) {
    const u = new URL(host);
    return { host: u.hostname, port: Number(u.port || 2375) };
  }
  if (host && host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  const candidates = [
    '/var/run/docker.sock',
    process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'docker.sock'),
    path.join(os.homedir(), '.docker/desktop/docker.sock'),
  ].filter(Boolean);
  return { socketPath: candidates.find((p) => { try { return fs.statSync(p).isSocket(); } catch { return false; } }) || '/var/run/docker.sock' };
}

const ENDPOINT = resolveEndpoint();
/** Human readable endpoint, shown in the UI. */
export const SOCKET_PATH = ENDPOINT.socketPath || `tcp://${ENDPOINT.host}:${ENDPOINT.port}`;
let apiPrefix = '';

export class DockerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Low level request; resolves with the IncomingMessage (body not consumed). */
export function rawRequest(method, apiPath, { body, headers = {}, timeout = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      ...ENDPOINT,
      path: apiPrefix + apiPath,
      method,
      headers: {
        Host: 'docker',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
      timeout,
      signal,
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/** JSON request helper. Throws DockerError on non-2xx. */
export async function request(method, apiPath, opts = {}) {
  const res = await rawRequest(method, apiPath, opts);
  const buf = await readBody(res);
  const text = buf.toString('utf8');
  if (res.statusCode >= 400) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    throw new DockerError(res.statusCode, msg.trim() || `Docker returned ${res.statusCode}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export const get = (p, o) => request('GET', p, o);
export const post = (p, body, o = {}) => request('POST', p, { ...o, body });

/** Negotiate the API version once at startup. */
export async function init() {
  apiPrefix = '';
  const v = await get('/version', { timeout: 5000 });
  apiPrefix = `/v${v.ApiVersion}`;
  return v;
}

/**
 * Stream newline-delimited JSON (stats, events, pull progress).
 * Returns a handle with close().
 */
export function streamJSON(apiPath, onObject, { onEnd, onError, method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  let closed = false;
  rawRequest(method, apiPath, { signal: ctrl.signal, body }).then((res) => {
    if (res.statusCode >= 400) {
      readBody(res).then((b) => {
        let msg = b.toString();
        try { msg = JSON.parse(msg).message; } catch {}
        onError?.(new DockerError(res.statusCode, msg));
      });
      return;
    }
    const dec = new StringDecoder('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += dec.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onObject(JSON.parse(line)); } catch { /* ignore partial garbage */ }
      }
    });
    res.on('end', () => { if (!closed) onEnd?.(); });
    res.on('error', (e) => { if (!closed) onError?.(e); });
  }).catch((e) => { if (!closed) onError?.(e); });
  return { close() { closed = true; ctrl.abort(); } };
}

/**
 * Demultiplex Docker's stdout/stderr framing (used when the container has no TTY).
 * Frame: [stream:u8, 0,0,0, size:u32be] + payload
 */
export class Demuxer {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const type = this.buf[0];
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      const payload = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      this.onFrame(type === 2 ? 'stderr' : 'stdout', payload);
    }
  }
}

/**
 * Follow container logs. Calls onData(stream, text) with decoded text chunks.
 */
export function followLogs(id, { tail = 500, since = 0, timestamps = true, follow = true, tty = false }, onData, onEnd) {
  const ctrl = new AbortController();
  const qs = new URLSearchParams({
    stdout: '1', stderr: '1', follow: follow ? '1' : '0',
    timestamps: timestamps ? '1' : '0',
    tail: String(tail),
    ...(since ? { since: String(since) } : {}),
  });
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  rawRequest('GET', `/containers/${id}/logs?${qs}`, { signal: ctrl.signal }).then((res) => {
    if (res.statusCode >= 400) {
      readBody(res).then((b) => { onData('stderr', `[docker-inspector] ${b.toString()}\n`); onEnd?.(); });
      return;
    }
    const emit = (stream, buf) => { const s = decoders[stream].write(buf); if (s) onData(stream, s); };
    if (tty) {
      res.on('data', (c) => emit('stdout', c));
    } else {
      const demux = new Demuxer(emit);
      res.on('data', (c) => demux.push(c));
    }
    res.on('end', () => onEnd?.());
    res.on('error', () => onEnd?.());
  }).catch(() => onEnd?.());
  return { close() { ctrl.abort(); } };
}

/**
 * Start an exec instance with a hijacked connection. Resolves with the raw duplex socket.
 */
export function hijackExec(execId, { tty = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: tty }));
    const req = http.request({
      ...ENDPOINT,
      path: `${apiPrefix}/exec/${execId}/start`,
      method: 'POST',
      headers: {
        Host: 'docker',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      },
    });
    req.on('upgrade', (_res, socket, head) => {
      if (head && head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('response', (res) => {
      // Older engines answer 200 and stream without upgrading.
      if (res.statusCode >= 400) {
        readBody(res).then((b) => reject(new DockerError(res.statusCode, b.toString())));
      } else {
        resolve(res.socket);
      }
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export function getApiPrefix() { return apiPrefix; }
