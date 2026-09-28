// handlers/message — private chats with the bot on Telegram.
import { onDM } from '../lib/dm.js';
import { logError } from '../lib/store.js';

export default async function (message) {
  try {
    if (message.chat?.type === 'private') await onDM('tg', message);
  } catch (e) {
    await logError('tg:message', e);
  }
}
