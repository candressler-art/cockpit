/**
 * Einstiegspunkt der Oberflaeche: Seitenleiste, Router, Verbindung.
 *
 * Aufbau wie Claude Desktop: links die Seitenleiste (Neuer Chat, Bereiche,
 * Chatliste), rechts genau EIN Bereich. Auf dem Handy wird die Seitenleiste
 * zur Schublade. Jeder Inhalt lebt in genau einem Bereich -- keine
 * Doppelungen (UMBAU-PLAN.md, Zielbild).
 *
 * Geroutet wird ueber den URL-Hash (#/chat/<id>, #/nutzung, ...): so geht
 * der Zurueck-Knopf des Handys, und jeder Chat laesst sich verlinken.
 *
 * Reihenfolge beim Start: erst die Daemon-Adresse klaeren (Tauri-Huelle),
 * dann die Bereiche bauen (sie melden sich beim Bus an), dann verbinden --
 * sonst laufen die ersten Nachrichten ins Leere.
 */
import * as bus from './bus.js'
import * as stimme from './stimme.js'
import * as benachrichtigen from './benachrichtigen.js'
import { h, symbol, api, leeren } from './ui/dom.js'
import { chatBereich } from './ui/chat.js'
import { chatListeBauen } from './ui/chatliste.js'
import { einstellungenBauen } from './ui/einstellungen.js'
import { nutzungBauen } from './ui/nutzung.js'
import { aufgabenBauen } from './ui/aufgaben.js'
import { serverBauen } from './ui/server.js'
import { notizenBauen } from './ui/notizen.js'
import { terminalBauen } from './ui/terminal.js'
import { wallpaperSetzen } from './wallpaper.js'
import { variante } from './variante.js'

// Wallpaper zuerst: es liegt hinter den durchsichtigen Kacheln.
wallpaperSetzen()
addEventListener('akzent-geaendert', (e) => wallpaperSetzen(e.detail))

await bus.basisErmitteln()
// Die Stimmstufe ist je Geraet (localStorage) -- vor der ersten Meldung lesen.
stimme.stufeLaden()

// Variante (src/variante.ts): welche Bereiche es in DIESEM Cockpit gibt und
// wie es heisst. Antwortet ein aelterer Daemon nicht darauf, ist es das
// Haupt-Cockpit mit allem.
Object.assign(variante, await api('/api/variante').catch(() => ({})))
if (variante.id !== 'haupt') {
  // Fuer die Fenstertitel in chat.js und benachrichtigen.js.
  document.documentElement.dataset.appName = variante.name
  document.title = variante.name
  document.querySelector('.marke-logo span').textContent = variante.name.toLowerCase()
  document.querySelector('.marke-logo').setAttribute('aria-label', `${variante.name} – neuer Chat`)
  document.getElementById('handyTitel').textContent = variante.name
}

// --- Bereiche -----------------------------------------------------------------
// bauen() erst beim ersten Anzeigen: ein Bereich, den niemand oeffnet, kostet
// nichts. zeigen(param)/verbergen() bei jedem Wechsel -- wer pollt, muss im
// Hintergrund anhalten (Akku am Handy).
const BEREICHE = [
  { id: 'aufgaben', titel: 'Aufgaben', symbol: 'aufgaben', bauen: aufgabenBauen },
  { id: 'nutzung', titel: 'Nutzung', symbol: 'nutzung', bauen: nutzungBauen },
  { id: 'server', titel: 'Server', symbol: 'server', bauen: serverBauen },
  { id: 'notizen', titel: 'Notizen', symbol: 'notizen', bauen: notizenBauen },
  { id: 'terminal', titel: 'Terminal', symbol: 'terminal', bauen: terminalBauen },
  { id: 'einstellungen', titel: 'Einstellungen', symbol: 'einstellungen', bauen: einstellungenBauen },
].filter((b) => !variante.bereicheAus?.includes(b.id))
const bereichNach = new Map(BEREICHE.map((b) => [b.id, b]))
const gebaut = new Map()

const app = document.getElementById('app')
const flaechen = document.getElementById('flaechen')

// Der Chat ist immer da -- er ist die Startseite und haelt seinen Zustand.
const chatliste = chatListeBauen({ beiWahl: () => schubladeZu() })
document.getElementById('chatlisteOrt').replaceWith(chatliste.el)
const handyTitel = document.getElementById('handyTitel')
const chat = chatBereich({
  // Am Handy ersetzt die obere Leiste den Chat-Kopf -- dort steht der Titel.
  beiTitel: (t) => { if (aktuell?.art === 'chat') handyTitel.textContent = t },
  beiNeuemChat: (id, titel) => {
    // Adresse nachziehen, ohne den Chat neu zu laden: der Zug laeuft schon.
    history.replaceState(null, '', `#/chat/${encodeURIComponent(id)}`)
    aktuell = { art: 'chat', id }
    letzterChat = id
    // Sofort in die Liste, nicht erst, wenn der Server die Sitzung eingelesen hat.
    chatliste.vorlaeufigZeigen(id, titel)
    chatliste.aktivSetzen(id)
  },
})
chat.el.classList.add('flaeche')
flaechen.append(chat.el)

// --- Seitenleiste ---------------------------------------------------------------
const mac = /Mac|iPhone|iPad/.test(navigator.platform)
document.getElementById('neuerChat').append(symbol('plus', 16), h('span', {}, 'Neuer Chat'),
  h('kbd', { 'aria-hidden': 'true' }, mac ? '⌘⇧O' : 'Strg ⇧ O'))
document.getElementById('handyNeu').append(symbol('plus', 20))
document.getElementById('seiteAuf').append(symbol('menue', 20))
document.getElementById('seiteZu').append(symbol('kreuz', 18))
// Workspaces wie in der Waybar: 1 Chat, 2 Aufgaben ... 7 Einstellungen (Strg+Zahl).
// Der Chat-Workspace fuehrt zurueck in den zuletzt offenen Chat.
const WORKSPACES = [{ id: 'chat', titel: 'Chat', symbol: 'chat' }, ...BEREICHE]
const nav = document.getElementById('bereiche')
WORKSPACES.forEach((b, i) => {
  nav.append(h('a.ws-knopf', { href: `#/${b.id}`, dataset: { bereich: b.id }, title: `${b.titel} (Strg+${i + 1})`, 'aria-label': b.titel },
    h('span.ws-nr', {}, String(i + 1)), symbol(b.symbol, 15), h('span.ws-name', {}, b.titel.toLowerCase())))
})
const chatWs = nav.querySelector('[data-bereich="chat"]')
let letzterChat = null

const seiteAuf = document.getElementById('seiteAuf')
function schubladeZu() {
  app.classList.remove('schublade')
  seiteAuf.setAttribute('aria-expanded', 'false')
}
seiteAuf.addEventListener('click', () => {
  app.classList.add('schublade')
  seiteAuf.setAttribute('aria-expanded', 'true')
})
document.getElementById('seiteZu').addEventListener('click', schubladeZu)
document.getElementById('schleier').addEventListener('click', schubladeZu)

// --- Router ---------------------------------------------------------------------
let aktuell = null

function ziel() {
  const teile = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (teile[0] === 'chat' || teile.length === 0) return { art: 'chat', id: teile[1] ? decodeURIComponent(teile[1]) : null }
  if (bereichNach.has(teile[0])) return { art: teile[0], param: teile.slice(1).map(decodeURIComponent) }
  return { art: 'chat', id: null }
}

function wechseln() {
  const z = ziel()
  const vorher = aktuell
  aktuell = z
  schubladeZu()

  if (vorher && vorher.art !== 'chat' && vorher.art !== z.art) {
    try { gebaut.get(vorher.art)?.verbergen?.() } catch (e) { console.warn('Bereich warf beim Verbergen', e) }
  }
  for (const el of flaechen.children) el.classList.remove('an')

  if (z.art === 'chat') {
    chat.el.classList.add('an')
    chat.zeigen(z.id)
    chatliste.aktivSetzen(z.id)
  } else {
    const b = bereichNach.get(z.art)
    let inst = gebaut.get(z.art)
    if (!inst) {
      try {
        inst = b.bauen()
      } catch (e) {
        console.error(`Bereich '${b.id}' konnte nicht gebaut werden`, e)
        inst = { el: h('section.bereich', {}, h('div.fehlerbox', {}, `Dieser Bereich konnte nicht geladen werden: ${e}`)) }
      }
      inst.el.classList.add('flaeche')
      flaechen.append(inst.el)
      gebaut.set(z.art, inst)
    }
    inst.el.classList.add('an')
    try { inst.zeigen?.(z.param) } catch (e) { console.warn('Bereich warf beim Zeigen', e) }
    chatliste.aktivSetzen(null)
    handyTitel.textContent = b.titel
    document.title = `${b.titel} – ${variante.name}`
  }
  for (const a of nav.querySelectorAll('a')) {
    const an = a.dataset.bereich === z.art
    a.classList.toggle('an', an)
    if (an) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  }
  // Die Chatliste gehoert zum Chat-Workspace; die anderen nutzen die ganze Breite.
  app.classList.toggle('ws-chat', z.art === 'chat')
  if (z.art === 'chat' && z.id) letzterChat = z.id
  chatWs.href = letzterChat && !(z.art === 'chat' && !z.id) ? `#/chat/${encodeURIComponent(letzterChat)}` : '#/chat'
  document.getElementById('neuerChat').classList.toggle('an', z.art === 'chat' && !z.id)
}
addEventListener('hashchange', wechseln)

// --- Tastenkuerzel ---------------------------------------------------------------
addEventListener('keydown', (ev) => {
  const mod = ev.ctrlKey || ev.metaKey
  // Strg+K: Chats durchsuchen; Strg+Shift+O: neuer Chat (wie Claude Desktop).
  if (mod && ev.key.toLowerCase() === 'k') { ev.preventDefault(); app.classList.add('schublade'); chatliste.sucheFokus() }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'o') { ev.preventDefault(); location.hash = '#/chat' }
  // Strg+1..7: Workspace wechseln. Bewusst nicht Alt -- auf dem Mac tippt Alt+5..9 Klammern.
  else if (ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && /^[1-7]$/.test(ev.key)) {
    ev.preventDefault()
    location.hash = nav.children[Number(ev.key) - 1].getAttribute('href')
  }
})

// --- Fuss: Verbindung und Limit ----------------------------------------------------
// Nur EIN kleiner Hinweis auf das naechste Konto; die Zahlen im Detail stehen
// im Bereich Nutzung (keine zweite Anzeige derselben Werte).
// Module rechts in der Waybar: wer wartet (chatliste.js fuellt es), Verbindung, Limit.
const module = document.getElementById('module')
const dranModul = h('a.modul.dran-modul', { id: 'dranModul', hidden: true })
const verbindung = h('span.modul.verbindung', { title: 'Verbindung zum Daemon' }, h('span.punkt'), h('span', {}, 'verbindet …'))
const limitEl = h('a.modul.limit-hinweis', { href: '#/nutzung', title: 'Zur Nutzung' })
module.append(dranModul, verbindung, limitEl)
bus.beiZustand((z) => {
  verbindung.classList.toggle('an', z === 'verbunden')
  verbindung.lastChild.textContent = z === 'verbunden' ? 'online' : 'getrennt'
  app.classList.toggle('getrennt', z !== 'verbunden')
  if (z === 'verbunden') limitLaden()
})

// Uhr in der Mitte der Waybar.
const uhr = document.getElementById('uhr')
const uhrStellen = () => {
  const d = new Date()
  uhr.textContent = `${d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')} ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}  ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
}
uhrStellen()
setInterval(uhrStellen, 15_000)

async function limitLaden() {
  try {
    const d = await api('/api/konten')
    const k = d.konten.find((x) => x.name === d.naechstesKonto && x.angemeldet) ?? d.konten.find((x) => x.angemeldet)
    if (!k) { leeren(limitEl); return }
    const teile = [h('span', {}, k.name)]
    const gesperrt = k.gesperrtBis && k.gesperrtBis > Date.now()
    // Gesperrt ist wichtiger als der Balken -- beides passt nicht in die Leiste.
    if (gesperrt) teile.push(h('span.warnung', {}, k.sperrGrund === 'anmeldung' ? 'Anmeldung prüfen' : 'im Limit'))
    else if (typeof k.fuenfStundenAnteil === 'number') {
      const p = Math.round(k.fuenfStundenAnteil * 100) // Anteil 0..1 (konten.ts)
      teile.push(h(`span.limit-balken${p >= 90 ? '.hoch' : p >= 70 ? '.mittel' : ''}`, { title: `5-Stunden-Fenster: ${p} %` },
        h('span', { style: { width: `${Math.min(100, p)}%` } })), h('span.leise', {}, `${p} %`))
    }
    leeren(limitEl, teile)
  } catch {
    leeren(limitEl)
  }
}
setInterval(() => { if (document.visibilityState === 'visible') limitLaden() }, 60_000)
bus.abonnieren('limit', () => limitLaden())
addEventListener('konten-geaendert', () => limitLaden())

// --- Stimme ------------------------------------------------------------------------
// Gesprochen wird nur, was eine Entscheidung verlangt -- eine Stimme, die
// dauernd redet, schaltet man ab. Die Stufe waehlt man in den Einstellungen.
bus.abonnieren('freigabe', (d) => {
  if (d?.decidedAt || d?.decided_at) return
  stimme.sagen(`Eine Freigabe wartet: ${d?.toolName ?? d?.tool_name ?? 'ein Werkzeug'}.`, { wichtig: true })
})
bus.abonnieren('lauf_ende', (d) => {
  const grund = d?.ende?.grund ?? 'beendet'
  stimme.sagen(grund === 'entscheidung'
    ? `Der Orchestrator braucht eine Entscheidung. ${d?.ende?.frage ?? ''}`
    : `Der Auftrag ist beendet. Grund: ${grund}.`, { wichtig: true })
})

// --- Benachrichtigungen --------------------------------------------------------------
// Nur wenn man nicht hinsieht; was gemeldet wird, steht in ui/meldungen.js.
for (const typ of ['agent', 'freigabe', 'lauf_ende']) {
  bus.abonnieren(typ, (d) => benachrichtigen.pruefen(typ, d, { titelVon: chatliste.titelVon }))
}

wechseln()
bus.verbinden()

// --- PWA -------------------------------------------------------------------------
// Der Worker dient allein der Installierbarkeit auf dem Handy. In eingebetteten
// Ansichten (Tauri-Huelle, Browser-Fenster der Desktop-App) scheitert die
// Registrierung bei jedem Laden und schreibt einen Fehler in die Konsole --
// deshalb dort gar nicht erst versuchen ('Claude/' = Fenster der Desktop-App).
const eingebettet = /Electron|Tauri|Claude\/|wv\)/i.test(navigator.userAgent)
if ('serviceWorker' in navigator && location.protocol === 'https:' && !eingebettet) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
