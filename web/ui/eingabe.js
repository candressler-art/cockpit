/**
 * Eingabefeld der Chat-Ansicht mit Ordner-, Modell-, Denkaufwand- und
 * Moduswahl. Kennt keinen Chat: es meldet nur, was gesendet werden soll,
 * und chat.js entscheidet, ob daraus ein neuer Chat oder ein weiterer Zug wird.
 */
import { h, symbol, api, pfadKurz, melden, fehlerText } from './dom.js'
import * as bus from '../bus.js'

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

  const feld = h('textarea.eingabe-feld', {
    rows: 1, placeholder: 'Schreib Claude eine Nachricht …', 'aria-label': 'Nachricht',
    enterkeyhint: 'send',
  })
  const sendeKnopf = h('button.senden', { type: 'button', title: 'Senden (Enter)', 'aria-label': 'Senden' }, symbol('senden', 18))
  const ordnerKnopf = h('button.chip.ordner-chip', { type: 'button', title: 'Projektordner' })
  const modellWahl = h('select.chip', { 'aria-label': 'Modell', title: 'Modell' })
  const aufwandWahl = h('select.chip', { 'aria-label': 'Denkaufwand', title: 'Denkaufwand' })
  const modusWahl = h('select.chip', { 'aria-label': 'Berechtigungen', title: 'Berechtigungen' })
  const mikroKnopf = h('button.chip.rund', { type: 'button', title: 'Diktieren', 'aria-label': 'Diktieren' }, symbol('mikro', 15))

  // Am Handy passen vier Auswahlfelder nicht in eine Zeile. Dort stehen
  // Modell, Denken und Modus hinter einem Chip, der ihre Kurzform zeigt und
  // sie beim Antippen aufklappt (nur per CSS unterschieden, siehe stil.css).
  const optionenKnopf = h('button.chip.optionen-chip', { type: 'button', 'aria-expanded': 'false', title: 'Modell, Denken, Berechtigungen' })
  const optionen = h('div.eingabe-optionen', {}, modellWahl, aufwandWahl, modusWahl)
  const el = h('div.eingabe', {},
    h('div.eingabe-rahmen', {},
      feld,
      h('div.eingabe-leiste', {},
        ordnerKnopf, optionenKnopf, optionen,
        h('span.spacer'), mikroKnopf, sendeKnopf)))
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
    const leer = !feld.value.trim()
    sendeKnopf.replaceChildren(symbol(laeuft && leer ? 'stopp' : 'senden', 18))
    sendeKnopf.title = laeuft && leer ? 'Anhalten' : 'Senden (Enter)'
    sendeKnopf.setAttribute('aria-label', sendeKnopf.title)
    sendeKnopf.classList.toggle('stopp', laeuft && leer)
    sendeKnopf.disabled = !laeuft && leer
  }

  async function senden() {
    const text = feld.value.trim()
    if (!text) {
      if (laeuft) opt.beiStopp?.()
      return
    }
    if (laeuft) {
      melden('Claude arbeitet noch -- warte auf das Ende oder halte an.', 'info')
      return
    }
    const w = vorgaben?.werte ?? {}
    const optionen = {
      cwd: ordnerFest ? undefined : (wahl.cwd ?? w.arbeitsordner),
      modell: modellWahl.value || undefined,
      aufwand: aufwandWahl.disabled ? undefined : (aufwandWahl.value || undefined),
      berechtigung: modusWahl.value || undefined,
    }
    sendeKnopf.disabled = true
    try {
      await opt.beiSenden(text, optionen)
      feld.value = ''
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
