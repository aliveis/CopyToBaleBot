// lib/telegram — Telegram Bot API client. `api.<method>(params)` resolves to
// the unwrapped result and throws BotApiError, like the tgcloud sdk `api` it
// replaces; `api.getFileContent(fileId)` downloads a file's bytes.
import { TG_API, TG_FILE } from './config.js';
import { BotApiError, callApi, download } from './botapi.js';

export { BotApiError, InputFile } from './botapi.js';

// opt.signal aborts the call (used by the long-poll loop on shutdown).
export function tg(method, params, opt) {
  return callApi(TG_API, method, params, BotApiError, opt);
}

async function getFileContent(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  return download(TG_FILE + f.file_path, BotApiError);
}

const extra = { getFileContent };

export const api = new Proxy(extra, {
  get(target, name) {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return Object.hasOwn(target, name) ? target[name] : (params) => tg(name, params);
  },
});
