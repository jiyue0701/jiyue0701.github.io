const CACHE_NAME = 'coach-training-shell-v4'
const CACHEABLE_DESTINATIONS = new Set(['document', 'script', 'style', 'font'])

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  )
  self.clients.claim()
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url)
  const hasRange = event.request.headers.has('range')
  const isLargeActionMedia = requestUrl.pathname.startsWith('/media/actions/')
  if (
    event.request.method !== 'GET'
    || requestUrl.origin !== self.location.origin
    || hasRange
    || isLargeActionMedia
    || !CACHEABLE_DESTINATIONS.has(event.request.destination)
  ) return

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        const response = await fetch(event.request)
        if (response.ok && response.status === 200) {
          await cache.put(event.request, response.clone()).catch(() => undefined)
        }
        return response
      } catch {
        const cached = await cache.match(event.request)
        if (cached) return cached
        if (event.request.mode === 'navigate') {
          const shell = await cache.match('/')
          if (shell) return shell
        }
        return Response.error()
      }
    }),
  )
})
