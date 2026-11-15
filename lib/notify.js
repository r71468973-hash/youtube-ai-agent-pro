'use strict';
/**
 * Notifications about publishing. Every notification is kept in the dashboard list (last 100).
 * If the optional NOTIFY_WEBHOOK_URL is set (Settings, encrypted), it is also sent as a JSON message
 * to that address, which works with free chat webhooks (Discord, Slack-style incoming webhooks, etc.).
 * The webhook address is a secret: it is never logged or returned to the browser.
 */
const store = require('./store');
const vault = require('./vault');
const { scrub, newId } = require('./util');

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/** Saves a notification for the dashboard. Returns the saved item. */
function record(kind, title, message, videoId = null) {
  const item = { id: newId(6), at: new Date().toISOString(), kind: clip(kind, 30), title: clip(title, 140), message: clip(message, 400), videoId: videoId ? clip(videoId, 40) : null };
  store.addNotification(item);
  console.log(`[notify] ${item.kind}: ${item.title}`);
  return item;
}

/** Sends the notification to the webhook, if one is set. Failures are logged without the address. */
async function sendWebhook(item) {
  const url = vault.get('NOTIFY_WEBHOOK_URL');
  if (!url) return false;
  const text = `${item.title}\n${item.message}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.log(`[notify] webhook answered HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    const msg = String(e.message || '').split(url).join('[webhook address]'); // the address is a secret: never printed
    console.log(`[notify] webhook not sent: ${scrub(msg).slice(0, 160)}`);
    return false;
  }
}

/** Records the notification and sends it to the webhook in the background. */
function notify(kind, title, message, videoId) {
  const item = record(kind, title, message, videoId);
  sendWebhook(item).catch(() => {});
  return item;
}

module.exports = { notify, record, sendWebhook };
