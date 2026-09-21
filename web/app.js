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
import * as stimme from './stimme.js'
import lauf from './tabs/lauf.js'
import server from './tabs/server.js'
import chats from './tabs/chats.js'
import vault from './tabs/vault.js'
import konsole from './tabs/konsole.js'

tabs.registrieren(lauf)
tabs.registrieren(chats)
tabs.registrieren(vault)
tabs.registrieren(konsole)
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

// --- Sprachausgabe ----------------------------------------------------------
const stimmwahl = document.getElementById('stimmwahl')
stimmwahl.value = stimme.stufeLaden()
stimmwahl.onchange = async () => {
  stimme.stufeSetzen(stimmwahl.value)
  // Die Auswahl ist selbst der Klick, den der Browser fuer die Tonfreigabe
  // verlangt -- deshalb hier und nirgends sonst freigeben.
  if (stimmwahl.value !== 'aus') await stimme.freigeben()
}

// Gesprochen wird, was eine Entscheidung verlangt oder einen Lauf abschliesst.
// Nicht jeder Zwischenstand: eine Stimme, die dauernd redet, schaltet man ab.
bus.abonnieren('lauf_ende', (d) => {
  const grund = d?.ende?.grund ?? 'beendet'
  const text = grund === 'entscheidung'
    ? `Der Orchestrator braucht eine Entscheidung. ${d?.ende?.frage ?? ''}`
    : `Der Lauf ist beendet. Grund: ${grund}.`
  stimme.sagen(text, { wichtig: true })
})

bus.abonnieren('freigabe', (d) => {
  if (d?.decidedAt || d?.decided_at) return
  stimme.sagen(`Eine Freigabe wartet: ${d?.toolName ?? d?.tool_name ?? 'ein Werkzeug'}.`,
    { wichtig: true })
})

bus.abonnieren('ereignis', (e) => {
  if (e?.kind === 'rate_limit') stimme.sagen(`Achtung, Limit: ${e.summary}`, { wichtig: true })
  else if (e?.kind === 'error') stimme.sagen(`Fehler bei ${e.agentId}: ${e.summary}`)
  else if (e?.kind === 'protocol') stimme.sagen(e.summary)
})

// Beim Verlassen der Seite abbauen -- sonst bleibt die Renderschleife des
// Vault-Tabs an einem verwaisten Kontext haengen, wenn der Browser die Seite
// im Zwischenspeicher haelt.
addEventListener('pagehide', () => tabs.alleAbbauen())

// --- PWA --------------------------------------------------------------------
// Nur ueber https: im Tauri-Fenster und auf http gibt es keinen Service
// Worker, und der Registrierungsfehler waere bloss Rauschen in der Konsole.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => {
    console.warn('Service Worker nicht registriert', e)
  })
}
