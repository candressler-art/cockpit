/**
 * Eingabefeld der Chat-Ansicht mit Ordner-, Modell-, Denkaufwand- und
 * Moduswahl. Kennt keinen Chat: es meldet nur, was gesendet werden soll,
 * und chat.js entscheidet, ob daraus ein neuer Chat oder ein weiterer Zug wird.
 */
import { h, symbol, api, pfadKurz, melden, fehlerText } from './dom.js'
import * as bus from '../bus.js'
import { istBild } from './anhangtext.js'

/** Wie src/anhaenge.ts -- vorher pruefen spart den Upload, der ohnehin abgelehnt wuerde. */
const MAX_ANHANG_BYTES = 20 * 1024 * 1024
const MAX_ANHAENGE = 10
/** Nur Anhaenge, kein Text: damit der Agent weiss, was er tun soll. */
const NUR_ANHANG_TEXT = 'Sieh dir die angehängten Dateien an.'

/** Einstellungen + Auswahllisten aus /api/einstellungen, einmal geladen und bei WS-Aenderung nachgezogen. */
let vorgaben = null
let vorgabenLaden = null
export function einstellungenHolen(neu = false) {
  if (!vorgabenLaden || neu) {
    vorgabenLaden = api('/api/einstellungen').then((d) => (vorgaben = d)).catch((e) => {
      vorgabenLaden = null
      throw e
    })
  }
  return vorgabenLaden
}
bus.abonnieren('einstellungen', (werte) => { if (vorgaben) vorgaben.werte = werte })

/**
 * @param opt.beiSenden(text, optionen)  -> Promise; bei Fehler bleibt der Text stehen
 * @param opt.beiStopp()
 */
export function eingabeBauen(opt) {
  // Auswahl dieser Ansicht. null heisst "Vorgabe aus den Einstellungen".
  const wahl = { cwd: null, modell: null, aufwand: null, berechtigung: null }
  let ordnerFest = null // bei bestehenden Chats: der Ordner steht fest
  let laeuft = false
  /** {name, groesse, pfad (nach dem Hochladen), fehler, vorschau (Object-URL bei Bildern)} */
  let anhaenge = []

  const feld = h('textarea.eingabe-feld', {
    rows: 1, placeholder: 'Schreib Claude eine Nachricht …', 'aria-label': 'Nachricht',
    enterkeyhint: 'send',
  })
  // Beim Diktat liegt die Schrift in diesem Spiegel unter dem (dann
  // durchsichtig schreibenden) Feld: eine textarea kann keinen Teil ihres
  // Textes grau faerben. Siehe spiegelZeichnen().
  const spiegel = h('div.feld-spiegel', { 'aria-hidden': 'true' })
  const sendeKnopf = h('button.senden', { type: 'button', title: 'Senden (Enter)', 'aria-label': 'Senden' }, symbol('senden', 18))
  const ordnerKnopf = h('button.chip.ordner-chip', { type: 'button', title: 'Projektordner' })
  const modellWahl = h('select.chip', { 'aria-label': 'Modell', title: 'Modell' })
  const aufwandWahl = h('select.chip', { 'aria-label': 'Denkaufwand', title: 'Denkaufwand' })
  const modusWahl = h('select.chip', { 'aria-label': 'Berechtigungen', title: 'Berechtigungen' })
  const klammerKnopf = h('button.chip.rund', { type: 'button', title: 'Dateien anhängen (auch hineinziehen oder einfügen)', 'aria-label': 'Dateien anhängen' }, symbol('klammer', 15))
  const dateiWahl = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1' })
  const anhangListe = h('div.eingabe-anhaenge', { hidden: true })
  const mikroKnopf = h('button.chip.rund', { type: 'button', title: 'Diktieren', 'aria-label': 'Diktieren', 'aria-pressed': 'false' }, symbol('mikro', 15))

  // Am Handy passen vier Auswahlfelder nicht in eine Zeile. Dort stehen
  // Modell, Denken und Modus hinter einem Chip, der ihre Kurzform zeigt und
  // sie beim Antippen aufklappt (nur per CSS unterschieden, siehe stil.css).
  const optionenKnopf = h('button.chip.optionen-chip', { type: 'button', 'aria-expanded': 'false', title: 'Modell, Denken, Berechtigungen' })
  const optionen = h('div.eingabe-optionen', {}, modellWahl, aufwandWahl, modusWahl)
  const diktat = diktatLeisteBauen()
  const el = h('div.eingabe', {},
    h('div.eingabe-rahmen', {},
      anhangListe,
      h('div.feld-huelle', {}, spiegel, feld),
      h('div.eingabe-leiste', {},
        ordnerKnopf, optionenKnopf, optionen,
        h('span.spacer'), klammerKnopf, dateiWahl, mikroKnopf, sendeKnopf),
      diktat.el),
    diktat.ansage)
  optionenKnopf.addEventListener('click', () => {
    const auf = !el.classList.contains('optionen-offen')
    el.classList.toggle('optionen-offen', auf)
    optionenKnopf.setAttribute('aria-expanded', String(auf))
  })
  function optionenKurz() {
    const text = (sel) => sel.selectedOptions[0]?.textContent ?? ''
    const modus = modusWahl.value
    // Die Denkstufe als eigener Teil: am schmalen Handy blendet stil.css sie aus,
    // damit Ordner und Senden-Knopf daneben passen (aufgeklappt steht sie voll da).
    optionenKnopf.replaceChildren(h('span', {}, text(modellWahl)),
      aufwandWahl.disabled ? null : h('span.opt-aufwand', {}, `· ${text(aufwandWahl).replace(/^Denken: /, '')}`))
    // Ein anderer Modus als "Nachfragen" soll auffallen, auch zugeklappt.
    if (modus && modus !== 'default') optionenKnopf.append(h(`span.modus-marke${modus === 'bypassPermissions' ? '.alles' : ''}`, { title: text(modusWahl) }, symbol('schild', 12)))
  }
  for (const sel of [modellWahl, aufwandWahl, modusWahl]) sel.addEventListener('change', optionenKurz)

  function groesse() {
    feld.style.height = 'auto'
    feld.style.height = `${Math.min(feld.scrollHeight, Math.round(innerHeight * 0.4))}px`
  }
  feld.addEventListener('input', () => {
    // Waehrend des Diktats: was Can tippt, gehoert ihm -- die Erkennung
    // schreibt danach dahinter weiter (diktat.js).
    if (laufend) { laufend.eingabe(); spiegelZeichnen() }
    groesse()
    knopfZustand()
  })
  feld.addEventListener('scroll', () => { spiegel.scrollTop = feld.scrollTop })
  feld.addEventListener('keydown', (ev) => {
    // Enter sendet, Shift+Enter bricht um. Auf dem Handy nicht: dort gibt es
    // kein Shift, Enter ist dort der Zeilenumbruch und gesendet wird per Knopf.
    const handy = matchMedia('(pointer: coarse)').matches
    if (ev.key === 'Enter' && !ev.shiftKey && !handy && !ev.isComposing) {
      ev.preventDefault()
      // Waehrend des Diktats heisst Enter "Mikro aus", nicht "senden": der
      // Rest des Textes kaeme sonst erst nach der Nachricht an.
      if (diktatZustand !== 'aus') { diktatHaupt(); return }
      senden()
    }
  })

  function knopfZustand() {
    const leer = !feld.value.trim() && !anhaenge.length
    const laedt = anhaenge.some((a) => !a.pfad && !a.fehler)
    sendeKnopf.replaceChildren(symbol(laeuft && leer ? 'stopp' : 'senden', 18))
    sendeKnopf.title = laeuft && leer ? 'Anhalten' : laedt ? 'Anhänge laden noch …' : 'Senden (Enter)'
    sendeKnopf.setAttribute('aria-label', sendeKnopf.title)
    sendeKnopf.classList.toggle('stopp', laeuft && leer)
    sendeKnopf.disabled = (!laeuft && leer) || (!leer && laedt)
  }

  // --- Anhaenge -------------------------------------------------------------
  // Jede Datei geht sofort an den Daemon (POST /api/anhaenge), beim Senden
  // nur noch ihr Pfad. Der Agent liest sie dort mit Read (src/anhaenge.ts).
  function anhaengeZeichnen() {
    anhangListe.hidden = !anhaenge.length
    anhangListe.replaceChildren(...anhaenge.map((a) => {
      const weg = h('button.anhang-weg', { type: 'button', title: `${a.name} entfernen`, 'aria-label': `${a.name} entfernen` }, symbol('kreuz', 12))
      weg.addEventListener('click', () => anhangEntfernen(a))
      const zustand = a.fehler ? 'fehler' : a.pfad ? 'fertig' : 'laedt'
      return h(`div.anhang.${zustand}`, { title: a.fehler ? `${a.name}: ${a.fehler}` : a.name },
        a.vorschau ? h('img.anhang-bild', { src: a.vorschau, alt: '' }) : h('span.anhang-symbol', {}, symbol('datei', 16)),
        h('span.anhang-name', {}, a.name),
        a.fehler ? h('span.anhang-info', {}, 'Fehler') : !a.pfad ? h('span.anhang-info', {}, '…') : null,
        weg)
    }))
    knopfZustand()
  }
  function anhangEntfernen(a) {
    if (a.vorschau) URL.revokeObjectURL(a.vorschau)
    anhaenge = anhaenge.filter((x) => x !== a)
    anhaengeZeichnen()
  }
  function anhaengeLeeren() {
    for (const a of anhaenge) if (a.vorschau) URL.revokeObjectURL(a.vorschau)
    anhaenge = []
    anhaengeZeichnen()
  }
  async function dateienHinzufuegen(dateien) {
    for (const d of dateien) {
      if (anhaenge.length >= MAX_ANHAENGE) { melden(`Höchstens ${MAX_ANHAENGE} Anhänge je Nachricht.`, 'info'); break }
      // Eingefuegte Bildschirmfotos heissen im Browser nur "image.png".
      const name = d.name || `bild.${(d.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
      const a = { name, groesse: d.size, pfad: null, fehler: null, vorschau: istBild(name) ? URL.createObjectURL(d) : null }
      anhaenge.push(a)
      if (d.size > MAX_ANHANG_BYTES) a.fehler = 'größer als 20 MB'
      else if (!d.size) a.fehler = 'leer'
      anhaengeZeichnen()
      if (a.fehler) continue
      fetch(bus.api(`/api/anhaenge?name=${encodeURIComponent(name)}`), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: d })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(j?.fehler ?? `HTTP ${r.status}`)
          a.pfad = j.pfad
        })
        .catch((e) => { a.fehler = fehlerText(e) })
        .finally(anhaengeZeichnen)
    }
  }
  klammerKnopf.addEventListener('click', () => dateiWahl.click())
  dateiWahl.addEventListener('change', () => { dateienHinzufuegen([...dateiWahl.files]); dateiWahl.value = '' })
  feld.addEventListener('paste', (ev) => {
    const dateien = [...(ev.clipboardData?.files ?? [])]
    if (!dateien.length) return
    ev.preventDefault()
    dateienHinzufuegen(dateien)
  })
  // Hineinziehen: ueberall auf die Eingabe. Der Zaehler faengt dragleave ab,
  // das beim Wechsel auf ein Kindelement feuert.
  let ziehTiefe = 0
  const zieheDateien = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files')
  el.addEventListener('dragenter', (ev) => { if (!zieheDateien(ev)) return; ev.preventDefault(); ziehTiefe++; el.classList.add('ziehen') })
  el.addEventListener('dragover', (ev) => { if (zieheDateien(ev)) ev.preventDefault() })
  el.addEventListener('dragleave', () => { if (ziehTiefe && !--ziehTiefe) el.classList.remove('ziehen') })
  el.addEventListener('drop', (ev) => {
    if (!zieheDateien(ev)) return
    ev.preventDefault()
    ziehTiefe = 0
    el.classList.remove('ziehen')
    dateienHinzufuegen([...ev.dataTransfer.files])
  })

  async function senden() {
    const text = feld.value.trim() || (anhaenge.length ? NUR_ANHANG_TEXT : '')
    if (!text) {
      if (laeuft) opt.beiStopp?.()
      return
    }
    if (laeuft) {
      melden('Claude arbeitet noch -- warte auf das Ende oder halte an.', 'info')
      return
    }
    if (anhaenge.some((a) => !a.pfad && !a.fehler)) return
    if (anhaenge.some((a) => a.fehler)) {
      melden('Ein Anhang ist fehlgeschlagen -- entferne ihn, bevor du sendest.', 'fehler')
      return
    }
    const w = vorgaben?.werte ?? {}
    const optionen = {
      cwd: ordnerFest ? undefined : (wahl.cwd ?? w.arbeitsordner),
      modell: modellWahl.value || undefined,
      aufwand: aufwandWahl.disabled ? undefined : (aufwandWahl.value || undefined),
      berechtigung: modusWahl.value || undefined,
      ...(anhaenge.length ? { anhaenge: anhaenge.map((a) => a.pfad) } : {}),
    }
    sendeKnopf.disabled = true
    // Waehrend des Sendens kein Diktat beginnen: das Feld wird danach geleert,
    // und ein Diktat, das den alten Text kennt, schriebe ihn zurueck.
    mikroKnopf.disabled = true
    try {
      await opt.beiSenden(text, optionen)
      feld.value = ''
      anhaengeLeeren()
      groesse()
    } catch (e) {
      melden(`Senden fehlgeschlagen: ${fehlerText(e)}`, 'fehler')
    } finally {
      mikroKnopf.disabled = false
      knopfZustand()
    }
  }
  sendeKnopf.addEventListener('click', senden)

  // --- Auswahllisten --------------------------------------------------------
  function listenFuellen() {
    if (!vorgaben) return
    const w = vorgaben.werte
    const fuellen = (sel, liste, aktuell) => {
      sel.replaceChildren(...liste.map((x) => h('option', { value: x.id, title: x.hinweis ?? '' }, x.name)))
      sel.value = aktuell
    }
    fuellen(modellWahl, vorgaben.modelle, wahl.modell ?? w.modell)
    fuellen(aufwandWahl, vorgaben.aufwaende.map((a) => ({ ...a, name: `Denken: ${a.name}` })), wahl.aufwand ?? w.aufwand)
    fuellen(modusWahl, vorgaben.berechtigungen, wahl.berechtigung ?? w.berechtigung)
    aufwandPruefen()
    ordnerZeigen()
    optionenKurz()
  }
  // Haiku kennt keine Denkstufen (siehe chatOptionen.ts) -- dann ausgrauen
  // statt still zu ignorieren.
  function aufwandPruefen() {
    const haiku = /haiku/.test(modellWahl.value)
    aufwandWahl.disabled = haiku
    aufwandWahl.title = haiku ? 'Haiku hat keine Denkstufen' : 'Denkaufwand'
  }
  modellWahl.addEventListener('change', () => { wahl.modell = modellWahl.value; aufwandPruefen(); optionenKurz() })
  aufwandWahl.addEventListener('change', () => { wahl.aufwand = aufwandWahl.value })
  modusWahl.addEventListener('change', () => { wahl.berechtigung = modusWahl.value })

  function ordnerZeigen() {
    const p = ordnerFest ?? wahl.cwd ?? vorgaben?.werte.arbeitsordner ?? ''
    ordnerKnopf.replaceChildren(symbol('ordner', 14), h('span', {}, pfadKurz(p) || 'Ordner'))
    ordnerKnopf.title = ordnerFest ? `Projektordner: ${p} (steht fuer diesen Chat fest)` : `Projektordner: ${p}`
    ordnerKnopf.disabled = Boolean(ordnerFest)
  }
  ordnerKnopf.addEventListener('click', () => {
    ordnerWaehlen(wahl.cwd ?? vorgaben?.werte.arbeitsordner, (p) => { wahl.cwd = p; ordnerZeigen() })
  })

  // --- Diktieren (diktat.js: Vosk live, Whisper schreibt sauber) -------------
  // Zustaende (Klasse an .eingabe):
  //   aus       Knopfreihe wie immer
  //   oeffnet   Mikro geht auf / Browser fragt -- neutral, noch NICHT sprechen
  //   hoert     ab dem ersten echten Audioblock: roter Punkt, Live-Pegel, Zeit.
  //             Der Text steht schon grau im Feld, tippen geht. Kein
  //             automatisches Ende: Can schaltet das Mikro selbst aus.
  //   schreibt  Mikro zu, Whisper schreibt die letzten Saetze sauber, dann
  //             wird der Text normal ("Sofort uebernehmen" wartet nicht).
  // Waehrend des Diktats ersetzt die Leiste die Knopfreihe: Senden mit halb
  // erkanntem Text waere ein Versehen. Nach jedem Ende ist das Mikrofon zu.
  let diktatZustand = 'aus'
  let laufend = null // Steuerung aus diktat.js
  // Jeder Start und jeder Abbruch waehrend des Ladens zaehlt hoch: ein Start,
  // der nach dem Laden der Module eine andere Nummer sieht, ist ueberholt --
  // sonst liefen nach "abbrechen, sofort neu" zwei Diktate zugleich.
  let diktatNr = 0
  let pegelMod = null
  let bildNr = 0
  let gewarnt = false
  let ohneVorschau = false
  let whisperGemeldet = false
  const ruhig = matchMedia('(prefers-reduced-motion: reduce)')
  const handy = () => matchMedia('(pointer: coarse)').matches
  const PLATZHALTER = feld.placeholder
  const HINWEIS_HOERT = 'Pausen sind okay – Mikro aus, wenn du fertig bist'
  const HINWEIS_OHNE = 'Ohne Live-Vorschau: der Text kommt satzweise'

  function diktatLeisteBauen() {
    const marke = h('span.diktat-marke', { 'aria-hidden': 'true' })
    const text = h('span.diktat-text')
    const zeit = h('span.diktat-zeit', { 'aria-hidden': 'true' })
    const pegel = h('canvas.diktat-pegel', { 'aria-hidden': 'true', width: 1, height: 1 })
    const hinweis = h('span.diktat-hinweis')
    const verwerfen = h('button.knopf.diktat-abbrechen', { type: 'button', title: 'Gesprochenes verwerfen (Getipptes bleibt)', 'aria-label': 'Gesprochenes verwerfen' },
      symbol('kreuz', 15), h('span', {}, 'Verwerfen'))
    const haupt = h('button.knopf.primaer.diktat-fertig', { type: 'button' })
    const el = h('div.diktat', { hidden: true },
      h('div.diktat-stand', {}, marke, text, zeit, pegel),
      h('div.diktat-aktion', {}, hinweis, verwerfen, haupt))
    // Immer im Baum, auch wenn die Leiste versteckt ist -- eine Live-Region,
    // die erst mit ihrem Inhalt auftaucht, lesen Screenreader oft nicht vor.
    const ansage = h('div.sr-nur', { role: 'status', 'aria-live': 'polite' })
    return { el, ansage, marke, text, zeit, pegel, hinweis, verwerfen, haupt }
  }

  /** Nur schreiben, wenn sich etwas aendert -- der Stand kommt alle 100 ms. */
  const setzen = (knoten, wert) => { if (knoten.textContent !== wert) knoten.textContent = wert }
  const dauer = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const ansagen = (t) => { diktat.ansage.textContent = ''; setTimeout(() => { diktat.ansage.textContent = t }, 50) }

  function hauptKnopf(sym, text, titel) {
    diktat.haupt.replaceChildren(symbol(sym, 15), h('span', {}, text))
    diktat.haupt.title = titel
    diktat.haupt.setAttribute('aria-label', text)
  }

  function zustandSetzen(z) {
    diktatZustand = z
    const an = z !== 'aus'
    el.classList.toggle('diktat-an', an)
    for (const k of ['oeffnet', 'hoert', 'schreibt']) el.classList.toggle(`diktat-${k}`, z === k)
    diktat.el.hidden = !an
    diktat.el.classList.remove('warnt')
    diktat.zeit.classList.remove('warnt')
    mikroKnopf.setAttribute('aria-pressed', String(an))
    feld.placeholder = an ? 'Sprich einfach los – der Text erscheint hier …' : PLATZHALTER
    if (z === 'oeffnet') {
      diktat.marke.replaceChildren(symbol('mikro', 15))
      setzen(diktat.text, 'Mikro wird geöffnet …')
      setzen(diktat.zeit, '')
      setzen(diktat.hinweis, 'Falls der Browser fragt: Mikrofon erlauben.')
      hauptKnopf('mikro', 'Mikro aus', 'Mikro ausschalten (Enter oder Esc)')
    } else if (z === 'hoert') {
      diktat.marke.replaceChildren(h('span.diktat-punkt'))
      setzen(diktat.text, 'Jetzt sprechen')
      setzen(diktat.zeit, '0:00')
      setzen(diktat.hinweis, ohneVorschau ? HINWEIS_OHNE : HINWEIS_HOERT)
      hauptKnopf('mikro', 'Mikro aus', 'Mikro ausschalten (Enter oder Esc)')
    } else if (z === 'schreibt') {
      diktat.marke.replaceChildren(h('span.kreisel'))
      setzen(diktat.text, 'Wird sauber geschrieben …')
      setzen(diktat.zeit, '')
      setzen(diktat.hinweis, 'Der graue Text wird gleich übernommen.')
      hauptKnopf('haken', 'Sofort übernehmen', 'Nicht warten, grauen Text so übernehmen (Enter oder Esc)')
    }
    spiegelZeichnen()
    if (an) {
      document.addEventListener('keydown', escTaste, true)
      if (z === 'hoert' || z === 'oeffnet') pegelLaufen()
    } else {
      document.removeEventListener('keydown', escTaste, true)
      knopfZustand()
    }
  }

  /**
   * Feldinhalt in den Spiegel: bis zum Beginn des Diktats normal, danach grau.
   * Die Masse kommen vom Feld selbst, auch die Breite einer Bildlaufleiste --
   * sonst bricht der Spiegel an anderer Stelle um als der Cursor laeuft.
   */
  function spiegelZeichnen() {
    if (diktatZustand === 'aus' || !laufend) { spiegel.replaceChildren(); return }
    const ab = Math.min(laufend.grauAb(), feld.value.length)
    spiegel.replaceChildren(feld.value.slice(0, ab), h('span.vorlaeufig', {}, feld.value.slice(ab)), '​')
    const cs = getComputedStyle(feld)
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingBottom']) spiegel.style[k] = cs[k]
    const leiste = feld.offsetWidth - feld.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)
    spiegel.style.paddingRight = `${parseFloat(cs.paddingRight) + Math.max(0, leiste)}px`
    spiegel.scrollTop = feld.scrollTop
  }

  /** Laufender Stand aus hoeren.js: Zeit, "gehoert?", nahende Obergrenze. */
  function standZeigen(st) {
    if (diktatZustand !== 'hoert') return
    setzen(diktat.zeit, dauer(st.ms))
    const bald = st.restMs < 30_000
    diktat.zeit.classList.toggle('warnt', bald)
    let text = st.gehoert ? 'Ich höre zu' : 'Jetzt sprechen'
    let hinweis = ohneVorschau ? HINWEIS_OHNE : HINWEIS_HOERT
    let warnt = false
    if (!st.gehoert && st.ms > 5000) {
      // Leises Mikro: soll man merken und nicht ins Leere reden.
      text = 'Noch nichts gehört'
      hinweis = 'Lauter oder näher ans Mikro sprechen'
      warnt = true
      if (!gewarnt) { gewarnt = true; ansagen('Noch nichts gehört. Lauter sprechen.') }
    }
    if (bald) hinweis = `Mikro geht in ${Math.ceil(st.restMs / 1000)} s aus – höchstens 10 Minuten am Stück`
    diktat.el.classList.toggle('warnt', warnt)
    setzen(diktat.text, text)
    setzen(diktat.hinweis, hinweis)
  }

  /** Echter Pegel je Bild (sprachpegel.js), solange aufgenommen wird. */
  function pegelLaufen() {
    if (bildNr) return
    const farbe = getComputedStyle(el).getPropertyValue('--rot').trim() || '#f38ba8'
    const bild = (jetzt) => {
      bildNr = 0
      if (diktatZustand !== 'hoert' && diktatZustand !== 'oeffnet') return
      // Ansicht gewechselt oder Eingabe verschwunden: nicht unsichtbar
      // weiter mithoeren. Der Text bleibt, wie er dasteht.
      if (!el.isConnected || !el.offsetParent) { laufend?.anhalten(); return }
      if (diktatZustand === 'hoert' && pegelMod) {
        const cv = diktat.pegel
        const dpr = devicePixelRatio || 1
        const b = Math.round(cv.clientWidth * dpr)
        const hh = Math.round(cv.clientHeight * dpr)
        if (b && hh && (cv.width !== b || cv.height !== hh)) { cv.width = b; cv.height = hh }
        pegelMod.messen(jetzt)
        pegelMod.wellenformZeichnen(cv, farbe, { ruhig: ruhig.matches })
      }
      bildNr = requestAnimationFrame(bild)
    }
    bildNr = requestAnimationFrame(bild)
  }

  function escTaste(ev) {
    if (ev.key !== 'Escape' || diktatZustand === 'aus' || document.querySelector('dialog[open]')) return
    // Vor chat.js abfangen: dort haelt Esc den laufenden Claude an -- wer das
    // Mikro ausschaltet, meint nicht das. Esc verwirft nichts: eine Minute
    // Diktat per Versehen weg waere schlimmer als ein Knopf mehr.
    ev.preventDefault()
    ev.stopPropagation()
    diktatHaupt()
  }

  const MIKRO_FEHLER = {
    NotAllowedError: 'Kein Zugriff aufs Mikrofon. Erlaube es in den Browser-Einstellungen für diese Seite.',
    SecurityError: 'Kein Zugriff aufs Mikrofon. Erlaube es in den Browser-Einstellungen für diese Seite.',
    NotFoundError: 'Kein Mikrofon gefunden.',
    OverconstrainedError: 'Kein passendes Mikrofon gefunden.',
    NotReadableError: 'Das Mikrofon lässt sich nicht öffnen – benutzt es gerade ein anderes Programm?',
    unsicher: 'Das Mikrofon geht hier nur über HTTPS.',
  }

  async function diktatStarten() {
    if (diktatZustand !== 'aus' || mikroKnopf.disabled) return
    const nr = ++diktatNr
    gewarnt = false
    ohneVorschau = false
    whisperGemeldet = false
    zustandSetzen('oeffnet')
    // Am Desktop bleibt der Cursor im Feld -- tippen soll jederzeit gehen.
    // Am Handy nicht: die Tastatur schoebe sich ueber den Text.
    if (handy()) diktat.haupt.focus()
    else feld.focus()
    ansagen('Mikrofon wird geöffnet.')
    let diktatMod
    try {
      ;[diktatMod, pegelMod] = await Promise.all([import('../diktat.js'), import('../sprachpegel.js')])
    } catch (e) {
      if (nr !== diktatNr) return
      zustandSetzen('aus')
      melden(`Diktieren geht gerade nicht: ${fehlerText(e)}`, 'fehler')
      return
    }
    if (nr !== diktatNr || diktatZustand !== 'oeffnet') return
    laufend = diktatMod.diktatStarten(feld, {
      beiZustand: (z) => {
        if (z === 'aus') return diktatEnde()
        zustandSetzen(z)
        if (z === 'hoert') ansagen('Aufnahme läuft. Jetzt sprechen.')
        if (z === 'schreibt') ansagen('Mikro aus. Der Text wird sauber geschrieben.')
      },
      beiStand: standZeigen,
      beiText: () => { groesse(); knopfZustand(); spiegelZeichnen() },
      beiHinweis: (art) => {
        if (art === 'ohne-vorschau') {
          ohneVorschau = true
          if (diktatZustand === 'hoert') setzen(diktat.hinweis, HINWEIS_OHNE)
        } else if (art === 'whisper-gestoert' && !whisperGemeldet) {
          whisperGemeldet = true
          melden('Die genaue Erkennung antwortet gerade nicht – der graue Text bleibt, wie er ist.', 'info')
        } else if (art === 'max') {
          melden('Mikro nach 10 Minuten automatisch ausgeschaltet.', 'info')
        } else if (art === 'verloren') {
          melden('Ein Stück wurde nicht erkannt – bitte noch einmal sagen.', 'fehler')
        }
      },
      beiFehler: (grund, fehler) => {
        const text = {
          'kein-mikro': MIKRO_FEHLER[fehler] ?? 'Das Mikrofon ist nicht verfügbar.',
          'kein-ton': 'Das Mikrofon liefert keinen Ton – noch einmal versuchen.',
          belegt: 'Das Mikrofon ist noch belegt – gleich noch einmal versuchen.',
        }[grund] ?? `Diktieren geht gerade nicht: ${fehler ?? 'unbekannter Fehler'}`
        melden(text, grund === 'kein-ton' || grund === 'belegt' ? 'info' : 'fehler')
      },
    })
  }

  /** Nach jedem Ende: Leiste weg, Schrift normal, Fokus dorthin, wo man weitermacht. */
  function diktatEnde() {
    const hatteFokus = diktat.el.contains(document.activeElement) || document.activeElement === feld
    laufend = null
    zustandSetzen('aus')
    groesse()
    if (hatteFokus) {
      if (handy()) mikroKnopf.focus({ preventScroll: true })
      else { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length) }
    }
    ansagen('Diktat beendet.')
  }

  /** Hauptknopf, Enter und Esc: erst Mikro aus, dann "sofort uebernehmen". */
  function diktatHaupt() {
    if (!laufend) { if (diktatZustand === 'oeffnet') { diktatNr++; zustandSetzen('aus') } return }
    if (diktatZustand === 'schreibt') laufend.sofort()
    else void laufend.aus()
  }

  mikroKnopf.addEventListener('click', diktatStarten)
  diktat.haupt.addEventListener('click', diktatHaupt)
  diktat.verwerfen.addEventListener('click', () => {
    if (laufend) laufend.verwerfen()
    else if (diktatZustand === 'oeffnet') { diktatNr++; zustandSetzen('aus') }
    ansagen('Diktat verworfen.')
  })

  einstellungenHolen().then(listenFuellen).catch(() => { /* chat.js zeigt den Ladefehler */ })
  knopfZustand()

  return {
    el,
    fokus: () => { if (!matchMedia('(pointer: coarse)').matches) feld.focus() },
    laeuftSetzen(an) { laeuft = an; el.classList.toggle('laeuft', an); knopfZustand() },
    /** Fuer bestehende Chats steht der Ordner fest (null = frei waehlbar). */
    ordnerFestlegen(p) { ordnerFest = p; ordnerZeigen() },
    textSetzen(t) { laufend?.anhalten(); feld.value = t; groesse(); knopfZustand() },
    /** Kommentar aus der Vorschau: unten anfuegen, Getipptes bleibt stehen. */
    textAnhaengen(t) { laufend?.anhalten(); feld.value = feld.value.trim() ? `${feld.value.trimEnd()}\n\n${t}` : t; groesse(); knopfZustand() },
    /** Nach "Plan umsetzen" gilt der gewaehlte Modus auch fuer die naechste Nachricht (wie in Claude Code). */
    modusSetzen(m) { wahl.berechtigung = m; modusWahl.value = m; optionenKurz() },
    /**
     * Beim Oeffnen eines Chats: was er zuletzt benutzt hat (vom Server
     * gemerkt). Was fehlt, ist wieder die Vorgabe -- sonst ginge etwa "Alles
     * erlauben" eines Chats still auf den naechsten ueber.
     */
    optionenSetzen(o) {
      for (const k of ['modell', 'aufwand', 'berechtigung']) wahl[k] = o?.[k] ?? null
      listenFuellen()
    },
    neuLaden: listenFuellen,
  }
}

// --- Ordnerwahl ---------------------------------------------------------------

/** Dialog: Favoriten, zuletzt benutzte, Ordner durchblaettern. */
export function ordnerWaehlen(start, gewaehlt) {
  const liste = h('div.ordner-liste')
  const pfadZeile = h('div.ordner-pfad')
  let aktuell = start
  const dlg = h('dialog.dialog.ordner-dialog', {},
    h('div.dialog-kopf', {}, h('strong', {}, 'Projektordner wählen'),
      h('button.knopf-klein', { type: 'button', 'aria-label': 'Schliessen', onclick: () => dlg.close() }, symbol('kreuz', 16))),
    pfadZeile, liste,
    h('div.dialog-fuss', {},
      h('button.knopf', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      h('button.knopf.primaer', { type: 'button', onclick: () => { gewaehlt(aktuell); dlg.close() } }, 'Diesen Ordner nehmen')))
  dlg.addEventListener('close', () => dlg.remove())
  document.body.append(dlg)
  dlg.showModal()

  const eintrag = (p, name, sym = 'ordner', klick = () => laden(p)) =>
    h('button.ordner-eintrag', { type: 'button', onclick: klick, title: p }, symbol(sym, 15), h('span', {}, name))

  async function laden(p) {
    liste.replaceChildren(h('div.leise', {}, 'Lädt …'))
    try {
      const d = await api(`/api/verzeichnisse${p ? `?pfad=${encodeURIComponent(p)}` : ''}`)
      aktuell = d.pfad
      pfadZeile.replaceChildren(symbol('ordner', 14), h('span', {}, pfadKurz(d.pfad)))
      const teile = []
      if (d.favoriten.length || d.zuletzt.length) {
        const oben = [...new Set([...d.favoriten, ...d.zuletzt])].filter((x) => x !== d.pfad)
        if (oben.length) {
          teile.push(h('div.ordner-gruppe', {}, 'Favoriten und zuletzt benutzt'))
          for (const x of oben) teile.push(eintrag(x, pfadKurz(x), d.favoriten.includes(x) ? 'stern' : 'ordner', () => { gewaehlt(x); dlg.close() }))
        }
      }
      teile.push(h('div.ordner-gruppe', {}, 'Durchsuchen'))
      if (d.eltern) teile.push(eintrag(d.eltern, '.. (übergeordnet)', 'zurueck'))
      for (const o of d.ordner) teile.push(eintrag(o.pfad, o.name))
      if (!d.ordner.length) teile.push(h('div.leise', {}, 'Keine Unterordner.'))
      if (d.gekuerzt) teile.push(h('div.leise', {}, 'Liste gekürzt.'))
      liste.replaceChildren(...teile)
    } catch (e) {
      liste.replaceChildren(h('div.fehlertext', {}, fehlerText(e)))
    }
  }
  laden(start)
}
