/**
 * Bereich PC: den PC im Heimnetz wecken und herunterfahren (src/pc.ts).
 *
 * Gibt es nur, wenn der Daemon einen PC kennt (/api/variante -> pc). Den
 * Knopf teilen sich mehrere Leute; wer gerade schaltet, bekommt der andere
 * als Benachrichtigung (ui/meldungen.js, Typ 'pc').
 */
import { h, symbol, api, leeren, fehlerText, melden } from './dom.js'
import * as bus from '../bus.js'

export function pcBauen() {
  const inhalt = h('div.bereich-inhalt.pc')
  const el = h('section.bereich', {}, h('header.bereich-kopf', {}, h('h1', {}, 'PC')), inhalt)

  /** null: unbekannt, sonst true/false. */
  let an = null
  let host = ''
  /** Gerade geschaltet: bis der PC den neuen Zustand erreicht, "wird ..." zeigen. */
  let unterwegs = null
  let uhr = null

  async function laden() {
    try {
      const d = await api('/api/pc')
      an = d.an
      host = d.host
      if (unterwegs && an === (unterwegs === 'wecken')) unterwegs = null
    } catch (e) {
      an = null
      host = fehlerText(e)
    }
    zeichnen()
  }

  async function schalten(aktion) {
    if (aktion === 'aus' && !confirm('PC wirklich herunterfahren? Nicht gespeicherte Arbeit darauf geht verloren.')) return
    try {
      await api(`/api/pc/${aktion}`, { body: {} })
      unterwegs = aktion
      zeichnen()
    } catch (e) {
      melden(`PC nicht ${aktion === 'wecken' ? 'geweckt' : 'heruntergefahren'}: ${fehlerText(e)}`, 'fehler')
    }
  }

  function zeichnen() {
    const text = unterwegs === 'wecken' ? 'wird geweckt …'
      : unterwegs === 'aus' ? 'fährt herunter …'
        : an === null ? 'unbekannt' : an ? 'an' : 'aus'
    leeren(inhalt,
      h('div.pc-karte', {},
        h('div.pc-status', {},
          h(`span.pc-punkt${an ? '.an' : ''}`, { 'aria-hidden': 'true' }),
          h('strong', {}, `PC ist ${text}`),
          host && h('span.leise', {}, host)),
        h('p.leise', {}, an
          ? 'Herunterfahren beendet alles auf dem PC – auch Roblox Studio und Blender.'
          : 'Aufwecken dauert etwa eine Minute. Danach dort anmelden und Studio bzw. Blender öffnen.'),
        h('div.pc-knoepfe', {},
          h('button.knopf', { type: 'button', disabled: an === true || unterwegs !== null, onclick: () => schalten('wecken') },
            symbol('plus', 15), 'Aufwecken'),
          h('button.knopf.gefahr', { type: 'button', disabled: an === false || unterwegs !== null, onclick: () => schalten('aus') },
            symbol('kreuz', 15), 'Herunterfahren'))))
  }

  // Schaltet jemand anderes, gleich nachziehen.
  bus.abonnieren('pc', (d) => { unterwegs = d.aktion; zeichnen() })

  return {
    el,
    zeigen() {
      leeren(inhalt, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
      void laden()
      clearInterval(uhr)
      uhr = setInterval(laden, 8000)
    },
    verbergen() { clearInterval(uhr); uhr = null },
  }
}
