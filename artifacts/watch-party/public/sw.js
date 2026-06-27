// CineSync Service Worker - iOS Background Keep-alive
// يبعت HTTP request كل 25 ثانية عشان:
// 1. يحافظ على الـ SW نفسه من الانتهاء
// 2. يثبت للسيرفر إن المستخدم لسه موجود

let keepAliveTimer = null;
const KEEPALIVE_INTERVAL = 25000;

// [FIX-SW-REFRESH] إزالة skipWaiting() التلقائي — كان بيخلي SW جديد يسيطر فوراً
// على كل التبويبات ويطلق controllerchange event → الصفحة بترفرش وتقطع الاتصال.
// دلوقتي SW بيستنى لحد ما كل التبويبات تتغلق طبيعياً قبل ما يتفعّل،
// إلا لو البرنامج طلب التفعيل الفوري صراحةً عن طريق رسالة SKIP_WAITING.
self.addEventListener('install', () => { /* do not skipWaiting automatically */ });
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
  // تفعيل فوري بس لما البرنامج يطلبه صراحةً (مثلاً بعد تأكيد المستخدم)
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

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
