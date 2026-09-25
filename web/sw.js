/**
 * Service Worker -- bewusst minimal.
 *
 * Er ist nur da, damit das Cockpit auf dem Handy als App installierbar ist;
 * ohne registrierten Worker bietet der Browser kein "Zum Startbildschirm
 * hinzufuegen" an, sondern nur ein Lesezeichen.
 *
 * Gecacht wird NICHTS. Das ist Absicht und passt zu 'cache-control: no-store'
 * im Daemon: die Oberflaeche aendert sich staendig, und ein Browser, der altes
 * JavaScript ausliefert, sieht aus wie ein Fehler im Code. Die Dateien kommen
 * ohnehin ueber das Tailnet oder von localhost -- der Gewinn waere gering, der
 * Verwirrungsschaden gross.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// Klick auf eine Benachrichtigung (benachrichtigen.js): ein offenes Cockpit nach vorn
// holen und dorthin schicken, sonst eines oeffnen. Das ist keine Caching-
// Logik -- der Worker bleibt dabei so duenn wie oben beschrieben.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const ziel = String(e.notification.data?.ziel ?? '')
  e.waitUntil((async () => {
    const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (fenster[0]) {
      await fenster[0].focus()
      fenster[0].postMessage({ typ: 'gehe', ziel })
      return
    }
    await self.clients.openWindow(new URL(ziel, self.registration.scope).href)
  })())
})
