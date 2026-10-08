/**
 * Live-Vorschau im Chat -- wie in Claude Design. HTML-Entwuerfe, die Claude
 * oder ein Spezialist in diesem Chat anlegt (Write/Edit auf eine .html-Datei),
 * erscheinen hier und laden neu, sobald sich die Seite oder eine Datei in
 * ihrem Ordner aendert (CSS, Bilder).
 *
 * "Kommentieren": In der Vorschau ein Element antippen und sagen, was anders
 * sein soll. Der Kommentar landet samt Element im Eingabefeld, gesendet wird
 * wie immer. So lassen sich mehrere Wuensche sammeln und auf einmal schicken.
 * Bei reinem Text geht auch "Text direkt aendern": Can tippt den neuen Text
 * in der Seite selbst, mit dem Kommentar kommt alt -> neu in den Chat.
 *
 * "Regler": Hat die Seite CSS-Variablen (Farben, Abstaende, Groessen, Zahlen),
 * lassen sie sich live verstellen. Die Seite aendert sich sofort; die Werte
 * kommen erst mit "Zum Chat hinzufuegen" in die Eingabe, damit Claude sie in
 * die Datei schreibt.
 *
 * Die Seite laeuft in einem abgeschotteten iframe (sandbox ohne
 * allow-same-origin, dazu CSP vom Daemon). Mit ihr spricht nur
 * vorschau-helfer.js, per postMessage.
 *
 * Am Handy fuellt die Vorschau den Bildschirm, am Rechner steht sie rechts
 * neben dem Chat. Geoeffnet wird sie ueber die Leiste ueber der Eingabe (den
 * Chat-Kopf gibt es am Handy nicht) oder am Werkzeugaufruf im Verlauf.
 */
import { h, symbol, api, leeren, melden } from './dom.js'

const HTML = /\.html?$/i
const ordnerVon = (p) => p.slice(0, p.lastIndexOf('/') + 1)

// --- Regler: CSS-Variablen der Seite einordnen ------------------------------
const AUS_CSS = /(?:^|[;{\s])(--[A-Za-z0-9_-]{1,60})\s*:/g
const LAENGE = /^(-?\d*\.?\d+)(px|rem|em|%|vw|vh|vmin|vmax|ch|ex|svh|dvh)$/i
const ZAHL = /^-?\d*\.?\d+$/
const KEIN_WERT = /^(inherit|initial|unset|revert|revert-layer|currentcolor|transparent|none|auto)$/i
let malfeld = null

/** Farbe -> { hex, alpha } ueber ein 1x1-Canvas (versteht jede CSS-Farbe, auch oklch). */
function farbeLesen(w) {
  if (KEIN_WERT.test(w) || ZAHL.test(w) || !CSS.supports('color', w)) return null
  malfeld ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!malfeld) return null
  malfeld.canvas.width = malfeld.canvas.height = 1
  malfeld.clearRect(0, 0, 1, 1)
  malfeld.fillStyle = '#000'
  malfeld.fillStyle = w
  malfeld.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = malfeld.getImageData(0, 0, 1, 1).data
  const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
  return { hex, alpha: Math.round((a / 255) * 100) / 100 }
}

/** Eine Variable als Regler, oder null (Schriften, Schatten, var(), calc() ...). */
export function reglerEinordnen({ name, wert }) {
  const m = LAENGE.exec(wert)
  if (m) {
    const zahl = parseFloat(m[1])
    const einheit = m[2].toLowerCase()
    const ganz = einheit === 'px' || einheit === '%'
    const max = einheit === '%' ? Math.max(100, Math.abs(zahl)) : ganz ? Math.max(Math.ceil(Math.abs(zahl) * 3), 48) : Math.max(Math.abs(zahl) * 3, 4)
    return { name, wert, art: 'laenge', zahl, einheit, min: zahl < 0 ? -max : 0, max, schritt: ganz ? 1 : 0.05 }
  }
  if (ZAHL.test(wert)) {
    const zahl = parseFloat(wert)
    // Schriftstaerke (100 ... 900)
    if (Number.isInteger(zahl) && zahl >= 100 && zahl <= 900 && zahl % 100 === 0) return { name, wert, art: 'zahl', zahl, einheit: '', min: 100, max: 900, schritt: 100 }
    const ganz = Number.isInteger(zahl) && Math.abs(zahl) >= 10
    const max = Math.max(Math.abs(zahl) * 3, 2)
    return { name, wert, art: 'zahl', zahl, einheit: '', min: zahl < 0 ? -max : 0, max, schritt: ganz ? 1 : 0.05 }
  }
  const f = farbeLesen(wert)
  return f ? { name, wert, art: 'farbe', ...f } : null
}

const REIHENFOLGE = { farbe: 0, laenge: 1, zahl: 2 }
const zahlText = (v) => String(Number(Number(v).toFixed(2)))
const mitAlpha = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`

export function vorschauBauen({ beiKommentar, beiOffen }) {
  let chatId = null
  let dateien = []      // [{ pfad, name, geaendert, url }] neueste zuerst
  let aktuell = null    // Pfad der gezeigten Datei
  let offen = false
  let waehlen = false
  let gewaehlt = null   // { selektor, text, tag } aus der Vorschau
  let neu = false       // geaendert, seit Can zuletzt hingesehen hat
  let ladeNr = 0
  let textModus = false // Can aendert den Text des gewaehlten Elements direkt
  let neuText = null
  let regler = []       // [{ name, wert, art, ... }] aus der gezeigten Seite
  const aenderungen = new Map() // name -> { vorher, neu, hex? }
  let reglerOffen = false
  let quellenNr = 0

  const leisteText = h('span.vorschau-aufruf-text')
  const leiste = h('button.vorschau-aufruf', { type: 'button', hidden: true }, symbol('auge', 15), leisteText)
  leiste.addEventListener('click', () => oeffnen())

  const dateiWahl = h('select.chip.vorschau-datei', { 'aria-label': 'Entwurf', title: 'Entwurf' })
  const dateiName = h('span.vorschau-name')
  const schliessenKnopf = h('button.knopf-klein', { type: 'button', title: 'Vorschau schließen (Esc)', 'aria-label': 'Vorschau schließen' }, symbol('kreuz', 18))
  const handyKnopf = h('button.chip.rund.vorschau-breite', { type: 'button', title: 'In Handybreite zeigen', 'aria-label': 'In Handybreite zeigen', 'aria-pressed': 'false' }, symbol('handy', 15))
  const waehlKnopf = h('button.chip.vorschau-waehlen', { type: 'button', 'aria-pressed': 'false', title: 'Element antippen und sagen, was anders sein soll' },
    symbol('fadenkreuz', 15), h('span', {}, 'Kommentieren'))
  const reglerKnopf = h('button.chip.vorschau-regler', { type: 'button', hidden: true, 'aria-pressed': 'false', 'aria-label': 'Regler', title: 'Farben, Abstände und Größen live verstellen' },
    symbol('regler', 15), h('span', {}, 'Regler'))
  const neuKnopf = h('button.chip.rund', { type: 'button', title: 'Neu laden', 'aria-label': 'Neu laden' }, symbol('aktualisieren', 15))
  const extern = h('a.chip.rund', { target: '_blank', rel: 'noopener noreferrer', title: 'In neuem Tab öffnen', 'aria-label': 'In neuem Tab öffnen' }, symbol('extern', 15))
  const rahmen = h('iframe.vorschau-rahmen', {
    title: 'Live-Vorschau', sandbox: 'allow-scripts allow-forms allow-popups allow-modals', referrerpolicy: 'no-referrer',
  })
  const zielEl = h('div.vorschau-ziel')
  const kommentarFeld = h('textarea.vorschau-kommentar-feld', { rows: 2, placeholder: 'Was soll hier anders sein?', 'aria-label': 'Kommentar zum gewählten Element' })
  const textKnopf = h('button.knopf.vorschau-text-knopf', { type: 'button', hidden: true, title: 'Den Text in der Vorschau selbst überschreiben', onclick: () => textAendern() },
    symbol('stift', 15), h('span', {}, 'Text direkt ändern'))
  const kommentarBox = h('div.vorschau-kommentar', { hidden: true }, zielEl, kommentarFeld,
    h('div.vorschau-kommentar-knoepfe', {},
      textKnopf, h('span.spacer'),
      h('button.knopf', { type: 'button', onclick: () => kommentarZu(true) }, 'Abbrechen'),
      h('button.knopf.primaer', { type: 'button', onclick: () => kommentarUebernehmen() }, 'Zum Chat hinzufügen')))
  const reglerListe = h('div.vorschau-regler-liste')
  const reglerZurueckKnopf = h('button.knopf', { type: 'button', onclick: () => reglerZuruecksetzen() }, 'Zurücksetzen')
  const reglerUebernehmenKnopf = h('button.knopf.primaer', { type: 'button', onclick: () => reglerUebernehmen() }, 'Zum Chat hinzufügen')
  const reglerBox = h('div.vorschau-regler-box', { hidden: true },
    h('div.vorschau-regler-kopf', {}, h('strong', {}, 'Regler'), h('span.leise', {}, 'wirkt sofort hier, in die Datei kommt es über den Chat')),
    reglerListe,
    h('div.vorschau-kommentar-knoepfe', {}, reglerZurueckKnopf, reglerUebernehmenKnopf))
  const tipp = h('div.vorschau-tipp', { hidden: true }, 'Tippe in der Vorschau auf das Element, das anders werden soll.')
  const el = h('aside.vorschau', { hidden: true, 'aria-label': 'Live-Vorschau' },
    h('div.vorschau-kopf', {}, schliessenKnopf, dateiWahl, dateiName, h('span.spacer'), handyKnopf, reglerKnopf, waehlKnopf, neuKnopf, extern),
    tipp,
    h('div.vorschau-buehne', {}, rahmen),
    kommentarBox,
    reglerBox)

  const datei = () => dateien.find((d) => d.pfad === aktuell) ?? null

  /** Andere Seite: Regler und offene Aenderungen gehoerten zur vorigen. */
  function seiteSetzen(pfad) {
    if (pfad === aktuell) return
    aktuell = pfad
    aenderungen.clear()
    regler = []
    reglerZeichnen()
  }

  function zeichnen() {
    leiste.hidden = !dateien.length
    leiste.classList.toggle('neu', neu)
    const d = datei() ?? dateien[0]
    if (d) leeren(leisteText, dateien.length > 1 ? `Vorschau: ${d.name} (+${dateien.length - 1})` : `Vorschau: ${d.name}`)
    leiste.title = neu ? 'Der Entwurf hat sich geändert -- ansehen' : 'Live-Vorschau öffnen'
    dateiWahl.replaceChildren(...dateien.map((x) => h('option', { value: x.pfad, title: x.pfad }, x.name)))
    dateiWahl.hidden = dateien.length < 2
    dateiName.hidden = dateien.length > 1
    leeren(dateiName, datei()?.name ?? '')
    if (aktuell) dateiWahl.value = aktuell
    const x = datei()
    if (x) extern.href = x.url
  }

  /** Liste der Entwuerfe dieses Chats holen (null = neuer, leerer Chat). */
  async function laden(id) {
    chatId = id
    const nr = ++ladeNr
    if (!id) { dateien = []; zeichnen(); return }
    try {
      const d = await api(`/api/chats/${encodeURIComponent(id)}/vorschau`)
      if (nr !== ladeNr) return
      dateien = d.dateien ?? []
      if (!aktuell || !datei()) seiteSetzen(dateien[0]?.pfad ?? null)
      zeichnen()
    } catch { /* ohne Liste bleibt die Leiste einfach weg */ }
  }

  function zuruecksetzen() {
    ladeNr++ // eine noch laufende Liste des vorigen Chats verfaellt
    schliessen()
    chatId = null
    dateien = []
    seiteSetzen(null)
    neu = false
    zeichnen()
  }

  function rahmenLaden() {
    const d = datei()
    if (!d) return
    quellenNr++ // Variablen der vorigen Seite verfallen
    rahmen.src = `${d.url}?v=${Date.now()}`
  }

  const anSeite = (d) => rahmen.contentWindow?.postMessage({ cockpitVorschau: true, ...d }, '*')

  function oeffnen(pfad) {
    if (pfad) seiteSetzen(pfad)
    if (!datei()) return
    offen = true
    neu = false
    el.hidden = false
    beiOffen?.(true)
    zeichnen()
    rahmenLaden()
    schliessenKnopf.focus({ preventScroll: true })
  }

  function schliessen() {
    if (!offen) return
    offen = false
    el.hidden = true
    waehlenSetzen(false)
    kommentarZu()
    reglerZu()
    // Stoppt Skripte, Videos und Ton der Seite.
    rahmen.src = 'about:blank'
    beiOffen?.(false)
  }

  /**
   * Eine Datei wurde geschrieben (Werkzeugergebnis im Chat). Neue HTML-Datei:
   * Liste neu holen. Die gezeigte Seite oder etwas in ihrem Ordner: neu laden.
   */
  async function geschrieben(pfad) {
    const id = chatId
    if (!id || typeof pfad !== 'string') return
    if (HTML.test(pfad)) {
      await laden(id)
      if (chatId !== id) return // inzwischen anderer Chat
      if (!offen) { seiteSetzen(pfad); neu = true; zeichnen() }
    }
    const d = datei()
    if (offen && d && (pfad === d.pfad || pfad.startsWith(ordnerVon(d.pfad)))) rahmenLaden()
    else if (!offen && d && pfad.startsWith(ordnerVon(d.pfad))) { neu = true; zeichnen() }
  }

  function waehlenSetzen(an) {
    waehlen = an
    waehlKnopf.setAttribute('aria-pressed', String(an))
    tipp.hidden = !an || !kommentarBox.hidden
    anSeite({ typ: 'waehlen', an })
  }

  /** Box zu. Das Getippte bleibt stehen, ausser bei "Abbrechen" und nach dem Uebernehmen. */
  function kommentarZu(verwerfen = false, textBehalten = false) {
    if (textModus) anSeite({ typ: 'textEnde', behalten: textBehalten })
    textModusSetzen(false)
    kommentarBox.hidden = true
    if (verwerfen) kommentarFeld.value = ''
    gewaehlt = null
    tipp.hidden = !waehlen
  }

  function textModusSetzen(an) {
    textModus = an
    neuText = null
    textKnopf.hidden = an || !gewaehlt?.bearbeitbar
    kommentarFeld.placeholder = an ? 'Tipp den neuen Text oben in die Seite. Hier optional noch ein Wunsch dazu.' : 'Was soll hier anders sein?'
  }

  function textAendern() {
    if (!gewaehlt?.bearbeitbar) return
    textModusSetzen(true)
    anSeite({ typ: 'textStart' })
  }

  function kommentarUebernehmen() {
    const t = kommentarFeld.value.trim()
    const textNeu = textModus && neuText !== null && neuText !== gewaehlt?.volltext ? neuText : null
    if ((!t && textNeu === null) || !gewaehlt) { kommentarFeld.focus(); return }
    const d = datei()
    const wo = gewaehlt.text ? ` („${gewaehlt.text}“)` : ''
    const was = [textNeu !== null ? `Text ändern zu „${textNeu}“` : '', t].filter(Boolean).join('. Außerdem: ')
    beiKommentar?.(`Zur Vorschau \`${d?.name ?? 'Seite'}\`, Element \`${gewaehlt.selektor}\`${wo}: ${was}`)
    melden('Kommentar steht im Eingabefeld. Sammle weitere oder schließ die Vorschau und sende.', 'info')
    kommentarZu(true, true)
  }

  // --- Regler ----------------------------------------------------------------

  /** Variablennamen aus der Seite und ihren verlinkten Stylesheets; die Werte liefert dann die Seite. */
  async function quellenLesen(daten) {
    const nr = ++quellenNr
    const links = (Array.isArray(daten.links) ? daten.links : []).slice(0, 12)
    // Verlinkte Stylesheets zuerst: so stehen die Regler in der Reihenfolge,
    // in der die Variablen im CSS stehen.
    const ausLinks = await Promise.all(links.map(async (u) => {
      let url
      try { url = new URL(String(u), location.href) } catch { return [] }
      if (url.origin !== location.origin || !url.pathname.startsWith('/vorschau/')) return []
      try {
        const css = (await (await fetch(url, { cache: 'no-store' })).text()).slice(0, 500_000)
        return [...css.matchAll(AUS_CSS)].map((m) => m[1])
      } catch { return [] } // dann eben ohne diese Datei
    }))
    if (nr !== quellenNr) return
    const namen = new Set([...ausLinks.flat(), ...(Array.isArray(daten.namen) ? daten.namen : []).filter((n) => typeof n === 'string')])
    anSeite({ typ: 'variablenFragen', namen: [...namen].slice(0, 400) })
  }

  function variablenErhalten(liste) {
    const neuRegler = []
    for (const v of Array.isArray(liste) ? liste : []) {
      if (typeof v?.name !== 'string' || typeof v?.wert !== 'string') continue
      const r = reglerEinordnen({ name: v.name.slice(0, 62), wert: v.wert.slice(0, 120) })
      if (r) neuRegler.push(r)
    }
    neuRegler.sort((a, b) => REIHENFOLGE[a.art] - REIHENFOLGE[b.art])
    regler = neuRegler.slice(0, 48)
    // Nach dem Neuladen: was Claude schon in die Datei geschrieben hat, ist
    // erledigt; der Rest gilt weiter und wird wieder gesetzt.
    for (const [name, a] of aenderungen) {
      const r = regler.find((x) => x.name === name)
      if (!r || r.wert === a.neu) { aenderungen.delete(name); continue }
      a.vorher = r.wert
      anSeite({ typ: 'reglerSetzen', name, wert: a.neu })
    }
    reglerZeichnen()
  }

  function reglerZeichnen() {
    reglerKnopf.hidden = !regler.length
    if (!regler.length && reglerOffen) reglerZu()
    reglerListe.replaceChildren(...regler.map(reglerZeile))
    reglerUebernehmenKnopf.disabled = !aenderungen.size
    reglerZurueckKnopf.disabled = !aenderungen.size
  }

  function reglerZeile(r) {
    const a = aenderungen.get(r.name)
    const wertEl = h('output.regler-wert', {}, a?.neu ?? r.wert)
    let feld
    if (r.art === 'farbe') {
      feld = h('input.regler-farbe', { type: 'color', value: a?.hex ?? r.hex })
      feld.addEventListener('input', () => reglerSetzen(r, r.alpha < 1 ? mitAlpha(feld.value, r.alpha) : feld.value, wertEl, feld.value))
    } else {
      feld = h('input.regler-schieber', { type: 'range', min: String(r.min), max: String(r.max), step: String(r.schritt) })
      feld.value = String(a ? parseFloat(a.neu) : r.zahl)
      feld.addEventListener('input', () => reglerSetzen(r, `${zahlText(feld.value)}${r.einheit}`, wertEl))
    }
    feld.setAttribute('aria-label', r.name)
    return h('label.regler-zeile', { title: `${r.name}: ${r.wert}` }, h('span.regler-name', {}, r.name.slice(2)), feld, wertEl)
  }

  function reglerSetzen(r, wert, wertEl, hex) {
    if (wert === r.wert) aenderungen.delete(r.name)
    else aenderungen.set(r.name, { vorher: r.wert, neu: wert, hex })
    anSeite({ typ: 'reglerSetzen', name: r.name, wert })
    wertEl.textContent = wert
    reglerUebernehmenKnopf.disabled = !aenderungen.size
    reglerZurueckKnopf.disabled = !aenderungen.size
  }

  function reglerZuruecksetzen() {
    anSeite({ typ: 'reglerZurueck', namen: [...aenderungen.keys()] })
    aenderungen.clear()
    reglerZeichnen()
  }

  function reglerUebernehmen() {
    if (!aenderungen.size) return
    const d = datei()
    const teile = [...aenderungen].map(([n, a]) => `\`${n}\` ${a.vorher} → ${a.neu}`)
    beiKommentar?.(`Zur Vorschau \`${d?.name ?? 'Seite'}\`, Regler: ${teile.join(', ')}. Bitte genau diese Werte in die Datei übernehmen.`)
    melden('Die Werte stehen im Eingabefeld. Schick sie ab, dann schreibt Claude sie in die Datei.', 'info')
    // In der Seite bleiben sie stehen; sie sind ab jetzt der Ausgangswert.
    for (const [n, a] of aenderungen) {
      const r = regler.find((x) => x.name === n)
      if (r) Object.assign(r, reglerEinordnen({ name: n, wert: a.neu }) ?? {})
    }
    aenderungen.clear()
    reglerZeichnen()
  }

  function reglerAuf() {
    if (!regler.length) return
    if (waehlen) { waehlenSetzen(false); kommentarZu() }
    reglerOffen = true
    reglerBox.hidden = false
    reglerKnopf.setAttribute('aria-pressed', 'true')
  }

  function reglerZu() {
    reglerOffen = false
    reglerBox.hidden = true
    reglerKnopf.setAttribute('aria-pressed', 'false')
  }

  addEventListener('message', (ev) => {
    if (ev.source !== rahmen.contentWindow || !ev.data?.cockpitVorschau) return
    if (ev.data.typ === 'bereit') {
      // Nach jedem Neuladen weiss die Seite nichts vom Waehl-Modus und kennt
      // das gewaehlte Element nicht mehr (der Kommentar dazu gilt weiter).
      if (gewaehlt) { gewaehlt.bearbeitbar = false; textModusSetzen(false) }
      if (waehlen) waehlenSetzen(true)
    } else if (ev.data.typ === 'quellen') {
      quellenLesen(ev.data)
    } else if (ev.data.typ === 'variablen') {
      variablenErhalten(ev.data.liste)
    } else if (ev.data.typ === 'text' && textModus) {
      neuText = String(ev.data.neu ?? '').slice(0, 600)
    } else if (ev.data.typ === 'gewaehlt' && waehlen && !textModus) {
      gewaehlt = {
        selektor: String(ev.data.selektor ?? '').slice(0, 200), text: String(ev.data.text ?? '').slice(0, 90), tag: String(ev.data.tag ?? ''),
        bearbeitbar: ev.data.bearbeitbar === true, volltext: String(ev.data.volltext ?? '').slice(0, 600),
      }
      leeren(zielEl, h('span', {}, 'Element: '), h('code', {}, gewaehlt.selektor), gewaehlt.text ? h('span.leise', {}, ` „${gewaehlt.text}“`) : null)
      textModusSetzen(false)
      kommentarBox.hidden = false
      tipp.hidden = true
      kommentarFeld.focus()
    }
  })

  schliessenKnopf.addEventListener('click', schliessen)
  neuKnopf.addEventListener('click', rahmenLaden)
  waehlKnopf.addEventListener('click', () => { if (waehlen) { waehlenSetzen(false); kommentarZu() } else { reglerZu(); waehlenSetzen(true) } })
  reglerKnopf.addEventListener('click', () => { if (reglerOffen) reglerZu(); else reglerAuf() })
  handyKnopf.addEventListener('click', () => {
    const an = !el.classList.contains('handy')
    el.classList.toggle('handy', an)
    handyKnopf.setAttribute('aria-pressed', String(an))
  })
  dateiWahl.addEventListener('change', () => {
    kommentarZu()
    seiteSetzen(dateiWahl.value)
    zeichnen()
    rahmenLaden()
  })
  kommentarFeld.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); kommentarUebernehmen() }
  })
  // Esc schliesst erst den Kommentar, dann die Vorschau. Am window im
  // Capture, also vor allen anderen: sonst hielte dasselbe Esc Claude an
  // (chat.js) oder schaltete das Diktat aus (eingabe.js, document/Capture).
  // Nur, wenn die Vorschau wirklich zu sehen ist und kein Dialog offen ist.
  addEventListener('keydown', (ev) => {
    if (!offen || ev.key !== 'Escape' || !el.getClientRects().length || document.querySelector('dialog[open]')) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    if (!kommentarBox.hidden) kommentarZu()
    else if (reglerOffen) reglerZu()
    else schliessen()
  }, true)

  return { el, leiste, laden, zuruecksetzen, oeffnen, schliessen, geschrieben, istHtml: (p) => typeof p === 'string' && HTML.test(p) }
}
