/**
 * Einstiegspunkt der Oberflaeche.
 *
 * Reihenfolge ist hier nicht beliebig:
 *  1. Adresse des Daemons klaeren (im Tauri-Fenster kommt sie aus der Huelle),
 *  2. Tabs starten -- dabei meldet sich der Lauf-Tab beim Bus an,
 *  3. erst dann verbinden.
 * Andersherum liefen die ersten Nachrichten ins Leere, weil noch niemand
 * horcht.
 */
import * as bus from './bus.js'
import * as tabs from './tabs.js'
import lauf from './tabs/lauf.js'
import server from './tabs/server.js'

tabs.registrieren(lauf)
tabs.registrieren(server)

await bus.basisErmitteln()
tabs.starten(document.getElementById('tableiste'))
bus.verbinden()

// --- Schubladen (nur auf dem Handy sichtbar) --------------------------------
const app = document.getElementById('app')
const schublade = (klasse) => {
  const offen = app.classList.contains(klasse)
  app.classList.remove('schublade-links', 'schublade-rechts')
  if (!offen) app.classList.add(klasse)
}
document.getElementById('aufAgenten').onclick = () => schublade('schublade-links')
document.getElementById('aufFreigaben').onclick = () => schublade('schublade-rechts')
// Ein Tipp auf den Inhalt schliesst wieder -- sonst muesste man den Knopf
// treffen, und die Schublade verdeckt vier Fuenftel des Schirms.
document.querySelector('main').addEventListener('pointerdown', () => {
  app.classList.remove('schublade-links', 'schublade-rechts')
})

// --- PWA --------------------------------------------------------------------
// Nur ueber https: im Tauri-Fenster und auf http gibt es keinen Service
// Worker, und der Registrierungsfehler waere bloss Rauschen in der Konsole.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => {
    console.warn('Service Worker nicht registriert', e)
  })
}
