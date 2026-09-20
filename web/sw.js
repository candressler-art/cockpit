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
