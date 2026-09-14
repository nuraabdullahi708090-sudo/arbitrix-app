/*
 * Arbitrix AI service worker.
 *
 * Minimal, conservative offline support for the app shell only:
 *   - Same-origin GET *navigation* requests are network-first, so an online
 *     visitor always receives the freshest page.
 *   - The most recent successful navigation response is kept as an offline
 *     fallback for the app shell.
 *   - API calls (/api/*) and every non-navigation request (assets, POST/PUT/
 *     DELETE, cross-origin) are left completely untouched, so live financial
 *     data is never served from cache.
 *
 * Nothing is precached at install time, so a failed/offline install can never
 * break registration. This file must be served as JavaScript; it lives in
 * public/ and is returned by express.static (never the HTML catch-all).
 */

const SHELL_CACHE = 'arbitrix-shell-v1';
const SHELL_URL = new URL('./index.html', self.location.href).href;

self.addEventListener('install', () => {
    // Activate the new worker immediately instead of waiting for old tabs.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        try {
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
        } catch (e) {}
        try { await self.clients.claim(); } catch (e) {}
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    // Only same-origin GET navigations are handled. Everything else falls
    // through to the network exactly as it would without a service worker.
    if (request.method !== 'GET' || request.mode !== 'navigate') return;

    let url;
    try { url = new URL(request.url); } catch (e) { return; }
    if (url.origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            const response = await fetch(request);
            // Refresh the offline shell from a clean, complete response only.
            if (response && response.ok && response.status === 200 && response.type === 'basic') {
                const copy = response.clone();
                caches.open(SHELL_CACHE)
                    .then((cache) => cache.put(SHELL_URL, copy))
                    .catch(() => {});
            }
            return response;
        } catch (e) {
            try {
                const cached = await caches.match(SHELL_URL);
                if (cached) return cached;
            } catch (e2) {}
            return new Response(
                '<!DOCTYPE html><meta charset="utf-8"><title>Offline</title>' +
                '<body style="font-family:system-ui;background:#070B14;color:#fff;text-align:center;padding:48px">' +
                '<h1>You are offline</h1><p>Please reconnect to continue.</p></body>',
                { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
        }
    })());
});
