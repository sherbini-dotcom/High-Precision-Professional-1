// CineSync Service Worker - iOS Background Keep-alive
// يبعت HTTP request كل 25 ثانية عشان:
// 1. يحافظ على الـ SW نفسه من الانتهاء
// 2. يثبت للسيرفر إن المستخدم لسه موجود

let keepAliveTimer = null;
const KEEPALIVE_INTERVAL = 25000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
  if (event.data?.type === 'START_KEEPALIVE') {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(async () => {
      try {
        await fetch('/api/healthz', { method: 'GET', cache: 'no-store' });
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        clients.forEach(c => c.postMessage({ type: 'SW_ALIVE' }));
      } catch { /* تجاهل أخطاء الشبكة */ }
    }, KEEPALIVE_INTERVAL);
  }

  if (event.data?.type === 'STOP_KEEPALIVE') {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  }
});

// لما الـ SW يصحى من sleep بسبب push أو fetch — يبعت ping فوراً
self.addEventListener('fetch', event => {
  // مش بنمنع أي request — بس بنستغل الـ event عشان SW يصحى
});
