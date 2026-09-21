export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

export function resolveUrl(url, viaProxy) {
  if (!viaProxy) return url;
  return `/proxy/${encodeURIComponent(url)}`;
}

let nextRequestId = 0;

function redactConsoleValue(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactConsoleValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password)$/i.test(key)
        ? '[REDACTED]' : redactConsoleValue(item, secrets),
    ]));
  }
  return value;
}

function formatBytes(bytes) {
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;
}

function headline(event, requestId, attempt, provider, entry) {
  const id = attempt > 1 ? `#${requestId}.${attempt}` : `#${requestId}`;
  const parts = [id, provider];
  if (event === 'request') parts.push(entry.model ?? 'request', formatBytes(entry.requestBytes));
  else if (event === 'response') parts.push(String(entry.status), `${entry.durationMs} ms`);
  else parts.push(event, entry.message ?? '', `${entry.durationMs} ms`);
  return parts.filter(Boolean).join(' · ');
}

export async function postJson(url, { headers = {}, body, viaProxy = false, signal, retries = 2 } = {}) {
  const requestId = ++nextRequestId;
  const target = new URL(url);
  const provider = { 'api.typesafe.ai': 'TypeSafe', 'api.anthropic.com': 'Anthropic', 'api.openai.com': 'OpenAI', 'api.x.ai': 'xAI' }[target.hostname] ?? target.hostname;
  const secrets = Object.entries(headers)
    .filter(([key]) => /^(authorization|x-api-key)$/i.test(key))
    .map(([, value]) => String(value).replace(/^Bearer\s*/i, '').trim()).filter(Boolean);
  let attempt = 0;
  const log = (event, details) => {
    const entry = redactConsoleValue({ timestamp: new Date().toISOString(), event: `model.${event}`,
      requestId, attempt: attempt + 1, provider, model: body?.model ?? null, ...details }, secrets);
    console.groupCollapsed(headline(event, requestId, attempt + 1, provider, entry));
    console.log(entry);
    console.groupEnd();
  };
  for (;;) {
    const started = performance.now();
    const serializedBody = JSON.stringify(body);
    log('request', { method: 'POST', path: target.pathname, requestBytes: new TextEncoder().encode(serializedBody ?? '').byteLength, body });
    let response;
    let text;
    try {
      response = await fetch(resolveUrl(url, viaProxy), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: serializedBody,
        signal,
      });
      text = await response.text();
    } catch (error) {
      log(error?.name === 'AbortError' ? 'cancelled' : 'error', {
        durationMs: Math.round(performance.now() - started), message: error.message,
      });
      throw error;
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    log('response', { status: response.status, durationMs: Math.round(performance.now() - started), body: json ?? text });
    if (response.ok) return json;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries) {
      attempt++;
      await sleep(500 * 2 ** attempt, signal);
      continue;
    }
    const detail = json?.error?.message ?? json?.message ?? json?.detail ?? text.slice(0, 300);
    throw new ApiError(`HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, {
      status: response.status,
      body: json ?? text,
    });
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
