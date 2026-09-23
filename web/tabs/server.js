/**
 * Tab "Server" -- Auslastung beider Maschinen, und darueber die Konten.
 *
 * Die Zahlen kommen fertig vom Daemon (/api/system, danach live per
 * 'system'-Nachricht). Hier wird nur gezeichnet. Gemessen wird nichts im
 * Browser -- ein Handy im Tailnet kaeme an /proc ohnehin nicht heran.
 *
 * Die Konten (/api/konten) haben keinen Live-Kanal -- anders als der
 * Systemstand gibt es dafuer kein WebSocket-Ereignis, ein Kontowechsel ist
 * selten genug, dass ein Poll alle paar Sekunden reicht, waehrend der Tab
 * offen ist.
 */
import { api, abonnieren } from '../bus.js'

let wurzel = null
let letzter = null
let letzteKonten = []
let letzterModus = 'ausgeglichen'
let letztesNaechstesKonto = null
let letzterAbstandPunkte = null
let vorn = false
let kontenIntervall = null

// Die Hostnamen kommen aus dem Beszel-Hub, also aus fremder Konfiguration.
// Sie landen per innerHTML in der Seite -- ohne Maskierung waere das eine
// Einladung, und der Aufwand dagegen ist eine Zeile.
const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

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
  // Die Karte traegt den schlimmsten ihrer drei Werte -- so sieht man am
  // Rahmen, ob etwas klemmt, ohne die Ringe einzeln zu lesen.
  const schlimmst = Math.max(h.cpuProzent ?? 0, h.ramProzent ?? 0, h.plattenProzent ?? 0)
  const kartenzustand = h.status !== 'ok' ? '' : schlimmst >= 85 ? 'heiss' : schlimmst >= 60 ? 'warm' : 'ok'
  return `<article class="hostkarte ${kartenzustand}">
    <header class="hostkopf">
      <span class="ampel ${h.status === 'ok' ? 'an' : 'ab'}"></span>
      <h3>${esc(h.name)}</h3>
      <span class="quelle" title="Woher die Zahlen stammen">${esc(h.quelle)}</span>
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

/** Kurztext, wann eine Sperre endet -- oder leer, wenn das Konto frei ist. */
function resetText(gesperrtBis) {
  if (!gesperrtBis) return ''
  const d = new Date(gesperrtBis)
  const heute = d.toDateString() === new Date().toDateString()
  const zeit = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  return heute ? `gesperrt bis ${zeit}` : `gesperrt bis ${d.toLocaleDateString('de-DE')} ${zeit}`
}

/** Kurztext, wann und woher der Nutzungswert eines Kontos stammt. */
function nutzungHerkunft(k) {
  if (!k.gemessenAm) return 'noch nie gemessen'
  const zeit = new Date(k.gemessenAm).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  const quelle = k.quelle === 'usage_api' ? 'API-Abfrage' : k.quelle === 'rate_limit_event' ? 'aus einem Lauf' : ''
  return `gemessen ${zeit}${quelle ? ` · ${quelle}` : ''}`
}

function kontoKarte(k) {
  const gesperrt = Boolean(k.gesperrtBis)
  // Dieselbe Kartensprache wie die Hosts (.hostkarte, Eckklammern aus
  // hud.css) -- nicht angemeldet zaehlt wie ein toter Host, gesperrt wie ein
  // heisser.
  const kartenzustand = !k.angemeldet ? '' : gesperrt ? 'heiss' : 'ok'
  const naechstes = k.angemeldet && !gesperrt && k.name === letztesNaechstesKonto
  return `<article class="hostkarte kontokarte ${kartenzustand}" data-konto="${esc(k.name)}">
    <header class="hostkopf">
      <span class="ampel ${k.angemeldet ? 'an' : 'ab'}"></span>
      <h3>${esc(k.name)}</h3>
      ${k.abo ? `<span class="quelle" title="Abo">${esc(k.abo)}</span>` : ''}
      <div class="spacer"></div>
      ${k.bevorzugt ? '<span class="pill an" title="manuell gesetzt">manuell</span>' : ''}
      ${naechstes ? '<span class="pill an" title="kaeme als naechstes dran">als naechstes</span>' : ''}
      ${!k.angemeldet
        ? '<span class="pill ab">nicht angemeldet</span>'
        : gesperrt
          ? `<span class="pill heiss">${esc(resetText(k.gesperrtBis))}</span>`
          : '<span class="pill an">frei</span>'}
    </header>
    <div class="kontozeile">
      <span class="kontoemail" title="${esc(k.email ?? '')}">${esc(k.email ?? '—')}</span>
      <button class="still knopf-vorzug" data-konto="${esc(k.name)}" ${k.angemeldet ? '' : 'disabled'}>
        ${k.bevorzugt ? 'Vorzug aufheben' : 'Bevorzugen'}
      </button>
    </div>
    ${k.angemeldet ? `<div class="messungen kontomessungen">
      ${ring('Woche', k.siebenTageAnteil === null ? null : k.siebenTageAnteil * 100, '')}
      ${ring('5 Std.', k.fuenfStundenAnteil === null ? null : k.fuenfStundenAnteil * 100, '')}
    </div>
    <div class="kontonutzung">${esc(nutzungHerkunft(k))}</div>` : ''}
  </article>`
}

async function vorzugSetzen(name, aufheben) {
  try {
    await fetch(api('/api/konten'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: aufheben ? null : name }),
    })
  } catch {
    // Naechster Poll zeigt den wahren Stand -- kein Absturz wegen einer
    // Anzeige, die sich gleich sowieso wieder korrigiert.
  }
  await kontenLaden()
}

function kontenKopfZeichnen() {
  const el = wurzel?.querySelector('#kontokopf')
  if (!el) return
  const modusText = letzterModus === 'manuell' ? 'manuell gesteuert' : 'ausgeglichen (Balancing)'
  const abstandText = letzterAbstandPunkte === null
    ? ''
    : ` · Abstand ${letzterAbstandPunkte.toFixed(0)} Punkte`
  const naechstesText = letztesNaechstesKonto ? ` · als naechstes: ${letztesNaechstesKonto}` : ''
  el.textContent = `Modus: ${modusText}${abstandText}${naechstesText}`
}

function kontenZeichnen() {
  const el = wurzel?.querySelector('#kontoliste')
  if (!el) return
  kontenKopfZeichnen()
  if (letzteKonten.length === 0) {
    el.innerHTML = '<div class="leer">keine Konten gefunden</div>'
    return
  }
  el.innerHTML = letzteKonten.map(kontoKarte).join('')
  for (const btn of el.querySelectorAll('.knopf-vorzug')) {
    btn.onclick = () => {
      const name = btn.dataset.konto
      const k = letzteKonten.find((x) => x.name === name)
      void vorzugSetzen(name, Boolean(k?.bevorzugt))
    }
  }
}

async function kontenLaden() {
  try {
    const r = await fetch(api('/api/konten')).then((x) => x.json())
    letzteKonten = r.konten ?? []
    letzterModus = r.modus ?? 'ausgeglichen'
    letztesNaechstesKonto = r.naechstesKonto ?? null
    letzterAbstandPunkte = typeof r.abstandPunkte === 'number' ? r.abstandPunkte : null
  } catch {
    // Ohne Antwort bleibt die letzte bekannte Liste stehen statt einer
    // Fehlerwand -- die Serverkarten darunter sind das Wichtigere auf diesem Tab.
  }
  kontenZeichnen()
}

function zeichnen() {
  if (!wurzel || !vorn) return
  if (!letzter) {
    wurzel.querySelector('#hostliste').innerHTML = '<div class="leer">Werte werden geholt…</div>'
    return
  }
  const hinweis = letzter.beszelEingerichtet
    ? ''
    : `<div class="hinweis">Nur der eigene Host wird gemessen. Für den zweiten Server
       fehlt die Beszel-Anmeldung: <code>BESZEL_URL</code>, <code>BESZEL_USER</code> und
       <code>BESZEL_PASS</code> in <code>/etc/cockpit/umgebung</code> eintragen.</div>`
  wurzel.querySelector('#hostliste').innerHTML =
    hinweis + `<div class="hostliste">${letzter.hosts.map(karte).join('')}</div>`
}

export default {
  id: 'server',
  titel: 'Server',
  symbol: '▦',

  mount(el) {
    wurzel = el
    el.innerHTML = `
      <h2>Konten</h2>
      <div id="kontokopf" class="kontokopf"></div>
      <div id="kontoliste" class="kontoliste"><div class="leer">Konten werden geholt…</div></div>
      <h2>Auslastung</h2>
      <div id="hostliste"><div class="leer">Werte werden geholt…</div></div>`
    // Live-Strom: der Daemon schickt alle 20 s von selbst.
    abonnieren('system', (d) => { letzter = d; zeichnen() })
    // Und einmal sofort holen, damit der Tab nicht 20 s leer bleibt.
    fetch(api('/api/system'))
      .then((r) => r.json())
      .then((d) => { letzter = d; zeichnen() })
      .catch((e) => {
        wurzel.querySelector('#hostliste').innerHTML =
          `<div class="leer">Auslastung nicht abrufbar: ${String(e)}</div>`
      })

    void kontenLaden()
    // Kein Live-Kanal fuer Konten -- gepollt, aber nur solange der Tab offen
    // war (siehe sichtbar()), damit ein Hintergrundtab nicht mitzaehlt.
    if (kontenIntervall) clearInterval(kontenIntervall)
    kontenIntervall = setInterval(() => { if (vorn) void kontenLaden() }, 15_000)
  },

  sichtbar(an) {
    vorn = an
    if (an) {
      zeichnen()
      void kontenLaden()
    }
  },
}
