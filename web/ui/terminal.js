/**
 * Bereich Terminal: Befehle auf diesem Server, jeder einzeln freigegeben.
 *
 * Kein interaktives Terminal und kein "immer erlauben" (siehe konsole.ts):
 * jeder Befehl wird angefragt, erscheint hier mit Erlauben/Ablehnen und
 * laeuft erst nach einem ausdruecklichen Ja. Der Daemon merkt sich die
 * juengsten Befehle -- nach einem Neuladen steht eine wartende Freigabe also
 * noch da, statt unsichtbar bis zum Neustart zu haengen.
 */
import { h, symbol, api, leeren, uhrzeit, fehlerText, melden } from './dom.js'
import * as bus from '../bus.js'

const CWD_SCHLUESSEL = 'cockpit.terminal.cwd'

export function terminalBauen() {
  const eintraege = new Map()
  const verlauf = h('div.t-verlauf', { role: 'log', 'aria-live': 'polite' })
  const cwdFeld = h('input.t-cwd', { value: localStorage.getItem(CWD_SCHLUESSEL) || '/opt/cockpit', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Arbeitsverzeichnis', title: 'Arbeitsverzeichnis' })
  const befehlFeld = h('input.t-befehl', { placeholder: 'Befehl eingeben …', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Befehl' })
  const senden = h('button.knopf.primaer', { type: 'submit' }, 'Anfragen')
  const form = h('form.t-eingabe', {}, cwdFeld, h('div.t-zeile', {}, h('span.t-prompt', { 'aria-hidden': 'true' }, '$'), befehlFeld, senden))
  const el = h('section.bereich.terminal', {},
    h('header.bereich-kopf', {}, h('h1', {}, 'Terminal')),
    h('div.bereich-inhalt', {},
      h('div.hinweis', {}, symbol('info', 16), h('span', {},
        'Jeder Befehl braucht deine Freigabe. Er läuft als ', h('code', {}, 'claude'),
        ' auf diesem Server – mit dessen Rechten, einschließlich sudo. Höchstens 2 Minuten, keine Eingaben.')),
      verlauf),
    form)

  let geladen = false
  let ruecklauf = -1 // Position beim Blaettern mit Pfeil hoch/runter

  form.addEventListener('submit', (ev) => { ev.preventDefault(); anfragen() })
  // Pfeil hoch/runter holt fruehere Befehle, wie in einer Shell.
  befehlFeld.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return
    const frueher = [...eintraege.values()].map((e) => e.befehl).filter(Boolean).reverse()
    if (!frueher.length) return
    ev.preventDefault()
    ruecklauf = Math.max(-1, Math.min(frueher.length - 1, ruecklauf + (ev.key === 'ArrowUp' ? 1 : -1)))
    befehlFeld.value = ruecklauf < 0 ? '' : frueher[ruecklauf]
  })

  async function anfragen() {
    const befehl = befehlFeld.value.trim()
    if (!befehl) return
    const cwd = cwdFeld.value.trim() || '/opt/cockpit'
    localStorage.setItem(CWD_SCHLUESSEL, cwd)
    senden.disabled = true
    try {
      await api('/api/konsole', { body: { befehl, cwd } })
      befehlFeld.value = ''
      ruecklauf = -1
    } catch (e) {
      melden(`Befehl nicht angefragt: ${fehlerText(e)}`, 'fehler')
    } finally {
      senden.disabled = false
    }
  }

  async function entscheiden(id, erlaubt) {
    const e = eintraege.get(id)
    const vorher = e.phase
    e.phase = erlaubt ? 'laeuft' : 'abgelehnt'
    zeichnen(e)
    try {
      await api('/api/freigabe', { body: { id, erlaubt, durch: 'konsole' } })
    } catch (err) {
      e.phase = vorher
      zeichnen(e)
      melden(`Freigabe nicht gesendet: ${fehlerText(err)}`, 'fehler')
    }
  }

  function aufnehmen(d) {
    if (!d?.id) return
    let e = eintraege.get(d.id)
    if (!e) {
      e = { id: d.id, zeit: d.zeit ?? Date.now(), phase: 'freigabe', el: h('article.t-eintrag') }
      eintraege.set(d.id, e)
      if (!verlauf.querySelector('.t-eintrag')) leeren(verlauf)
      verlauf.append(e.el)
    }
    for (const k of ['phase', 'befehl', 'cwd', 'code', 'stdout', 'stderr', 'dauerMs', 'grund']) if (d[k] !== undefined) e[k] = d[k]
    zeichnen(e)
  }

  function zeichnen(e) {
    const status = {
      freigabe: h('span.t-status.wartet', {}, 'wartet auf Freigabe'),
      laeuft: h('span.t-status.laeuft', {}, h('span.kreisel'), 'läuft'),
      fertig: h(`span.t-status${e.code === 0 ? '.gut' : '.schlecht'}`, {}, `Code ${e.code ?? '–'} · ${dauer(e.dauerMs)}`),
      abgelehnt: h('span.t-status.schlecht', {}, 'abgelehnt'),
      fehler: h('span.t-status.schlecht', {}, e.grund ?? 'Fehler'),
    }[e.phase]
    e.el.className = `t-eintrag p-${e.phase}`
    leeren(e.el,
      h('div.t-kopf', {},
        h('code.t-befehl-text', {}, e.befehl ?? ''),
        status),
      h('div.t-ort.leise.klein', {}, `${uhrzeit(e.zeit)} · ${e.cwd ?? ''}`),
      e.phase === 'freigabe' && h('div.t-knoepfe', {},
        h('button.knopf.primaer', { type: 'button', onclick: () => entscheiden(e.id, true) }, 'Erlauben'),
        h('button.knopf', { type: 'button', onclick: () => entscheiden(e.id, false) }, 'Ablehnen')),
      (e.stdout || e.stderr) && h('pre.t-ausgabe', {}, e.stdout ?? '', e.stderr ? h('span.t-stderr', {}, e.stderr) : null),
      e.phase === 'fertig' && !e.stdout && !e.stderr && h('p.leise.klein.t-still', {}, 'keine Ausgabe'))
    nachUnten()
  }

  function nachUnten() {
    el.scrollTop = el.scrollHeight
  }

  async function laden() {
    if (!geladen) leeren(verlauf, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    try {
      const d = await api('/api/konsole')
      if (!geladen) leeren(verlauf)
      geladen = true
      for (const e of d.eintraege) aufnehmen(e)
      if (!eintraege.size) leeren(verlauf, h('div.leer-zustand', {}, 'Noch keine Befehle. Unten eingeben – vor dem Ausführen fragt das Cockpit nach.'))
    } catch (e) {
      if (!geladen) {
        leeren(verlauf, h('div.fehlerbox', {}, h('strong', {}, 'Verlauf nicht geladen'), h('span', {}, fehlerText(e)),
          h('button.knopf', { type: 'button', onclick: laden }, 'Erneut versuchen')))
      }
    }
  }

  // Auch wenn der Bereich hinten ist: ein Befehl, der waehrenddessen fertig
  // wird, soll beim Zurueckkommen dastehen.
  bus.abonnieren('konsole', (d) => { if (geladen) aufnehmen(d) })

  return {
    el,
    zeigen() {
      laden()
      // Am Handy wuerde der Fokus sofort die Tastatur aufklappen und den Verlauf verdecken.
      if (matchMedia('(min-width: 761px)').matches) befehlFeld.focus()
      nachUnten()
    },
    verbergen() {},
  }
}

function dauer(ms) {
  if (ms === undefined || ms === null) return ''
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`
}
