/**
 * Live-Vorschau im Chat -- wie in Claude Design. HTML-Entwuerfe, die Claude
 * oder ein Spezialist in diesem Chat anlegt (Write/Edit auf eine .html-Datei),
 * erscheinen hier und laden neu, sobald sich die Seite oder eine Datei in
 * ihrem Ordner aendert (CSS, Bilder).
 *
 * "Kommentieren": In der Vorschau ein Element antippen und sagen, was anders
 * sein soll. Der Kommentar landet samt Element im Eingabefeld, gesendet wird
 * wie immer. So lassen sich mehrere Wuensche sammeln und auf einmal schicken.
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

export function vorschauBauen({ beiKommentar, beiOffen }) {
  let chatId = null
  let dateien = []      // [{ pfad, name, geaendert, url }] neueste zuerst
  let aktuell = null    // Pfad der gezeigten Datei
  let offen = false
  let waehlen = false
  let gewaehlt = null   // { selektor, text, tag } aus der Vorschau
  let neu = false       // geaendert, seit Can zuletzt hingesehen hat
  let ladeNr = 0

  const leisteText = h('span.vorschau-aufruf-text')
  const leiste = h('button.vorschau-aufruf', { type: 'button', hidden: true }, symbol('auge', 15), leisteText)
  leiste.addEventListener('click', () => oeffnen())

  const dateiWahl = h('select.chip.vorschau-datei', { 'aria-label': 'Entwurf', title: 'Entwurf' })
  const dateiName = h('span.vorschau-name')
  const schliessenKnopf = h('button.knopf-klein', { type: 'button', title: 'Vorschau schließen (Esc)', 'aria-label': 'Vorschau schließen' }, symbol('kreuz', 18))
  const handyKnopf = h('button.chip.rund.vorschau-breite', { type: 'button', title: 'In Handybreite zeigen', 'aria-label': 'In Handybreite zeigen', 'aria-pressed': 'false' }, symbol('handy', 15))
  const waehlKnopf = h('button.chip.vorschau-waehlen', { type: 'button', 'aria-pressed': 'false', title: 'Element antippen und sagen, was anders sein soll' },
    symbol('fadenkreuz', 15), h('span', {}, 'Kommentieren'))
  const neuKnopf = h('button.chip.rund', { type: 'button', title: 'Neu laden', 'aria-label': 'Neu laden' }, symbol('aktualisieren', 15))
  const extern = h('a.chip.rund', { target: '_blank', rel: 'noopener noreferrer', title: 'In neuem Tab öffnen', 'aria-label': 'In neuem Tab öffnen' }, symbol('extern', 15))
  const rahmen = h('iframe.vorschau-rahmen', {
    title: 'Live-Vorschau', sandbox: 'allow-scripts allow-forms allow-popups allow-modals', referrerpolicy: 'no-referrer',
  })
  const zielEl = h('div.vorschau-ziel')
  const kommentarFeld = h('textarea.vorschau-kommentar-feld', { rows: 2, placeholder: 'Was soll hier anders sein?', 'aria-label': 'Kommentar zum gewählten Element' })
  const kommentarBox = h('div.vorschau-kommentar', { hidden: true }, zielEl, kommentarFeld,
    h('div.vorschau-kommentar-knoepfe', {},
      h('button.knopf', { type: 'button', onclick: () => kommentarZu(true) }, 'Abbrechen'),
      h('button.knopf.primaer', { type: 'button', onclick: () => kommentarUebernehmen() }, 'Zum Chat hinzufügen')))
  const tipp = h('div.vorschau-tipp', { hidden: true }, 'Tippe in der Vorschau auf das Element, das anders werden soll.')
  const el = h('aside.vorschau', { hidden: true, 'aria-label': 'Live-Vorschau' },
    h('div.vorschau-kopf', {}, schliessenKnopf, dateiWahl, dateiName, h('span.spacer'), handyKnopf, waehlKnopf, neuKnopf, extern),
    tipp,
    h('div.vorschau-buehne', {}, rahmen),
    kommentarBox)

  const datei = () => dateien.find((d) => d.pfad === aktuell) ?? null

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
      if (!aktuell || !datei()) aktuell = dateien[0]?.pfad ?? null
      zeichnen()
    } catch { /* ohne Liste bleibt die Leiste einfach weg */ }
  }

  function zuruecksetzen() {
    ladeNr++ // eine noch laufende Liste des vorigen Chats verfaellt
    schliessen()
    chatId = null
    dateien = []
    aktuell = null
    neu = false
    zeichnen()
  }

  function rahmenLaden() {
    const d = datei()
    if (!d) return
    rahmen.src = `${d.url}?v=${Date.now()}`
  }

  function oeffnen(pfad) {
    if (pfad) aktuell = pfad
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
      if (!offen) { aktuell = pfad; neu = true; zeichnen() }
    }
    const d = datei()
    if (offen && d && (pfad === d.pfad || pfad.startsWith(ordnerVon(d.pfad)))) rahmenLaden()
    else if (!offen && d && pfad.startsWith(ordnerVon(d.pfad))) { neu = true; zeichnen() }
  }

  function waehlenSetzen(an) {
    waehlen = an
    waehlKnopf.setAttribute('aria-pressed', String(an))
    tipp.hidden = !an || !kommentarBox.hidden
    rahmen.contentWindow?.postMessage({ cockpitVorschau: true, typ: 'waehlen', an }, '*')
  }

  /** Box zu. Das Getippte bleibt stehen, ausser bei "Abbrechen" und nach dem Uebernehmen. */
  function kommentarZu(verwerfen = false) {
    kommentarBox.hidden = true
    if (verwerfen) kommentarFeld.value = ''
    gewaehlt = null
    tipp.hidden = !waehlen
  }

  function kommentarUebernehmen() {
    const t = kommentarFeld.value.trim()
    if (!t || !gewaehlt) { kommentarFeld.focus(); return }
    const d = datei()
    const wo = gewaehlt.text ? ` („${gewaehlt.text}“)` : ''
    beiKommentar?.(`Zur Vorschau \`${d?.name ?? 'Seite'}\`, Element \`${gewaehlt.selektor}\`${wo}: ${t}`)
    melden('Kommentar steht im Eingabefeld. Sammle weitere oder schließ die Vorschau und sende.', 'info')
    kommentarZu(true)
  }

  addEventListener('message', (ev) => {
    if (ev.source !== rahmen.contentWindow || !ev.data?.cockpitVorschau) return
    if (ev.data.typ === 'bereit') {
      // Nach jedem Neuladen weiss die Seite nichts vom Waehl-Modus.
      if (waehlen) waehlenSetzen(true)
    } else if (ev.data.typ === 'gewaehlt' && waehlen) {
      gewaehlt = { selektor: String(ev.data.selektor ?? '').slice(0, 200), text: String(ev.data.text ?? '').slice(0, 90), tag: String(ev.data.tag ?? '') }
      leeren(zielEl, h('span', {}, 'Element: '), h('code', {}, gewaehlt.selektor), gewaehlt.text ? h('span.leise', {}, ` „${gewaehlt.text}“`) : null)
      kommentarBox.hidden = false
      tipp.hidden = true
      kommentarFeld.focus()
    }
  })

  schliessenKnopf.addEventListener('click', schliessen)
  neuKnopf.addEventListener('click', rahmenLaden)
  waehlKnopf.addEventListener('click', () => { if (waehlen) { waehlenSetzen(false); kommentarZu() } else waehlenSetzen(true) })
  handyKnopf.addEventListener('click', () => {
    const an = !el.classList.contains('handy')
    el.classList.toggle('handy', an)
    handyKnopf.setAttribute('aria-pressed', String(an))
  })
  dateiWahl.addEventListener('change', () => { aktuell = dateiWahl.value; kommentarZu(); zeichnen(); rahmenLaden() })
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
    else schliessen()
  }, true)

  return { el, leiste, laden, zuruecksetzen, oeffnen, schliessen, geschrieben, istHtml: (p) => typeof p === 'string' && HTML.test(p) }
}
