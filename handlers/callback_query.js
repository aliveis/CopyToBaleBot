// handlers/callback_query — inline button presses on Telegram.
import { onCallback } from '../lib/callbacks.js';
import { logError } from '../lib/store.js';

export default async function (query) {
  try {
    await onCallback('tg', query);
  } catch (e) {
    await logError('tg:callback_query', e);
  }
}
