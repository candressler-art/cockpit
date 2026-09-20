/**
 * Tab "Server" -- Auslastung beider Maschinen.
 *
 * Die Zahlen kommen fertig vom Daemon (/api/system, danach live per
 * 'system'-Nachricht). Hier wird nur gezeichnet. Gemessen wird nichts im
 * Browser -- ein Handy im Tailnet kaeme an /proc ohnehin nicht heran.
 */
import { api, abonnieren } from '../bus.js'

let wurzel = null
let letzter = null
let vorn = false

const pz = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} %`)

function dauer(sek) {
  if (!sek && sek !== 0) return '—'
  const t = Math.floor(sek / 86400)
  const h = Math.floor((sek % 86400) / 3600)
  const m = Math.floor((sek % 3600) / 60)
  if (t > 0) return `${t} d ${h} h`
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

/** Farbe nach Schwere, nicht nach Geschmack: gruen bis 60, gelb bis 85, rot darueber. */
function stufe(v) {
  if (v === null || v === undefined) return 'unbekannt'
  if (v >= 85) return 'heiss'
  if (v >= 60) return 'warm'
  return 'kuehl'
}

function ring(beschriftung, wert, zusatz) {
  const p = wert === null || wert === undefined ? 0 : Math.max(0, Math.min(100, wert))
  // 2*pi*r bei r=26 -- als Konstante ausgeschrieben, damit der Strichmuster-
  // Wert unten ohne Rechnung im Kopf lesbar bleibt.
  const umfang = 163.36
  return `<div class="messung ${stufe(wert)}">
    <svg viewBox="0 0 64 64" class="ring">
      <circle cx="32" cy="32" r="26" class="bahn"/>
      <circle cx="32" cy="32" r="26" class="fuellung"
        stroke-dasharray="${(umfang * p) / 100} ${umfang}"/>
    </svg>
    <div class="wert">${pz(wert)}</div>
    <div class="was">${beschriftung}</div>
    <div class="zusatz">${zusatz ?? ''}</div>
  </div>`
}

function karte(h) {
  const temp = h.tempC === null || h.tempC === undefined ? '—' : `${h.tempC.toFixed(1)} °C`
  const ramGb = h.ramGesamtMb ? ` von ${(h.ramGesamtMb / 1024).toFixed(1)} GB` : ''
  const plGb = h.plattenGesamtGb ? ` von ${h.plattenGesamtGb} GB` : ''
  return `<article class="hostkarte">
    <header class="hostkopf">
      <span class="ampel ${h.status === 'ok' ? 'an' : 'ab'}"></span>
      <h3>${h.name}</h3>
      <span class="quelle" title="Woher die Zahlen stammen">${h.quelle}</span>
      <div class="spacer"></div>
      <span class="pill">läuft ${dauer(h.uptimeSek)}</span>
      <span class="pill ${stufe(h.tempC !== null && h.tempC !== undefined ? h.tempC : null)}">${temp}</span>
      ${h.container !== null && h.container !== undefined ? `<span class="pill">${h.container} Container</span>` : ''}
    </header>
    <div class="messungen">
      ${ring('CPU', h.cpuProzent, '')}
      ${ring('Speicher', h.ramProzent, ramGb)}
      ${ring('Platte', h.plattenProzent, plGb)}
    </div>
  </article>`
}

function zeichnen() {
  if (!wurzel || !vorn) return
  if (!letzter) {
    wurzel.innerHTML = '<div class="leer">Werte werden geholt…</div>'
    return
  }
  const hinweis = letzter.beszelEingerichtet
    ? ''
    : `<div class="hinweis">Nur der eigene Host wird gemessen. Für den zweiten Server
       fehlt die Beszel-Anmeldung: <code>BESZEL_URL</code>, <code>BESZEL_USER</code> und
       <code>BESZEL_PASS</code> in <code>/etc/cockpit/umgebung</code> eintragen.</div>`
  wurzel.innerHTML = hinweis + `<div class="hostliste">${letzter.hosts.map(karte).join('')}</div>`
}

export default {
  id: 'server',
  titel: 'Server',
  symbol: '▦',

  mount(el) {
    wurzel = el
    el.innerHTML = '<div class="leer">Werte werden geholt…</div>'
    // Live-Strom: der Daemon schickt alle 20 s von selbst.
    abonnieren('system', (d) => { letzter = d; zeichnen() })
    // Und einmal sofort holen, damit der Tab nicht 20 s leer bleibt.
    fetch(api('/api/system'))
      .then((r) => r.json())
      .then((d) => { letzter = d; zeichnen() })
      .catch((e) => {
        el.innerHTML = `<div class="leer">Auslastung nicht abrufbar: ${String(e)}</div>`
      })
  },

  sichtbar(an) {
    vorn = an
    if (an) zeichnen()
  },
}
