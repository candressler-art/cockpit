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
  const sendeKnopf = h('button.senden', { type: 'button', title: 'Senden (Enter)', 'aria-label': 'Senden' }, symbol('senden', 18))
  const ordnerKnopf = h('button.chip.ordner-chip', { type: 'button', title: 'Projektordner' })
  const modellWahl = h('select.chip', { 'aria-label': 'Modell', title: 'Modell' })
  const aufwandWahl = h('select.chip', { 'aria-label': 'Denkaufwand', title: 'Denkaufwand' })
  const modusWahl = h('select.chip', { 'aria-label': 'Berechtigungen', title: 'Berechtigungen' })
  const klammerKnopf = h('button.chip.rund', { type: 'button', title: 'Dateien anhängen (auch hineinziehen oder einfügen)', 'aria-label': 'Dateien anhängen' }, symbol('klammer', 15))
  const dateiWahl = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1' })
  const anhangListe = h('div.eingabe-anhaenge', { hidden: true })
  const mikroKnopf = h('button.chip.rund', { type: 'button', title: 'Diktieren', 'aria-label': 'Diktieren' }, symbol('mikro', 15))

  // Am Handy passen vier Auswahlfelder nicht in eine Zeile. Dort stehen
  // Modell, Denken und Modus hinter einem Chip, der ihre Kurzform zeigt und
  // sie beim Antippen aufklappt (nur per CSS unterschieden, siehe stil.css).
  const optionenKnopf = h('button.chip.optionen-chip', { type: 'button', 'aria-expanded': 'false', title: 'Modell, Denken, Berechtigungen' })
  const optionen = h('div.eingabe-optionen', {}, modellWahl, aufwandWahl, modusWahl)
  const el = h('div.eingabe', {},
    h('div.eingabe-rahmen', {},
      anhangListe,
      feld,
      h('div.eingabe-leiste', {},
        ordnerKnopf, optionenKnopf, optionen,
        h('span.spacer'), klammerKnopf, dateiWahl, mikroKnopf, sendeKnopf)))
  optionenKnopf.addEventListener('click', () => {
    const auf = !el.classList.contains('optionen-offen')
    el.classList.toggle('optionen-offen', auf)
    optionenKnopf.setAttribute('aria-expanded', String(auf))
  })
  function optionenKurz() {
    const text = (sel) => sel.selectedOptions[0]?.textContent ?? ''
    const teile = [text(modellWahl)]
    if (!aufwandWahl.disabled) teile.push(text(aufwandWahl).replace(/^Denken: /, ''))
    const modus = modusWahl.value
    optionenKnopf.replaceChildren(h('span', {}, teile.join(' · ')))
    // Ein anderer Modus als "Nachfragen" soll auffallen, auch zugeklappt.
    if (modus && modus !== 'default') optionenKnopf.append(h('span.modus-marke', { title: text(modusWahl) }, symbol('schild', 12)))
  }
  for (const sel of [modellWahl, aufwandWahl, modusWahl]) sel.addEventListener('change', optionenKurz)

  function groesse() {
    feld.style.height = 'auto'
    feld.style.height = `${Math.min(feld.scrollHeight, Math.round(innerHeight * 0.4))}px`
  }
  feld.addEventListener('input', () => { groesse(); knopfZustand() })
  feld.addEventListener('keydown', (ev) => {
    // Enter sendet, Shift+Enter bricht um. Auf dem Handy nicht: dort gibt es
    // kein Shift, Enter ist dort der Zeilenumbruch und gesendet wird per Knopf.
    const handy = matchMedia('(pointer: coarse)').matches
    if (ev.key === 'Enter' && !ev.shiftKey && !handy && !ev.isComposing) {
      ev.preventDefault()
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
    try {
      await opt.beiSenden(text, optionen)
      feld.value = ''
      anhaengeLeeren()
      groesse()
    } catch (e) {
      melden(`Senden fehlgeschlagen: ${fehlerText(e)}`, 'fehler')
    } finally {
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

  // --- Diktieren (vorhandenes hoeren.js + /api/hoeren) ---------------------
  // Erster Druck startet, zweiter beendet; sonst endet die Aufnahme nach
  // kurzer Stille von selbst (hoeren.js).
  mikroKnopf.addEventListener('click', async () => {
    const hoeren = await import('../hoeren.js')
    if (hoeren.aufnahmeLaeuft()) { hoeren.aufnahmeBeenden(); return }
    mikroKnopf.classList.add('an')
    try {
      const wav = await hoeren.aufnahmeStarten()
      if (!wav) { melden('Kein Mikrofon freigegeben oder nichts aufgenommen.', 'info'); return }
      mikroKnopf.classList.add('arbeitet')
      const r = await fetch(bus.api('/api/hoeren'), { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.fehler ?? `HTTP ${r.status}`)
      const text = String(d.text ?? '').trim()
      if (!text) { melden('Nichts verstanden -- noch einmal versuchen.', 'info'); return }
      feld.value = feld.value ? `${feld.value} ${text}` : text
      groesse()
      knopfZustand()
      feld.focus()
    } catch (e) {
      melden(`Diktieren geht gerade nicht: ${fehlerText(e)}`, 'fehler')
    } finally {
      mikroKnopf.classList.remove('an', 'arbeitet')
    }
  })

  einstellungenHolen().then(listenFuellen).catch(() => { /* chat.js zeigt den Ladefehler */ })
  knopfZustand()

  return {
    el,
    fokus: () => { if (!matchMedia('(pointer: coarse)').matches) feld.focus() },
    laeuftSetzen(an) { laeuft = an; el.classList.toggle('laeuft', an); knopfZustand() },
    /** Fuer bestehende Chats steht der Ordner fest (null = frei waehlbar). */
    ordnerFestlegen(p) { ordnerFest = p; ordnerZeigen() },
    textSetzen(t) { feld.value = t; groesse(); knopfZustand() },
    /** Nach "Plan umsetzen" gilt der gewaehlte Modus auch fuer die naechste Nachricht (wie in Claude Code). */
    modusSetzen(m) { wahl.berechtigung = m; modusWahl.value = m; optionenKurz() },
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
