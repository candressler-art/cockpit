/**
 * Kleine DOM-Helfer fuer alle Bereiche.
 *
 * `h()` baut Elemente ohne innerHTML: Text aus Sitzungen, Dateinamen oder
 * Befehlen ist nicht vertrauenswuerdig, und mit textContent kann er nichts
 * anrichten. innerHTML gibt es nur noch an EINER Stelle -- im Markdown-Modul,
 * hinter DOMPurify.
 */
import * as bus from '../bus.js'

export function h(tag, attrs = {}, ...kinder) {
  const [name, ...klassen] = tag.split('.')
  const el = document.createElement(name || 'div')
  if (klassen.length) el.className = klassen.join(' ')
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v
    else if (k === 'style' && typeof v === 'object') {
      // CSS-Variablen ('--rolle') gehen nur ueber setProperty -- Object.assign
      // legte sie als toten JS-Wert ab, und var(--rolle) blieb leer.
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv)
        else el.style[sk] = sv
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k in el && typeof v !== 'string') el[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  anhaengen(el, kinder)
  return el
}

function anhaengen(el, kinder) {
  for (const k of kinder.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue
    el.append(k instanceof Node ? k : document.createTextNode(String(k)))
  }
}

export function leeren(el, ...kinder) {
  el.replaceChildren()
  anhaengen(el, kinder)
  return el
}

// --- Symbole ----------------------------------------------------------------
// Strichzeichnungen im Stil von Lucide, 24er Raster. Als Pfaddaten statt
// Bilddateien: sie erben die Textfarbe und kosten keine Anfrage.
const PFADE = {
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  plus: 'M12 5v14M5 12h14',
  aufgaben: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  nutzung: 'M3 3v18h18M7 16v-4M12 16V8M17 16v-7',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  notizen: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  einstellungen: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  menue: 'M3 6h18M3 12h18M3 18h18',
  suche: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  senden: 'M12 19V5M5 12l7-7 7 7',
  stopp: 'M7 7h10v10H7z',
  ordner: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  kopieren: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  haken: 'M20 6L9 17l-5-5',
  kreuz: 'M18 6L6 18M6 6l12 12',
  pfeil: 'M9 18l6-6-6-6',
  zurueck: 'M15 18l-6-6 6-6',
  mikro: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  werkzeug: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  datei: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  stift: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  welt: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  denken: 'M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2zM9 21h6',
  schild: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  frage: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  person: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  stern: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  nadel: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z',
  mehr: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  aktualisieren: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
}

export function symbol(name, groesse = 16) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', groesse)
  svg.setAttribute('height', groesse)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('sym')
  const p = document.createElementNS(ns, 'path')
  p.setAttribute('d', PFADE[name] ?? PFADE.info)
  svg.append(p)
  return svg
}

// --- Daten ------------------------------------------------------------------

/** fetch gegen den Daemon; wirft mit der Fehlermeldung des Servers. */
export async function api(pfad, optionen = {}) {
  const init = { ...optionen }
  if (optionen.body !== undefined && typeof optionen.body !== 'string') {
    init.body = JSON.stringify(optionen.body)
    init.headers = { 'content-type': 'application/json', ...(optionen.headers ?? {}) }
    init.method ??= 'POST'
  }
  const r = await fetch(bus.api(pfad), init)
  let d = null
  try { d = await r.json() } catch { /* leere Antwort */ }
  if (!r.ok) {
    const e = new Error(d?.fehler ?? `HTTP ${r.status}`)
    e.status = r.status
    e.daten = d
    throw e
  }
  return d
}

/** Lesbarer Fehlertext: "Daemon nicht erreichbar" statt "Failed to fetch". */
export const fehlerText = (e) => bus.ladefehlerText(e) === String(e) ? (e?.message ?? String(e)) : bus.ladefehlerText(e)

// --- Formatierung -----------------------------------------------------------

const zahlFmt = new Intl.NumberFormat('de-DE')
export const zahl = (n) => zahlFmt.format(Math.round(n ?? 0))

/** 1234567 -> "1,2 Mio." -- Tokenmengen will niemand ziffernweise lesen. */
export function kurzZahl(n) {
  n = n ?? 0
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mrd.`
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.`
  if (n >= 1e4) return `${Math.round(n / 1e3).toLocaleString('de-DE')} Tsd.`
  return zahl(n)
}

export function uhrzeit(ts) {
  return ts ? new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''
}

/** "vor 5 Min.", "gestern 14:03", "12. Sep." */
export function wann(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const jetzt = new Date()
  const s = (jetzt - d) / 1000
  if (s < 60) return 'gerade eben'
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`
  const tagDiff = tagIndex(jetzt) - tagIndex(d)
  if (tagDiff === 0) return uhrzeit(ts)
  if (tagDiff === 1) return `gestern ${uhrzeit(ts)}`
  if (tagDiff < 7) return d.toLocaleDateString('de-DE', { weekday: 'long' })
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: d.getFullYear() === jetzt.getFullYear() ? undefined : 'numeric' })
}

/** Kalendertag als fortlaufende Zahl (Ortszeit) -- fuer "heute/gestern". */
export function tagIndex(d) {
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000)
}

/** Pfad kuerzen: /home/claude/projekte/x -> ~/projekte/x */
export function pfadKurz(p) {
  if (!p) return ''
  return p.replace(/^\/home\/[^/]+/, '~').replace(/^\/root/, '~')
}

export const modellName = (id) => {
  if (!id) return ''
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`
}

/** Kleine Meldung unten, verschwindet von selbst. */
export function melden(text, art = 'info') {
  let box = document.getElementById('meldungen')
  if (!box) {
    box = h('div', { id: 'meldungen', role: 'status', 'aria-live': 'polite' })
    document.body.append(box)
  }
  const el = h(`div.meldung.${art}`, {}, text)
  box.append(el)
  setTimeout(() => { el.classList.add('weg'); setTimeout(() => el.remove(), 300) }, art === 'fehler' ? 6000 : 3000)
}
