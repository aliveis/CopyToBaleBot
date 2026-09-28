// lib/bale — Bale Bot API client. Mirrors lib/telegram: resolves to the
// unwrapped `result`, throws BaleError on failure.
import { BALE_API, BALE_FILE } from './config.js';
import { callApi, download } from './botapi.js';

export class BaleError extends Error {
  constructor(method, code, description, parameters) {
    super(`Bale ${method}: ${code} ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters || {};
  }
}

// opt.signal aborts the call (used by the pump on shutdown).
export function bale(method, params = {}, opt) {
  return callApi(BALE_API, method, params, BaleError, opt);
}

export const baleFileUrl = (path) => BALE_FILE + path;

export async function baleDownloadPath(path) {
  return download(baleFileUrl(path), BaleError);
}

export async function baleDownload(fileId) {
  const f = await bale('getFile', { file_id: fileId });
  return baleDownloadPath(f.file_path);
}
