/**
 * Bereich Server: Auslastung beider Maschinen mit dem Verlauf der letzten
 * Stunde.
 *
 * Die Zahlen kommen fertig vom Daemon (/api/system, danach live per
 * 'system'-Nachricht alle 20 s). Gemessen wird nichts im Browser -- ein
 * Handy im Tailnet kaeme an /proc ohnehin nicht heran. Die Konten stehen
 * nicht mehr hier, sondern in der Nutzung (keine Doppelung).
 */
import { h, symbol, api, leeren, uhrzeit, fehlerText, melden } from './dom.js'
import * as bus from '../bus.js'

const STUNDE = 60 * 60 * 1000

/** Farbe nach Schwere, wie die Limitbalken der Nutzung: ab 60 gelb, ab 85 rot. */
export const schwere = (v) => (v === null || v === undefined ? '' : v >= 85 ? 'hoch' : v >= 60 ? 'mittel' : '')
const prozent = (v) => (v === null || v === undefined ? '–' : `${Math.round(v)} %`)

export function laufzeit(sek) {
  if (sek === null || sek === undefined) return null
  const t = Math.floor(sek / 86400)
  const std = Math.floor((sek % 86400) / 3600)
  const min = Math.floor((sek % 3600) / 60)
  if (t > 0) return `${t} ${t === 1 ? 'Tag' : 'Tage'} ${std} Std.`
  if (std > 0) return `${std} Std. ${min} Min.`
  return `${min} Min.`
}

export function serverBauen() {
  const inhalt = h('div.bereich-inhalt.server')
  const el = h('section.bereich', {}, h('header.bereich-kopf', {}, h('h1', {}, 'Server')), inhalt)

  let stand = null
  let verlauf = {}
  let sichtbar = false

  async function laden() {
    if (!stand) leeren(inhalt, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    try {
      const d = await api('/api/system')
      verlauf = d.verlauf ?? {}
      stand = d
      zeichnen()
    } catch (e) {
      if (!stand) {
        leeren(inhalt, h('div.fehlerbox', {}, h('strong', {}, 'Auslastung nicht geladen'), h('span', {}, fehlerText(e)),
          h('button.knopf', { type: 'button', onclick: laden }, 'Erneut versuchen')))
      } else melden(`Auslastung nicht aktualisiert: ${fehlerText(e)}`, 'fehler')
    }
  }

  // Live-Strom: der Verlauf wird hier weitergefuehrt, wie es der Daemon auch
  // tut -- so bleibt die Kurve ohne erneutes Laden aktuell.
  bus.abonnieren('system', (d) => {
    if (!stand) return
    stand = d
    for (const host of d.hosts) {
      if (host.status !== 'ok') continue
      const punkte = (verlauf[host.name] ??= [])
      punkte.push({ t: d.gemessenAm, cpu: host.cpuProzent, ram: host.ramProzent })
      while (punkte.length && punkte[0].t < d.gemessenAm - STUNDE) punkte.shift()
    }
    if (sichtbar) zeichnen()
  })

  function zeichnen() {
    const hosts = stand.hosts ?? []
    leeren(inhalt,
      !stand.beszelEingerichtet && h('div.hinweis', {}, symbol('info', 16), h('span', {},
        'Nur dieser Server wird gemessen. Für den zweiten fehlt die Beszel-Anmeldung: ',
        h('code', {}, 'BESZEL_URL'), ', ', h('code', {}, 'BESZEL_USER'), ' und ', h('code', {}, 'BESZEL_PASS'),
        ' in ', h('code', {}, '/etc/cockpit/umgebung'), ' eintragen.')),
      hosts.length
        ? h('div.hosts', {}, hosts.map((host) => hostKarte(host, verlauf[host.name] ?? [])))
        : h('div.leer-zustand', {}, 'Noch keine Messwerte.'),
      stand.gemessenAm && h('p.gemessen', {}, `Gemessen um ${uhrzeit(stand.gemessenAm)} · aktualisiert sich alle 20 Sekunden`))
  }

  return {
    el,
    zeigen() { sichtbar = true; laden() },
    verbergen() { sichtbar = false },
  }
}

function hostKarte(host, punkte) {
  const ok = host.status === 'ok'
  const ramGb = host.ramGesamtMb ? `von ${(host.ramGesamtMb / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB` : null
  const platteGb = host.plattenGesamtGb ? `von ${host.plattenGesamtGb} GB` : null
  const merkmale = [
    ok && laufzeit(host.uptimeSek) && `läuft seit ${laufzeit(host.uptimeSek)}`,
    ok && host.tempC !== null && host.tempC !== undefined && `${host.tempC.toLocaleString('de-DE', { maximumFractionDigits: 0 })} °C`,
    ok && host.container !== null && host.container !== undefined && `${host.container} Container`,
    host.quelle === 'lokal' ? 'dieser Server' : 'über Beszel',
  ].filter(Boolean)
  return h('section.n-karte.host', { dataset: { host: host.name } },
    h('div.n-karte-kopf', {},
      h(`span.punkt${ok ? '.an' : ''}`, { title: ok ? 'erreichbar' : 'keine Messwerte' }),
      h('h2', {}, host.name),
      h('span.leise', {}, merkmale.join(' · '))),
    ok
      ? [
          h('div.host-werte', {},
            messwert('CPU', host.cpuProzent),
            messwert('Speicher', host.ramProzent, ramGb),
            messwert('Platte', host.plattenProzent, platteGb)),
          kurve(punkte),
        ]
      : h('p.leise.klein', {}, 'Keine aktuellen Messwerte – der Agent auf diesem Server meldet sich nicht.'))
}

function messwert(name, wert, zusatz) {
  const p = wert === null || wert === undefined ? 0 : Math.max(0, Math.min(100, wert))
  return h('div.fenster', {},
    h('span.fenster-name', {}, name),
    h(`span.fenster-balken${schwere(wert) ? `.${schwere(wert)}` : ''}`, { role: 'meter', 'aria-label': name, 'aria-valuenow': Math.round(p), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { style: { width: `${p}%` } })),
    h('span.fenster-zahl', {}, prozent(wert)),
    h('span.fenster-reset', {}, zusatz ?? ''))
}

/**
 * CPU und Speicher der letzten Stunde als zwei Linien. Feste X-Achse ueber
 * die volle Stunde: nach einem Neustart des Daemons ist die Kurve kurz und
 * rechtsbuendig -- man sieht, dass es erst ab da Werte gibt.
 */
export function kurvenPfad(punkte, feld, ende, breite = 600, hoehe = 60) {
  let d = ''
  let offen = false
  for (const p of punkte) {
    const v = p[feld]
    if (v === null || v === undefined) { offen = false; continue }
    const x = Math.max(0, breite - ((ende - p.t) / STUNDE) * breite)
    const y = hoehe - (Math.max(0, Math.min(100, v)) / 100) * hoehe
    d += `${offen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
    offen = true
  }
  return d
}

function kurve(punkte) {
  // Unter drei Minuten waere die Kurve nur ein Krümel am rechten Rand, der wie ein Fehler aussieht.
  if (punkte.length < 2 || punkte.at(-1).t - punkte[0].t < 3 * 60 * 1000) {
    return h('p.kurve-leer.leise.klein', {}, 'Der Verlauf der letzten Stunde erscheint nach ein paar Minuten Messung.')
  }
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 600 60')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'kurve')
  svg.setAttribute('role', 'img')
  const ende = punkte.at(-1).t
  const spitze = Math.max(...punkte.map((p) => p.cpu ?? 0))
  svg.setAttribute('aria-label', `CPU in der letzten Stunde, höchstens ${Math.round(spitze)} %`)
  for (const [feld, klasse] of [['ram', 'linie-ram'], ['cpu', 'linie-cpu']]) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', kurvenPfad(punkte, feld, ende))
    p.setAttribute('class', klasse)
    p.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(p)
  }
  return h('div.kurve-ort', {},
    svg,
    h('div.kurve-legende', {},
      h('span.leg-cpu', {}, 'CPU'), h('span.leg-ram', {}, 'Speicher'),
      h('span.spacer'),
      h('span', {}, `letzte Stunde · Spitze ${Math.round(spitze)} %`)))
}
