/**
 * Benachrichtigungen des Systems (Handy/PWA und Browser am PC).
 *
 * Nur, wenn man gerade NICHT hinsieht (Tab verborgen oder Fenster ohne
 * Fokus): wer das Cockpit vor sich hat, sieht Karte und Seitenleiste ohnehin.
 * Was gemeldet wird, entscheidet ui/meldungen.js.
 *
 * Je Geraet (localStorage) wie die Stimme -- am PC will man vielleicht keine,
 * am Handy schon. Vorgabe aus: der Browser verlangt ohnehin eine Erlaubnis,
 * und die darf man nur auf einen Klick hin erfragen.
 *
 * Am Handy (Android-Chrome) gibt es `new Notification()` nicht, dort geht es
 * nur ueber den Service Worker; der ist nur bei https registriert (app.js).
 * Deshalb zuerst der Worker, sonst der Konstruktor.
 */
import { meldungFuer } from './ui/meldungen.js'
import { api } from './bus.js'

const SCHLUESSEL = 'cockpit.melden'
const TITEL = document.title
let an = false
let ungesehen = 0

try { an = localStorage.getItem(SCHLUESSEL) === 'an' } catch { /* privater Modus */ }

export const moeglich = () => 'Notification' in window
/** 'an' | 'aus' | 'blockiert' | 'unmoeglich' */
export function zustand() {
  if (!moeglich()) return 'unmoeglich'
  if (Notification.permission === 'denied') return 'blockiert'
  return an && Notification.permission === 'granted' ? 'an' : 'aus'
}

/** Muss aus einem Klick heraus kommen -- sonst lehnt der Browser die Frage ab. */
export async function setzen(neu) {
  if (neu && moeglich() && Notification.permission !== 'granted') {
    try { await Notification.requestPermission() } catch { /* alter Safari: Rueckruf-Form, egal */ }
  }
  an = neu && moeglich() && Notification.permission === 'granted'
  try { localStorage.setItem(SCHLUESSEL, an ? 'an' : 'aus') } catch { /* privater Modus */ }
  await pushAbgleichen()
  return zustand()
}

const wegGesehen = () => document.visibilityState === 'hidden' || !document.hasFocus()

/**
 * Ereignis vom Bus pruefen und ggf. melden. Die Zahl im Fenstertitel gibt es
 * auch ohne Erlaubnis -- sie zeigt im Tab am PC, dass etwas wartet.
 */
export function pruefen(typ, daten, hilfe) {
  if (!wegGesehen()) return
  const m = meldungFuer(typ, daten, hilfe)
  if (!m) return
  ungesehen++
  document.title = `(${ungesehen}) ${TITEL}`
  if (zustand() === 'an') void zeigen(m)
}

async function zeigen(m) {
  const optionen = { body: m.text, tag: m.tag, data: { ziel: m.ziel }, icon: './symbol.svg', renotify: true }
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) { await reg.showNotification(m.titel, optionen); return }
  } catch { /* weiter mit dem Konstruktor */ }
  try {
    const n = new Notification(m.titel, optionen)
    n.onclick = () => { window.focus(); location.hash = m.ziel; n.close() }
  } catch { /* Handy ohne Worker: dort gibt es keinen anderen Weg */ }
}

function gesehen() {
  if (wegGesehen()) return
  ungesehen = 0
  document.title = TITEL
}
document.addEventListener('visibilitychange', gesehen)
addEventListener('focus', gesehen)

// Klick auf eine Meldung des Workers: der fokussiert das Fenster und sagt,
// wohin (sw.js).
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.typ === 'gehe' && typeof e.data.ziel === 'string' && e.data.ziel.startsWith('#/')) location.hash = e.data.ziel
})

// --- Push (Meldungen auch bei geschlossener Seite) --------------------------
//
// Nur mit Service Worker (https, siehe app.js). Am iPhone/iPad geht Push nur,
// wenn das Cockpit als App auf dem Home-Bildschirm liegt (iOS 16.4+).

/** 'an' | 'aus' | 'unmoeglich' -- fuer die Anzeige in den Einstellungen. */
export async function pushZustand() {
  const reg = await navigator.serviceWorker?.getRegistration()
  if (!reg?.pushManager) return 'unmoeglich'
  return (await reg.pushManager.getSubscription()) ? 'an' : 'aus'
}

function schluesselBytes(b64) {
  const roh = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(roh, (c) => c.charCodeAt(0))
}

/**
 * Abo an den Schalter angleichen: an -> abonnieren und dem Daemon melden
 * (bei jedem Laden erneut, falls der Daemon es verloren hat), aus -> kuendigen.
 */
export async function pushAbgleichen() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (!reg?.pushManager) return
    let abo = await reg.pushManager.getSubscription()
    if (zustand() !== 'an') {
      if (abo) {
        await fetch(api('/api/push/ab'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: abo.endpoint }) })
        await abo.unsubscribe()
      }
      return
    }
    const { schluessel } = await (await fetch(api('/api/push'))).json()
    if (!schluessel) return
    abo ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: schluesselBytes(schluessel) })
    await fetch(api('/api/push'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ abo: abo.toJSON() }) })
  } catch (e) {
    console.warn('Push nicht eingerichtet:', e)
  }
}

/** Testmeldung an alle Geraete mit Abo. */
export async function pushTesten() {
  const r = await fetch(api('/api/push/test'), { method: 'POST' })
  return (await r.json()).abos ?? 0
}

// Beim Laden abgleichen -- der Worker ist evtl. erst kurz nach dem Start registriert.
setTimeout(() => void pushAbgleichen(), 3000)
