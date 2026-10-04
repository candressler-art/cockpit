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
import { h, symbol, api, leeren, kurzZahl, zahl, uhrzeit, wann, modellName, melden, fehlerText, schalter } from './dom.js'
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

/**
 * Anteil (0..1) als ganze Prozent -- null heisst "keine Messung" und darf nie
 * als 0 % erscheinen: ein abgelaufenes Token saehe sonst aus wie ein leeres Limit.
 */
export const anteilProzent = (anteil) => (anteil === null || anteil === undefined ? null : Math.round(anteil * 100))

/** Woher die Zahlen eines Kontos stammen, oder dass es noch keine gibt --
 *  mit "gestern"/Wochentag, damit ein alter Stand nicht wie ein frischer aussieht. */
export const messungText = (k) => (k.gemessenAm
  ? `gemessen ${wann(k.gemessenAm)}${k.quelle === 'rate_limit_event' ? ' (aus einem Chat)' : ''}`
  : 'noch nicht gemessen')

function dauerText(ms) {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min < 60) return `${min} Min.`
  const std = Math.round(min / 60)
  if (std < 48) return `${std} Std.`
  return `${Math.round(std / 24)} Tagen`
}

const CLOUD_ERKLAERUNG = 'Einmalige Gutschrift von Anthropic für Cloud-Sitzungen. Gilt nicht für Chat, API oder Claude Code auf dem Server.'

/** Verbrauchter Anteil des Cloud-Guthabens in ganzen Prozent. */
export const cloudProzent = (c) => (c.grenze > 0 ? Math.round((c.verbraucht / c.grenze) * 100) : 0)

/** Frist mit Datum und Uhrzeit -- "5. Nov." allein verschweigt, dass es morgens um 9 schon weg ist. */
const fristText = (ms) => `am ${new Date(ms).toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`

const geld = (betrag, waehrung) => betrag === null || betrag === undefined ? '?' :
  betrag.toLocaleString('de-DE', { style: 'currency', currency: waehrung || 'USD' })

export function nutzungBauen() {
  const inhalt = h('div.bereich-inhalt.nutzung')
  const aktualisieren = h('button.knopf-klein.nur-desktop', { type: 'button', title: 'Neu laden', 'aria-label': 'Neu laden', onclick: () => laden() }, symbol('aktualisieren', 16))
  const el = h('section.bereich', {}, h('header.bereich-kopf.mit-status', {}, h('h1', {}, 'Nutzung'), h('span.spacer'), aktualisieren), inhalt)

  const kontenOrt = h('div.konten-ort')
  const kontenStatus = h('span.leise.konten-status', { 'aria-live': 'polite' })
  const tagOrt = h('div.tag-detail')
  let bericht = null
  let gewaehlt = null
  let sichtbar = false
  let uhr = null

  async function laden() {
    if (!bericht) leeren(inhalt, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    aktualisieren.disabled = true
    try {
      // Die Limits erst aus dem letzten Stand zeigen, dann frisch messen --
      // die Messung kann ein paar Sekunden dauern, der Rest soll nicht warten.
      void frischMessen()
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
        kachel('Aktivster Tag', k.aktivsterTag ? kurzZahl(k.aktivsterTag.tokens) : '–', k.aktivsterTag ? tagKurz(k.aktivsterTag.tag) : 'noch keiner'),
        gesamtKachel(b.gesamt)),
      karte('Aktivität', `${k.aktiveTage} aktive Tage im letzten Jahr`, raster(b, nachTag), tagOrt),
      karte('Konten', kontenStatus, kontenOrt),
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
      leeren(liste, d.eintraege.length ? d.eintraege.map(rueckblickEintrag) : h('div.leise', {}, 'Keine Sitzungen gefunden.'))
    } catch (e) {
      if (nr === tagAnfrage) leeren(liste, h('div.fehlertext', {}, fehlerText(e)))
    }
  }

  /**
   * Ein Eintrag im Rueckblick. Chats verlinken auf den Chat, Team-Auftraege
   * auf den Bereich Aufgaben; Loops und Sonstiges sind nur Zeilen. Mehrere
   * Sitzungen (Loop-Durchgaenge, Worker eines Auftrags) stehen als Zahl dabei
   * statt als eigene Zeilen.
   */
  function rueckblickEintrag(e) {
    const art = { chat: 'Chat', loop: 'Automatischer Loop', team: 'Team-Auftrag', sonst: 'ohne Chat-Eintrag' }[e.art]
    const teile = [
      `${uhrzeit(e.von)}${e.bis - e.von > 60000 ? `–${uhrzeit(e.bis)}` : ''}`,
      art,
      e.projekt,
      e.sitzungen > 1 ? `${e.sitzungen} ${e.art === 'loop' ? 'Durchgänge' : e.art === 'team' ? 'Agenten-Aufrufe' : 'Sitzungen'}` : null,
      kurzZahl(e.tokens),
    ].filter(Boolean)
    const text = [h('span.tag-titel', { title: e.titel }, e.titel), h('span.tag-meta', {}, teile.join(' · '))]
    const sym = { chat: 'chat', loop: 'aktualisieren', team: 'aufgaben', sonst: 'datei' }[e.art]
    if (e.art === 'chat') return h('a.tag-eintrag', { href: `#/chat/${encodeURIComponent(e.chat)}` }, symbol(sym, 14), text)
    if (e.art === 'team') return h('a.tag-eintrag', { href: '#/aufgaben' }, symbol(sym, 14), text)
    return h(`div.tag-eintrag.${e.art}`, {}, symbol(sym, 14), text)
  }

  // --- Konten ---------------------------------------------------------------------
  // Zwei Wege: GET liefert den letzten Stand sofort, POST .../messen fragt
  // vorher bei Anthropic nach (der Server misst hoechstens alle 10 s). Eine
  // frische Messung ist immer der neueste Stand, auch wenn sie vor einem GET
  // losging. Ein GET, der schon unterwegs war, als sie ankam, kann dagegen
  // noch den alten Stand tragen -- er wird verworfen, sonst ueberschriebe er
  // die eben gemessenen Werte.
  let frischAngekommen = -1
  let messung = null

  async function kontenLaden(frisch = false) {
    const gestartet = performance.now()
    const veraltet = () => !frisch && gestartet < frischAngekommen
    try {
      const d = await (frisch ? api('/api/konten/messen', { method: 'POST' }) : api('/api/konten'))
      if (veraltet()) return
      if (frisch) frischAngekommen = performance.now()
      leeren(kontenOrt, kontenInhalt(d))
      // Der Limit-Hinweis unten in der Seitenleiste soll dasselbe zeigen.
      if (frisch) dispatchEvent(new Event('konten-geaendert'))
    } catch (e) {
      if (veraltet()) return
      // Ein Stand ist schon zu sehen: stehen lassen, nur sagen, dass er nicht neu ist.
      if (frisch && kontenOrt.childElementCount) throw e
      leeren(kontenOrt, h('div.fehlertext.pad', {}, `Konten nicht geladen: ${fehlerText(e)}`))
    }
  }

  /** Limits frisch messen; laeuft schon eine Messung, auf diese warten. */
  function frischMessen() {
    if (messung) return messung
    leeren(kontenStatus, h('span.kreisel'), 'wird gemessen …')
    kontenStatus.title = ''
    messung = kontenLaden(true)
      .then(() => leeren(kontenStatus))
      .catch((e) => {
        leeren(kontenStatus, 'nicht neu gemessen')
        kontenStatus.title = fehlerText(e)
      })
      .finally(() => { messung = null })
    return messung
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

  async function schalterSetzen(name, an) {
    try {
      await api('/api/konten/schalter', { body: { name, an } })
      dispatchEvent(new Event('konten-geaendert'))
    } catch (e) {
      melden(`Konto nicht umgeschaltet: ${fehlerText(e)}`, 'fehler')
    }
    await kontenLaden()
  }

  async function grenzeSetzen(name, fuenf, woche) {
    try {
      await api('/api/konten/grenze', { body: { name, fuenf, woche } })
    } catch (e) {
      melden(`Grenze nicht gespeichert: ${fehlerText(e)}`, 'fehler')
    }
    await kontenLaden()
  }

  /** Zwei Felder "Höchstens … %" je Fenster; leer heißt keine Grenze. */
  function grenzeZeile(k) {
    const feld = (art, wert, label) => h('input.grenze-feld', {
      type: 'number', min: 1, max: 100, step: 1, inputmode: 'numeric', placeholder: '–',
      value: wert === null || wert === undefined ? '' : Math.round(wert * 100),
      'aria-label': `${label}: Obergrenze in Prozent für Konto ${k.name}`,
    })
    const f5 = feld('fuenf', k.grenze?.fuenf, '5 Stunden')
    const f7 = feld('woche', k.grenze?.woche, 'Woche')
    const speichern = () => grenzeSetzen(k.name, f5.value.trim(), f7.value.trim())
    f5.addEventListener('change', speichern)
    f7.addEventListener('change', speichern)
    return h('div.konto-grenze', { title: 'Bis zu diesem Anteil nimmt das Cockpit das Konto, danach nicht mehr. Leer = keine Grenze. Geprüft wird beim Start jedes Auftrags.' },
      h('span', {}, 'Höchstens'),
      f5, h('span.leise', {}, '% / 5 Std.'),
      f7, h('span.leise', {}, '% / Woche'))
  }

  function kontenInhalt(d) {
    const modus = d.modus === 'manuell'
      ? h('div.konten-modus', {}, symbol('stern', 14), h('span', {}, `Vorzug: ${d.konten.find((k) => k.bevorzugt)?.name}. Das Cockpit nimmt dieses Konto, solange es nicht im Limit ist.`),
        h('button.link', { type: 'button', onclick: () => vorzugSetzen(null) }, 'Wieder ausgleichen'))
      : h('div.konten-modus', {}, symbol('info', 14), h('span', {}, 'Ausgeglichen: jeder neue Chat nimmt das Konto mit der meisten Luft im Wochenlimit.'))
    const karten = d.konten.map((k) => kontoKarte(k, d))
    return [modus, cloudGesamtBlock(d), guthabenGesamtBlock(d), h('div.konten', {}, karten)].filter(Boolean)
  }

  function kontoKarte(k, d) {
    const jetzt = Date.now()
    const gesperrt = k.gesperrtBis && k.gesperrtBis > jetzt
    const marken = []
    if (!k.angemeldet) marken.push(h('span.marke-klein.aus', {}, 'nicht angemeldet'))
    else if (gesperrt) marken.push(h('span.marke-klein.warn', { title: `bis ${new Date(k.gesperrtBis).toLocaleString('de-DE')}` },
      k.sperrGrund === 'anmeldung' ? 'Anmeldung prüfen' : `im Limit bis ${resetText(k.gesperrtBis)}`))
    if (k.angemeldet && !gesperrt && k.grenzeErreicht) marken.push(h('span.marke-klein.warn', {
      title: 'Eigene Obergrenze erreicht: das Cockpit nimmt dieses Konto nicht mehr, bis das Fenster zurückgesetzt ist.',
    }, `Grenze erreicht${k.grenzeErreicht.bisMs ? ` bis ${resetText(k.grenzeErreicht.bisMs)}` : ''}`))
    if (k.name === d.naechstesKonto) marken.push(h('span.marke-klein.an', {}, 'als Nächstes'))
    if (k.bevorzugt) marken.push(h('span.marke-klein.stern', {}, 'Vorzug'))
    if (k.geteilt) marken.push(h('span.marke-klein', { title: 'Wird mit jemandem geteilt (z.B. im Roblox-Cockpit). Ohne Schalter nimmt dieses Cockpit es nicht.' }, 'geteilt'))
    if (!k.aktiv) marken.push(h('span.marke-klein.aus', {}, 'aus'))

    const zeilen = []
    if (k.angemeldet) {
      zeilen.push(fensterZeile('5 Stunden', k.fuenfStundenAnteil, k.fuenfStundenResetAm))
      zeilen.push(fensterZeile('Woche', k.siebenTageAnteil, k.siebenTageResetAm))
      // Schon voll: dazu sagt die Marke "im Limit bis ..." alles -- eine
      // Prognose "wird um 12:34 erreicht (in 0 Min.)" waere nur verwirrend.
      if (k.wochePrognose && !(k.siebenTageAnteil >= 1)) {
        zeilen.push(h(`div.prognose${k.wochePrognose.reicht ? '' : '.knapp'}`, {},
          k.wochePrognose.reicht
            ? 'Beim bisherigen Tempo reicht das Wochenlimit bis zum Reset.'
            : `Beim bisherigen Tempo ist das Wochenlimit ${resetText(k.wochePrognose.leerAm)} erreicht (in ${dauerText(k.wochePrognose.leerAm - jetzt)}).`))
      }
      const cloud = d.cloud?.[k.name]
      if (cloud) zeilen.push(cloudZeile(cloud))
      zeilen.push(h('div.gemessen', {}, messungText(k)))
      zeilen.push(guthabenZeile(d.guthaben?.[k.name]))
    } else {
      zeilen.push(h('div.leise.klein', {}, 'Auf dem Server mit ', h('code', {}, `CLAUDE_CONFIG_DIR=${k.configDir} claude /login`), ' anmelden.'))
    }

    if (k.angemeldet) zeilen.push(grenzeZeile(k))

    // Schalter "im Cockpit nutzen" fuer jedes Zusatzkonto; das Hauptkonto ist immer an.
    if (k.name !== 'haupt' && k.aktiv !== undefined) {
      zeilen.push(h('div.konto-schalter', {},
        h('span', {}, k.geteilt ? 'Auch in diesem Cockpit nutzen' : 'In diesem Cockpit nutzen'),
        schalter(k.aktiv, (an) => schalterSetzen(k.name, an), `Konto ${k.name} in diesem Cockpit nutzen`)))
    }

    const knopf = k.angemeldet && k.aktiv !== false && !k.bevorzugt
      ? h('button.knopf.knopf-schmal', { type: 'button', onclick: () => vorzugSetzen(k.name), title: 'Neue Chats bevorzugt mit diesem Konto starten' }, 'Bevorzugen')
      : k.bevorzugt ? h('button.knopf.knopf-schmal', { type: 'button', onclick: () => vorzugSetzen(null) }, 'Vorzug aufheben') : null

    return h(`div.konto${gesperrt ? '.gesperrt' : ''}${k.aktiv === false ? '.abgeschaltet' : ''}`, {},
      h('div.konto-kopf', {},
        h('div.konto-name', {}, h('strong', {}, k.name), k.abo && h('span.abo', {}, k.abo.toUpperCase()), marken),
        knopf),
      k.email && h('div.konto-mail', {}, k.email),
      zeilen)
  }

  function fensterZeile(name, anteil, resetAm) {
    const p = anteilProzent(anteil)
    const klasse = p === null ? '' : p >= 90 ? '.hoch' : p >= 70 ? '.mittel' : ''
    return h('div.fenster', {},
      h('span.fenster-name', {}, name),
      h(`span.fenster-balken${klasse}`, { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p ?? 0, 'aria-label': `${name}: ${p ?? '?'} %` },
        h('span', { style: { width: `${Math.min(100, p ?? 0)}%` } })),
      h('span.fenster-zahl', {}, p === null ? '–' : `${p} %`),
      h('span.fenster-reset', {}, resetAm ? `Reset ${resetText(resetAm)}` : ''))
  }

  /** Cloud-Guthaben eines Kontos, als Balken wie die Limits: Anteil verbraucht. */
  function cloudZeile(c) {
    const p = cloudProzent(c)
    const klasse = p >= 90 ? '.hoch' : p >= 70 ? '.mittel' : ''
    // Die Frist steht im Block darueber -- in der schmalen Karte waeren es sonst drei Zeilen.
    const unter = [`${geld(c.verbraucht, 'USD')} von ${geld(c.grenze, 'USD')} verbraucht`]
    if (c.gesperrt) unter.push(`gesperrt (${c.gesperrt})`)
    return h('div.fenster', { title: CLOUD_ERKLAERUNG },
      h('span.fenster-name', {}, 'Cloud'),
      h(`span.fenster-balken${klasse}`, { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p, 'aria-label': `Cloud-Guthaben: ${p} % verbraucht` },
        h('span', { style: { width: `${Math.min(100, p)}%` } })),
      h('span.fenster-zahl', {}, `${p} %`),
      h('span.fenster-reset', {}, unter.join(' · ')))
  }

  /** Summe ueber alle Konten -- steht vor dem Nutzungsguthaben, weil es das ist, was Can wirklich hat. */
  function cloudGesamtBlock(d) {
    const c = d.cloudGesamt
    if (!c) return null
    const teile = [`Cloud-Guthaben: ${geld(c.rest, 'USD')} von ${geld(c.grenze, 'USD')} übrig` +
      (c.konten > 1 ? ` (${c.konten} Konten)` : ''), `${geld(c.verbraucht, 'USD')} verbraucht`]
    if (c.verfaelltAm) {
      const tage = Math.floor((c.verfaelltAm - Date.now()) / 86_400_000)
      teile.push(`verfällt ${fristText(c.verfaelltAm)}${tage >= 1 ? ` (noch ${tage} ${tage === 1 ? 'Tag' : 'Tage'})` : ''}`)
    }
    return h('div.guthaben-gesamt.an', { title: CLOUD_ERKLAERUNG }, symbol('wolke', 14),
      h('span', {}, teile.join(' · '), h('br'),
        h('span.leise', {}, 'Nur für Cloud-Sitzungen (claude.ai/code, claude --cloud), wird dort vor dem Abo-Limit verbraucht.')))
  }

  function guthabenZeile(g) {
    if (!g) return h('div.guthaben.leise', {}, symbol('info', 13), 'Guthaben: noch nicht abgefragt')
    if (g.aktiv) {
      const rest = g.prognose?.rest ?? g.stand
      return h('div.guthaben.an', {}, symbol('haken', 13),
        h('span', {},
          `Guthaben an: ${rest === null || rest === undefined ? 'Stand unbekannt' : `${geld(rest, g.waehrung)} übrig`}` +
          `${g.verbraucht ? `, ${geld(g.verbraucht, g.waehrung)} verbraucht` : ''}${g.grenze ? ` (Grenze ${geld(g.grenze, g.waehrung)})` : ''}.`,
          h('br'), h('span.leise', {}, prognoseText(g.prognose, g.waehrung))))
    }
    return h('div.guthaben', {}, symbol('info', 13),
      h('span', {}, g.vomNutzerAus ? 'Guthaben ausgeschaltet. ' : 'Guthaben aus. ',
        'Einschalten in claude.ai unter Einstellungen → Nutzung.'))
  }

  /** "Reicht noch ..."-Satz. Ehrlich, wenn es fuer eine Aussage nicht reicht. */
  function prognoseText(p, waehrung) {
    if (!p) return ''
    if (p.proTag === null) {
      return p.basisTage < 1
        ? 'Prognose ab einem Tag Verlauf -- das Cockpit misst den Verbrauch stündlich.'
        : 'Noch keine Prognose möglich.'
    }
    if (p.proTag === 0) return `Kein Verbrauch in den letzten ${Math.round(p.basisTage)} Tagen -- es reicht, solange das so bleibt.`
    const tempo = `${geld(p.proTag, waehrung)} pro Tag (Schnitt ${p.basisTage < 2 ? 'seit gestern' : `der letzten ${Math.round(p.basisTage)} Tage`})`
    if (p.tage === null) return `Tempo: ${tempo}. Wie viel übrig ist, meldet Anthropic nicht.`
    return `Tempo: ${tempo} -- reicht noch etwa ${p.tage < 1 ? 'weniger als einen Tag' : `${Math.round(p.tage)} Tage`}, bis ${resetText(p.leerAm)}.`
  }

  /** Summe ueber alle Konten -- Can denkt in "meinem Guthaben", nicht je Konto. */
  function guthabenGesamtBlock(d) {
    const g = d.guthabenGesamt
    if (!g) return null
    const alle = Object.values(d.guthaben ?? {})
    if (g.aktiv === 0) {
      return h('div.guthaben-gesamt', {}, symbol('info', 14),
        h('span', {}, alle.length
          ? `Nutzungsguthaben: auf keinem Konto eingeschaltet. Sobald du es in claude.ai (Einstellungen → Nutzung) einschaltest, stehen hier Stand, Tempo und wie lange es reicht.`
          : 'Nutzungsguthaben: noch nicht abgefragt.'))
    }
    const teile = [`Nutzungsguthaben auf ${g.aktiv} ${g.aktiv === 1 ? 'Konto' : 'Konten'}`]
    if (g.rest !== null) teile.push(`${geld(g.rest, g.waehrung)} übrig`)
    if (g.proTag !== null) teile.push(`${geld(g.proTag, g.waehrung)} pro Tag`)
    if (g.tage !== null) teile.push(`reicht noch etwa ${g.tage < 1 ? 'weniger als einen Tag' : `${Math.round(g.tage)} Tage`} (bis ${resetText(g.leerAm)})`)
    return h('div.guthaben-gesamt.an', {}, symbol('haken', 14), h('span', {}, teile.join(' · ')))
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
  // Zurueck ins Fenster (anderes Programm, Handy entsperrt) zaehlt wie ein
  // neues Oeffnen des Bereichs.
  document.addEventListener('visibilitychange', () => {
    if (sichtbar && document.visibilityState === 'visible') frischMessen()
  })

  return {
    el,
    zeigen() {
      sichtbar = true
      laden()
      // Limits aendern sich laufend; das Jahr nicht -- nur die Konten neu messen.
      clearInterval(uhr)
      uhr = setInterval(() => { if (document.visibilityState === 'visible') frischMessen() }, 60_000)
    },
    verbergen() { sichtbar = false; clearInterval(uhr) },
  }
}

/** Alles seit Beginn der Aufzeichnung -- die Aufschluesselung steht im Tooltip. */
function gesamtKachel(g) {
  if (!g) return kachel('Insgesamt', '–', 'noch keine Daten')
  const seit = g.seit ? alsDatum(g.seit).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null
  const k = kachel('Insgesamt', kurzZahl(g.tokens), seit ? `seit ${seit}` : 'noch keine Daten')
  k.title = `${zahl(g.tokens)} Tokens seit ${g.seit ?? '–'}\n` +
    `Eingabe ${zahl(g.ein)} · Ausgabe ${zahl(g.aus)} · Cache geschrieben ${zahl(g.cacheSchreiben)}\n` +
    `Cache gelesen (nicht mitgezählt) ${zahl(g.cacheLesen)}\n${zahl(g.antworten)} Antworten in ${zahl(g.sitzungen)} Sitzungen`
  return k
}

function kachel(titel, wert, unter) {
  return h('div.kachel', {}, h('div.kachel-titel', {}, titel), h('div.kachel-wert', {}, wert), h('div.kachel-unter', {}, unter))
}

function karte(titel, unter, ...kinder) {
  return h('section.n-karte', {}, h('div.n-karte-kopf', {}, h('h2', {}, titel), unter && (unter instanceof Node ? unter : h('span.leise', {}, unter))), kinder)
}
