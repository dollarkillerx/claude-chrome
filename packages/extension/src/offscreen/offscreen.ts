// Lives independently of the service worker. Pinging it every few seconds restarts a terminated
// worker right away (runtime messages wake it), instead of waiting up to 30s for the next alarm.
const PING_MS = 5_000;

setInterval(() => {
  chrome.runtime.sendMessage({ type: "keepalive" }).catch(() => {});
}, PING_MS);
