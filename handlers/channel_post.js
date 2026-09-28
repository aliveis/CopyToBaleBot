// handlers/channel_post — new posts in Telegram channels where the bot is admin.
import { onChannelPost } from '../lib/channel.js';
import { logError } from '../lib/store.js';

export default async function (post) {
  try {
    await onChannelPost('tg', post);
  } catch (e) {
    await logError('tg:channel_post', e);
  }
}
