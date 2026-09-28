// lib/botapi — minimal Bot API client shared by Telegram and Bale, which speak
// the same protocol. Calls resolve to the unwrapped `result` and throw the
// caller's error class (with code / description / parameters) on failure.
import { LIMITS } from './config.js';

export class InputFile {
  constructor(data, filename = 'file', { type } = {}) {
    this.data = data;
    this.filename = filename;
    this.type = type || 'application/octet-stream';
  }
}

export class BotApiError extends Error {
  constructor(method, code, description, parameters) {
    super(`${method}: ${code} ${description}`);
    this.name = 'BotApiError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters || {};
  }
}

const tooBig = () => Object.assign(new Error('file too large'), { tooBig: true });

function hasFile(v) {
  if (v instanceof InputFile) return true;
  if (Array.isArray(v)) return v.some(hasFile);
  if (v && typeof v === 'object') return Object.values(v).some(hasFile);
  return false;
}

function clean(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

// Multipart body. Nested files (sendMediaGroup) are lifted to attach://fN parts.
function multipart(params) {
  const form = new FormData();
  const attach = (name, f) => form.append(name, new Blob([f.data], { type: f.type }), f.filename);
  let n = 0;
  const lift = (v) => {
    if (v instanceof InputFile) {
      const name = 'f' + n++;
      attach(name, v);
      return 'attach://' + name;
    }
    if (Array.isArray(v)) return v.map(lift);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null) o[k] = lift(x);
      return o;
    }
    return v;
  };
  for (const [k, v] of Object.entries(params)) {
    if (v instanceof InputFile) attach(k, v);
    else if (typeof v === 'object') form.append(k, JSON.stringify(lift(v)));
    else form.append(k, String(v));
  }
  return form;
}

// A request that never got a usable response (DNS, refused, reset, timeout...).
function netError(ApiError, method, e) {
  const why = e?.name === 'TimeoutError' ? 'timed out' : e?.cause?.code || e?.cause?.message || e?.message || 'unknown';
  return new ApiError(method, 0, 'network error: ' + why);
}

// opt.signal aborts the call early (shutdown); every call also has its own timeout.
export async function callApi(base, method, params = {}, ApiError = BotApiError, opt = {}) {
  params = clean(params);
  const withFile = hasFile(params);
  const timeoutMs = method === 'getUpdates' ? ((params.timeout || 0) + 15) * 1000 : withFile ? 300e3 : 120e3;
  const signal = opt.signal
    ? AbortSignal.any([opt.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const init = withFile
    ? { method: 'POST', body: multipart(params), signal }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal };
  let res;
  let data;
  try {
    res = await fetch(base + method, init);
  } catch (e) {
    throw netError(ApiError, method, e);
  }
  try {
    data = await res.json();
  } catch (e) {
    throw e instanceof SyntaxError ? new ApiError(method, res.status, 'invalid response') : netError(ApiError, method, e);
  }
  if (!data || !data.ok) {
    throw new ApiError(method, data?.error_code ?? res.status, data?.description ?? 'unknown error', data?.parameters);
  }
  return data.result;
}

export async function readAll(body, max = LIMITS.download) {
  const chunks = [];
  let len = 0;
  if (body) {
    for await (const c of body) {
      chunks.push(c);
      len += c.length;
      if (len > max) throw tooBig();
    }
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// GET a file into memory, refusing anything larger than `max`.
export async function download(url, ApiError = BotApiError, max = LIMITS.download) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(300e3) });
  } catch (e) {
    throw netError(ApiError, 'download', e);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new ApiError('download', res.status, 'file download failed');
  }
  if (Number(res.headers.get('content-length')) > max) {
    res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  try {
    return await readAll(res.body, max);
  } catch (e) {
    throw e.tooBig ? e : netError(ApiError, 'download', e);
  }
}
