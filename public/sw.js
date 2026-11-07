// Shows the control plane's push notifications and opens the approval when one is tapped.
// Notifications only point at the page; deciding happens there, signed in.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'Nexus Control Plane', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(p.title || 'Nexus Control Plane', {
    body: p.body || '',
    tag: p.tag || undefined,
    renotify: !!p.tag,
    requireInteraction: true,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: p.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});
