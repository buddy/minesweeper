import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  loadEnvFile(path.join(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const port = Number(process.env.PORT ?? 8787);

const allowedHosts = new Set([
  'api.typesafe.ai',
  'api.anthropic.com',
  'api.openai.com',
  'api.x.ai',
  ...(process.env.PROXY_ALLOW_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
]);

const forwardedHeaders = ['content-type', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'];

const envKeys = {
  'api.typesafe.ai': { variable: 'TYPESAFE_API_KEY', header: 'authorization', value: process.env.TYPESAFE_API_KEY ? `Bearer ${process.env.TYPESAFE_API_KEY}` : null },
  'api.anthropic.com': { variable: 'ANTHROPIC_API_KEY', header: 'x-api-key', value: process.env.ANTHROPIC_API_KEY ?? null },
  'api.openai.com': { variable: 'OPENAI_API_KEY', header: 'authorization', value: process.env.OPENAI_API_KEY ? `Bearer ${process.env.OPENAI_API_KEY}` : null },
  'api.x.ai': { variable: 'XAI_API_KEY', header: 'authorization', value: process.env.XAI_API_KEY ? `Bearer ${process.env.XAI_API_KEY}` : null },
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

let nextRequestId = 0;

function parseLogBody(value) {
  if (!value) return null;
  const text = String(value);
  try { return JSON.parse(text); } catch { return text; }
}

const LOG_AS_JSON = process.env.LOG_FORMAT === 'json' || !process.stdout.isTTY;
const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const BADGE_COLOURS = [24, 29, 53, 58, 60, 88, 94, 97];

function badgeFor(label) {
  let hash = 2166136261;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return BADGE_COLOURS[((hash >>> 0) >>> 8) % BADGE_COLOURS.length];
}

function size(value) {
  if (value === undefined) return null;
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;
}

const LOG_BODY_LINES = Number(process.env.LOG_BODY_LINES ?? 16);

function compactJson(value, pad = '') {
  const inline = JSON.stringify(value);
  if (inline === undefined) return 'null';
  if (inline.length <= 72 || typeof value !== 'object' || value === null) return inline;
  const inner = `${pad}  `;
  const parts = Array.isArray(value)
    ? value.map(item => inner + compactJson(item, inner))
    : Object.entries(value).map(([key, item]) => `${inner}${JSON.stringify(key)}: ${compactJson(item, inner)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${parts.join(',\n')}\n${pad}${close}`;
}

function bodyBlock(value) {
  if (value === undefined || value === null || !(LOG_BODY_LINES > 0)) return '';
  const lines = compactJson(value).split('\n');
  const shown = lines.slice(0, LOG_BODY_LINES).map(line => `${DIM}  ${line}${RESET}`);
  const hidden = lines.length - shown.length;
  if (hidden > 0) shown.push(`${DIM}  \u2026 ${hidden} more lines \u00b7 LOG_FORMAT=json for everything${RESET}`);
  return `\n${shown.join('\n')}`;
}

function duration(ms) {
  return ms === undefined ? null : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function prettyLog(entry) {
  const label = [entry.provider, entry.model].filter(Boolean).join(' ');
  const badge = `\u001b[48;5;${badgeFor(label)}m\u001b[97m ${label} ${RESET}`;
  const usage = entry.body?.usage;
  const arrow = { 'model.request': '\u2192', 'model.response': '\u2190' }[entry.event] ?? '\u2715';
  const parts = entry.event === 'model.request'
    ? [entry.method, entry.path, size(entry.body)]
    : entry.event === 'model.response'
      ? [String(entry.status), duration(entry.durationMs),
        usage && `${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`]
      : [entry.message ?? entry.event, duration(entry.durationMs)];
  return `${DIM}${entry.timestamp.slice(11, 19)}${RESET} ${badge} ${DIM}#${entry.requestId}${RESET}`
    + ` ${arrow} ${parts.filter(Boolean).join(` ${DIM}\u00b7${RESET} `)}${bodyBlock(entry.body)}`;
}

function redactLog(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactLog(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password)$/i.test(key)
        ? '[REDACTED]' : redactLog(item, secrets),
    ]));
  }
  return value;
}

async function handleProxy(req, res, encodedTarget) {
  let target;
  try {
    target = new URL(decodeURIComponent(encodedTarget));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid proxy target URL' } });
  }
  if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) {
    return sendJson(res, 403, {
      error: { message: `Host ${target.hostname} is not allowed. Set PROXY_ALLOW_HOSTS=host1,host2 to allow it.` },
    });
  }

  const started = performance.now();
  const requestId = ++nextRequestId;
  const provider = { 'api.typesafe.ai': 'TypeSafe', 'api.anthropic.com': 'Anthropic', 'api.openai.com': 'OpenAI', 'api.x.ai': 'xAI' }[target.hostname] ?? target.hostname;
  const headers = {};
  for (const name of forwardedHeaders) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const secrets = [...Object.values(envKeys).map(key => key.value), headers.authorization, headers['x-api-key']]
    .filter(Boolean).map(value => String(value).replace(/^Bearer\s*/i, '').trim()).filter(Boolean);
  let model = null;
  const log = (event, details) => {
    const entry = redactLog({ timestamp: new Date().toISOString(), event, requestId, provider, model, ...details }, secrets);
    console.log(LOG_AS_JSON ? JSON.stringify(entry) : prettyLog(entry));
  };
  const logResponse = (status, body) => log('model.response', { status, durationMs: Math.round(performance.now() - started), body });

  let body;
  try {
    body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  } catch {
    log('model.error', { status: 400, durationMs: Math.round(performance.now() - started), message: 'Request body could not be read' });
    return sendJson(res, 400, { error: { message: 'Request body could not be read' } });
  }
  const requestBody = parseLogBody(body);
  model = typeof requestBody?.model === 'string' ? requestBody.model : null;
  log('model.request', { method: req.method, path: target.pathname, body: requestBody });

  const fallback = envKeys[target.hostname];
  const hasCredential = Boolean(headers.authorization?.replace(/^Bearer\s*/i, '').trim() || headers['x-api-key']);
  if (!hasCredential && fallback && !fallback.value) {
    const payload = { error: { message: `Add ${fallback.variable} to .env and restart the server.` } };
    logResponse(401, payload);
    return sendJson(res, 401, payload);
  }
  if (!hasCredential && fallback?.value) {
    delete headers.authorization;
    delete headers['x-api-key'];
    headers[fallback.header] = fallback.value;
  }

  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    const text = await upstream.text();
    logResponse(upstream.status, parseLogBody(text));
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch (error) {
    const payload = { error: { message: `Upstream request failed: ${error.message}` } };
    logResponse(502, payload);
    sendJson(res, 502, payload);
  }
}

function isPublicFile(relative) {
  const parts = relative.split(path.sep);
  if (parts.some(part => part.startsWith('.'))) return false;
  return relative === 'index.html' || relative === 'styles.css'
    || (parts[0] === 'js' && path.extname(relative) === '.js')
    || (parts[0] === 'assets' && ['.svg', '.png', '.ico'].includes(path.extname(relative)));
}

async function handleStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end('Invalid path');
  }
  const filePath = path.resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
  if (!isPublicFile(path.relative(root, filePath))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const realPath = await fs.realpath(filePath);
    const realRoot = await fs.realpath(root);
    if (!isPublicFile(path.relative(realRoot, realPath))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const data = await fs.readFile(realPath);
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(realPath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/proxy/')) {
        return await handleProxy(req, res, url.pathname.slice('/proxy/'.length));
      }
      return await handleStatic(req, res, url.pathname);
    } catch {
      sendJson(res, 500, { error: { message: 'Server request failed' } });
    }
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`Minesweeper: http://127.0.0.1:${server.address().port}`);
  });
