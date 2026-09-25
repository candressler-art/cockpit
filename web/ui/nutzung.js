/**
 * Bereich Nutzung: Aktivitaetsraster ueber ein Jahr (alle Konten zusammen),
 * Kennzahlen, Rueckblick je Tag, Konten mit Limits und Guthaben.
 *
 * "Tokens" heisst hier Eingabe + Ausgabe + Cache-Schreiben -- Cache-Lesen
 * waere ueber 90 % der Summe und macht aus einem ruhigen Tag mit langer
 * Sitzung einen scheinbar vollen (src/nutzung.ts). Es steht separat im
 * Tagesdetail.
 *
 * Die Konten stehen nur hier: Limits, Reset, Prognose, Guthaben und der
 * Vorzug gehoeren zusammen -- man waehlt ein Konto nach dem, was es noch hat.
 */
import { h, symbol, api, leeren, kurzZahl, zahl, uhrzeit, modellName, melden, fehlerText } from './dom.js'
import * as bus from '../bus.js'

const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

// --- Kalendertage als 'JJJJ-MM-TT' (Berliner Tag kommt vom Server) ---------------
// Gerechnet wird ueber UTC-Mittag, damit Sommerzeit keinen Tag verschluckt.
const alsDatum = (tag) => new Date(`${tag}T12:00:00Z`)
const tagPlus = (tag, n) => { const d = alsDatum(tag); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
/** 0 = Montag ... 6 = Sonntag */
const wochentag = (tag) => (alsDatum(tag).getUTCDay() + 6) % 7
const tagLang = (tag) => alsDatum(tag).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const tagKurz = (tag) => alsDatum(tag).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Stufengrenzen nach Quartilen der aktiven Tage -- ein einzelner Rekordtag soll nicht alle anderen dunkel machen. */
export function stufenGrenzen(werte) {
  const s = werte.filter((w) => w > 0).sort((a, b) => a - b)
  if (!s.length) return [Infinity, Infinity, Infinity]
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return [q(0.25), q(0.5), q(0.75)]
}
export function stufe(wert, grenzen) {
  if (!wert) return 0
  if (wert >= grenzen[2]) return 4
  if (wert >= grenzen[1]) return 3
  if (wert >= grenzen[0]) return 2
  return 1
}

/** Reset-Zeit lesbar: heute nur die Uhrzeit, sonst mit Wochentag. */
function resetText(ms) {
  if (!ms) return null
  const d = new Date(ms)
  const jetzt = new Date()
  if (d.toDateString() === jetzt.toDateString()) return `um ${uhrzeit(ms)}`
  if (ms - jetzt < 7 * 86400000) return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${uhrzeit(ms)}`
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
}

function dauerText(ms) {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min < 60) return `${min} Min.`
  const std = Math.round(min / 60)
  if (std < 48) return `${std} Std.`
  return `${Math.round(std / 24)} Tagen`
}

const geld = (betrag, waehrung) => betrag === null || betrag === undefined ? '?' :
  betrag.toLocaleString('de-DE', { style: 'currency', currency: waehrung || 'USD' })

export function nutzungBauen() {
  const inhalt = h('div.bereich-inhalt.nutzung')
  const aktualisieren = h('button.knopf-klein.nur-desktop', { type: 'button', title: 'Neu laden', 'aria-label': 'Neu laden', onclick: () => laden() }, symbol('aktualisieren', 16))
  const el = h('section.bereich', {}, h('header.bereich-kopf.mit-status', {}, h('h1', {}, 'Nutzung'), h('span.spacer'), aktualisieren), inhalt)

  const kontenOrt = h('div.konten-ort')
  const tagOrt = h('div.tag-detail')
  let bericht = null
  let gewaehlt = null
  let sichtbar = false
  let uhr = null

  async function laden() {
    if (!bericht) leeren(inhalt, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    aktualisieren.disabled = true
    try {
      const [b] = await Promise.all([api('/api/nutzung'), kontenLaden()])
      bericht = b
      zeichnen()
    } catch (e) {
      if (!bericht) {
        leeren(inhalt, h('div.fehlerbox', {}, h('strong', {}, 'Nutzung nicht geladen'), h('span', {}, fehlerText(e)),
          h('button.knopf', { type: 'button', onclick: laden }, 'Erneut versuchen')))
      } else melden(`Nutzung nicht aktualisiert: ${fehlerText(e)}`, 'fehler')
    } finally {
      aktualisieren.disabled = false
    }
  }

  function zeichnen() {
    const b = bericht
    const k = b.kennzahlen
    const nachTag = new Map(b.tage.map((t) => [t.tag, t]))
    if (!gewaehlt) gewaehlt = nachTag.has(b.heute) ? b.heute : (b.tage.at(-1)?.tag ?? b.heute)
    leeren(inhalt,
      h('div.kacheln', {},
        kachel('Heute', kurzZahl(k.heute), 'Tokens'),
        kachel('7 Tage', kurzZahl(k.sieben), 'Tokens'),
        kachel('30 Tage', kurzZahl(k.dreissig), `Ø ${kurzZahl(k.schnittAktiv30)} je aktivem Tag`),
        kachel('Serie', `${k.serie} ${k.serie === 1 ? 'Tag' : 'Tage'}`, `längste: ${k.laengsteSerie}`),
        kachel('Aktivster Tag', k.aktivsterTag ? kurzZahl(k.aktivsterTag.tokens) : '–', k.aktivsterTag ? tagKurz(k.aktivsterTag.tag) : 'noch keiner')),
      karte('Aktivität', `${k.aktiveTage} aktive Tage im letzten Jahr`, raster(b, nachTag), tagOrt),
      karte('Konten', null, kontenOrt),
      h('div.zwei-spalten', {},
        karte('Tageszeit', 'Wann du arbeitest (letztes Jahr)', stundenBild(b.stunden)),
        karte('Modelle', null, balkenListe(b.modelle.map((m) => ({ name: modellName(m.modell) || m.modell, wert: m.tokens, zusatz: `${zahl(m.antworten)} Antworten` }))))),
      karte('Projekte', 'Nach Tokens, letztes Jahr', balkenListe(b.projekte.map((p) => ({ name: p.projekt === '?' ? 'ohne Projekt' : p.projekt, wert: p.tokens, zusatz: `${zahl(p.antworten)} Antworten` })))),
    )
    tagZeigen(gewaehlt, nachTag)
  }

  // --- Raster -------------------------------------------------------------------
  function raster(b, nachTag) {
    // 53 Spalten (Wochen), letzte Spalte endet mit heute. Start: Montag vor 52 Wochen.
    const start = tagPlus(b.heute, -(52 * 7 + wochentag(b.heute)))
    const grenzen = stufenGrenzen(b.tage.map((t) => t.tokens))
    const zellen = []
    const monate = []
    let letzterMonat = null
    for (let w = 0; w < 53; w++) {
      const montag = tagPlus(start, w * 7)
      const monat = montag.slice(0, 7)
      if (monat !== letzterMonat) {
        // Monatsname ueber der ersten Woche, die in diesem Monat beginnt. Die
        // angeschnittene erste Spalte bekommt keinen, sonst stehen zwei
        // Namen uebereinander ("Sep Okt").
        if (monate.length === 1 && w < 3) monate.pop()
        monate.push(h('span.monat', { style: { gridColumn: `${w + 1}` } }, alsDatum(montag).toLocaleDateString('de-DE', { month: 'short', timeZone: 'UTC' })))
        letzterMonat = monat
      }
      for (let d = 0; d < 7; d++) {
        const tag = tagPlus(montag, d)
        if (tag > b.heute) { zellen.push(h('span.zelle.zukunft', { style: { gridColumn: `${w + 1}`, gridRow: `${d + 1}` } })); continue }
        const t = nachTag.get(tag)
        const st = stufe(t?.tokens ?? 0, grenzen)
        zellen.push(h(`span.zelle.s${st}${tag === gewaehlt ? '.gewaehlt' : ''}${tag === b.heute ? '.heute' : ''}`, {
          style: { gridColumn: `${w + 1}`, gridRow: `${d + 1}` },
          dataset: { tag },
          title: t ? `${tagKurz(tag)}: ${kurzZahl(t.tokens)} Tokens, ${zahl(t.antworten)} Antworten, ${t.sitzungen} ${t.sitzungen === 1 ? 'Sitzung' : 'Sitzungen'}` : `${tagKurz(tag)}: nichts`,
        }))
      }
    }
    const gitter = h('div.raster', { role: 'img', 'aria-label': 'Aktivität je Tag im letzten Jahr' }, zellen)
    gitter.addEventListener('click', (ev) => {
      const tag = ev.target?.dataset?.tag
      if (!tag) return
      gitter.querySelector('.gewaehlt')?.classList.remove('gewaehlt')
      ev.target.classList.add('gewaehlt')
      gewaehlt = tag
      tagZeigen(tag, nachTag)
    })
    const scroller = h('div.raster-scroll', {},
      h('div.raster-rahmen', {},
        h('div.raster-monate', {}, monate),
        h('div.raster-tage', {}, WOCHENTAGE.map((w, i) => h('span', {}, i % 2 === 0 ? w : ''))),
        gitter))
    // Am Handy passt das Jahr nicht in die Breite: rechts (heute) beginnen.
    requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth })
    const legende = h('div.legende', {}, h('span', {}, 'weniger'), [0, 1, 2, 3, 4].map((s) => h(`span.zelle.s${s}`)), h('span', {}, 'mehr'))
    return h('div', {}, scroller, legende)
  }

  let tagAnfrage = 0
  async function tagZeigen(tag, nachTag) {
    const t = nachTag.get(tag)
    const kopf = h('div.tag-kopf', {}, h('strong', {}, tagLang(tag)),
      t ? h('span.leise', {}, `${kurzZahl(t.tokens)} Tokens · ${zahl(t.antworten)} Antworten · Cache gelesen ${kurzZahl(t.cacheLesen)}`) : h('span.leise', {}, 'Keine Nutzung an diesem Tag.'))
    if (!t) { leeren(tagOrt, kopf); return }
    const liste = h('div.tag-liste', {}, h('div.leise', {}, 'Lädt …'))
    leeren(tagOrt, kopf, liste)
    const nr = ++tagAnfrage
    try {
      const d = await api(`/api/nutzung/tag?tag=${tag}`)
      if (nr !== tagAnfrage) return
      leeren(liste, d.sitzungen.length ? d.sitzungen.map((s) => {
        const text = [h('span.tag-titel', {}, s.chat?.titel ?? (s.projekt ? `Auftrag in ${s.projekt}` : 'Sitzung ohne Chat')),
          h('span.tag-meta', {}, `${uhrzeit(s.von)}${s.bis - s.von > 60000 ? `–${uhrzeit(s.bis)}` : ''} · ${s.projekt ?? ''} · ${kurzZahl(s.tokens)}`)]
        return s.chat
          ? h('a.tag-eintrag', { href: `#/chat/${encodeURIComponent(s.chat.id)}` }, symbol('chat', 14), text)
          : h('div.tag-eintrag', {}, symbol('aufgaben', 14), text)
      }) : h('div.leise', {}, 'Keine Sitzungen gefunden.'))
    } catch (e) {
      if (nr === tagAnfrage) leeren(liste, h('div.fehlertext', {}, fehlerText(e)))
    }
  }

  // --- Konten ---------------------------------------------------------------------
  async function kontenLaden() {
    try {
      const d = await api('/api/konten')
      leeren(kontenOrt, kontenInhalt(d))
    } catch (e) {
      leeren(kontenOrt, h('div.fehlertext.pad', {}, `Konten nicht geladen: ${fehlerText(e)}`))
    }
  }

  async function vorzugSetzen(name) {
    try {
      await api('/api/konten', { body: { name: name ?? '' } })
      await kontenLaden()
      // Der Limit-Hinweis unten in der Seitenleiste zeigt das naechste Konto -- nachziehen.
      dispatchEvent(new Event('konten-geaendert'))
    } catch (e) {
      melden(`Vorzug nicht gesetzt: ${fehlerText(e)}`, 'fehler')
    }
  }

  function kontenInhalt(d) {
    const modus = d.modus === 'manuell'
      ? h('div.konten-modus', {}, symbol('stern', 14), h('span', {}, `Vorzug: ${d.konten.find((k) => k.bevorzugt)?.name}. Das Cockpit nimmt dieses Konto, solange es nicht im Limit ist.`),
        h('button.link', { type: 'button', onclick: () => vorzugSetzen(null) }, 'Wieder ausgleichen'))
      : h('div.konten-modus', {}, symbol('info', 14), h('span', {}, 'Ausgeglichen: jeder neue Chat nimmt das Konto mit der meisten Luft im Wochenlimit.'))
    const karten = d.konten.map((k) => kontoKarte(k, d))
    return [modus, h('div.konten', {}, karten)]
  }

  function kontoKarte(k, d) {
    const jetzt = Date.now()
    const gesperrt = k.gesperrtBis && k.gesperrtBis > jetzt
    const marken = []
    if (!k.angemeldet) marken.push(h('span.marke-klein.aus', {}, 'nicht angemeldet'))
    else if (gesperrt) marken.push(h('span.marke-klein.warn', { title: `bis ${new Date(k.gesperrtBis).toLocaleString('de-DE')}` },
      k.sperrGrund === 'anmeldung' ? 'Anmeldung prüfen' : `im Limit bis ${resetText(k.gesperrtBis)}`))
    if (k.name === d.naechstesKonto) marken.push(h('span.marke-klein.an', {}, 'als Nächstes'))
    if (k.bevorzugt) marken.push(h('span.marke-klein.stern', {}, 'Vorzug'))

    const zeilen = []
    if (k.angemeldet) {
      zeilen.push(fensterZeile('5 Stunden', k.fuenfStundenAnteil, k.fuenfStundenResetAm))
      zeilen.push(fensterZeile('Woche', k.siebenTageAnteil, k.siebenTageResetAm))
      if (k.wochePrognose) {
        zeilen.push(h(`div.prognose${k.wochePrognose.reicht ? '' : '.knapp'}`, {},
          k.wochePrognose.reicht
            ? 'Beim bisherigen Tempo reicht das Wochenlimit bis zum Reset.'
            : `Beim bisherigen Tempo ist das Wochenlimit ${resetText(k.wochePrognose.leerAm)} erreicht (in ${dauerText(k.wochePrognose.leerAm - jetzt)}).`))
      }
      if (k.gemessenAm) zeilen.push(h('div.gemessen', {}, `gemessen ${uhrzeit(k.gemessenAm)}${k.quelle === 'rate_limit_event' ? ' (aus einem Chat)' : ''}`))
      else zeilen.push(h('div.gemessen', {}, 'noch nicht gemessen'))
      zeilen.push(guthabenZeile(d.guthaben?.[k.name]))
    } else {
      zeilen.push(h('div.leise.klein', {}, 'Auf dem Server mit ', h('code', {}, `CLAUDE_CONFIG_DIR=${k.configDir} claude /login`), ' anmelden.'))
    }

    const knopf = k.angemeldet && !k.bevorzugt
      ? h('button.knopf.knopf-schmal', { type: 'button', onclick: () => vorzugSetzen(k.name), title: 'Neue Chats bevorzugt mit diesem Konto starten' }, 'Bevorzugen')
      : k.bevorzugt ? h('button.knopf.knopf-schmal', { type: 'button', onclick: () => vorzugSetzen(null) }, 'Vorzug aufheben') : null

    return h(`div.konto${gesperrt ? '.gesperrt' : ''}`, {},
      h('div.konto-kopf', {},
        h('div.konto-name', {}, h('strong', {}, k.name), k.abo && h('span.abo', {}, k.abo.toUpperCase()), marken),
        knopf),
      k.email && h('div.konto-mail', {}, k.email),
      zeilen)
  }

  function fensterZeile(name, anteil, resetAm) {
    const p = anteil === null || anteil === undefined ? null : Math.round(anteil * 100)
    const klasse = p === null ? '' : p >= 90 ? '.hoch' : p >= 70 ? '.mittel' : ''
    return h('div.fenster', {},
      h('span.fenster-name', {}, name),
      h(`span.fenster-balken${klasse}`, { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p ?? 0, 'aria-label': `${name}: ${p ?? '?'} %` },
        h('span', { style: { width: `${Math.min(100, p ?? 0)}%` } })),
      h('span.fenster-zahl', {}, p === null ? '–' : `${p} %`),
      h('span.fenster-reset', {}, resetAm ? `Reset ${resetText(resetAm)}` : ''))
  }

  function guthabenZeile(g) {
    if (!g) return h('div.guthaben.leise', {}, symbol('info', 13), 'Guthaben: noch nicht abgefragt')
    if (g.aktiv) {
      return h('div.guthaben.an', {}, symbol('haken', 13),
        `Guthaben an: ${geld(g.stand, g.waehrung)} übrig${g.verbraucht ? `, ${geld(g.verbraucht, g.waehrung)} verbraucht` : ''}`)
    }
    return h('div.guthaben', {}, symbol('info', 13),
      h('span', {}, g.vomNutzerAus ? 'Guthaben ausgeschaltet. ' : 'Guthaben aus. ',
        'Einschalten in claude.ai unter Einstellungen → Nutzung.'))
  }

  // --- Diagramme ------------------------------------------------------------------
  function stundenBild(stunden) {
    const max = Math.max(1, ...stunden)
    return h('div.stunden', {},
      h('div.stunden-balken', {}, stunden.map((w, i) => h('span', { title: `${i}–${i + 1} Uhr: ${kurzZahl(w)} Tokens`, style: { height: `${Math.max(w ? 4 : 1, (w / max) * 100)}%` } }))),
      h('div.stunden-achse', {}, [0, 6, 12, 18, 23].map((s) => h('span', { style: { left: `${(s + 0.5) / 24 * 100}%` } }, `${s}`))))
  }

  function balkenListe(eintraege) {
    if (!eintraege.length) return h('div.leise.pad', {}, 'Noch nichts.')
    const max = Math.max(1, ...eintraege.map((e) => e.wert))
    return h('div.balken-liste', {}, eintraege.map((e) => h('div.balken-zeile', { title: e.zusatz },
      h('span.balken-name', {}, e.name),
      h('span.balken-spur', {}, h('span', { style: { width: `${(e.wert / max) * 100}%` } })),
      h('span.balken-wert', {}, kurzZahl(e.wert)))))
  }

  bus.abonnieren('limit', () => { if (sichtbar) kontenLaden() })

  return {
    el,
    zeigen() {
      sichtbar = true
      laden()
      // Limits aendern sich laufend; das Jahr nicht -- nur die Konten pollen.
      clearInterval(uhr)
      uhr = setInterval(() => { if (document.visibilityState === 'visible') kontenLaden() }, 60_000)
    },
    verbergen() { sichtbar = false; clearInterval(uhr) },
  }
}

function kachel(titel, wert, unter) {
  return h('div.kachel', {}, h('div.kachel-titel', {}, titel), h('div.kachel-wert', {}, wert), h('div.kachel-unter', {}, unter))
}

function karte(titel, unter, ...kinder) {
  return h('section.n-karte', {}, h('div.n-karte-kopf', {}, h('h2', {}, titel), unter && h('span.leise', {}, unter)), kinder)
}
