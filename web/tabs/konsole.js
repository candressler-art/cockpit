/**
 * Tab "Konsole" -- Befehle auf servertwo, jeder einzeln freigegeben.
 *
 * Kein Terminal-Ersatz und ausdruecklich keine offene Shell im Netz: jeder
 * Befehl wird angefragt, erscheint hier mit Erlauben/Ablehnen und laeuft erst
 * nach einem ausdruecklichen Ja. Die Freigabe geht durch denselben Broker wie
 * bei Werkzeugaufrufen der Agenten und steht danach im selben Nachweis.
 *
 * Was hier absichtlich fehlt: ein "immer erlauben". Es wuerde genau das
 * aushoehlen, wofuer dieser Tab so gebaut ist.
 */
import { api, abonnieren } from '../bus.js'

let wurzel = null
const eintraege = new Map()
let cwd = '/opt/cockpit'

const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const zeit = () => new Date().toLocaleTimeString('de-DE', { hour12: false })

function geruest() {
  wurzel.innerHTML = `
    <div class="kwarnung">
      Jeder Befehl braucht eine ausdrückliche Freigabe. Er läuft als Benutzer
      <code>claude</code> auf servertwo — mit dessen Rechten, einschließlich sudo.
    </div>
    <div id="kverlauf"></div>
    <form id="keingabe">
      <input id="kcwd" value="${esc(cwd)}" spellcheck="false" title="Arbeitsverzeichnis">
      <input id="kbefehl" placeholder="Befehl… (Enter fragt die Freigabe an)"
             spellcheck="false" autocomplete="off">
      <button type="submit" id="ksenden">Anfragen</button>
    </form>`

  wurzel.querySelector('#keingabe').addEventListener('submit', (e) => {
    e.preventDefault()
    void anfragen()
  })
}

async function anfragen() {
  const feld = wurzel.querySelector('#kbefehl')
  const befehl = feld.value.trim()
  if (!befehl) return
  cwd = wurzel.querySelector('#kcwd').value.trim() || '/opt/cockpit'
  feld.value = ''
  try {
    const r = await fetch(api('/api/konsole'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ befehl, cwd }),
    }).then((x) => x.json())
    if (r.fehler) meldung(`abgelehnt: ${r.fehler}`)
  } catch (e) {
    meldung(`nicht absendbar: ${String(e)}`)
  }
}

function meldung(text) {
  const d = document.createElement('div')
  d.className = 'keintrag'
  d.innerHTML = `<div class="kkopf"><span class="kzeit">${zeit()}</span>
    <span class="kstatus fehler">${esc(text)}</span></div>`
  wurzel.querySelector('#kverlauf').appendChild(d)
  nachUnten()
}

function nachUnten() {
  const v = wurzel?.querySelector('#kverlauf')
  if (v) v.scrollTop = v.scrollHeight
}

function eintragZeichnen(id) {
  const e = eintraege.get(id)
  if (!e || !e.el) return
  const knoepfe = e.phase === 'freigabe'
    ? `<div class="kknoepfe">
         <button class="gut" data-ja="${esc(id)}">Erlauben</button>
         <button class="schlecht" data-nein="${esc(id)}">Ablehnen</button>
       </div>`
    : ''
  const status = {
    freigabe: '<span class="kstatus wartet">wartet auf Freigabe</span>',
    laeuft: '<span class="kstatus laeuft">läuft…</span>',
    fertig: `<span class="kstatus ${e.code === 0 ? 'gut' : 'fehler'}">Code ${e.code} · ${e.dauerMs} ms</span>`,
    abgelehnt: '<span class="kstatus fehler">abgelehnt</span>',
    fehler: `<span class="kstatus fehler">${esc(e.grund ?? 'Fehler')}</span>`,
  }[e.phase] ?? ''

  const ausgabe = (e.stdout || e.stderr)
    ? `<pre class="kaus">${esc(e.stdout)}${e.stderr ? `<span class="kerr">${esc(e.stderr)}</span>` : ''}</pre>`
    : ''

  // Die Phase traegt die Klammerfarbe: wartend gelb, laufend gruen, abgelehnt rot.
  e.el.className = `keintrag p-${e.phase}${e.phase === 'laeuft' ? ' hud-aktiv' : ''}`
  e.el.innerHTML = `
    <div class="kkopf">
      <span class="kzeit">${e.zeit}</span>
      <code class="kbefehl">${esc(e.befehl)}</code>
      <div class="spacer"></div>
      ${status}
    </div>
    <div class="kcwdzeile">${esc(e.cwd)}</div>
    ${knoepfe}
    ${ausgabe}`

  const ja = e.el.querySelector('[data-ja]')
  const nein = e.el.querySelector('[data-nein]')
  if (ja) ja.onclick = () => void entscheiden(id, true)
  if (nein) nein.onclick = () => void entscheiden(id, false)
}

async function entscheiden(id, erlaubt) {
  const e = eintraege.get(id)
  if (e) { e.phase = erlaubt ? 'laeuft' : 'abgelehnt'; eintragZeichnen(id) }
  await fetch(api('/api/freigabe'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, erlaubt, durch: 'konsole' }),
  })
}

function aufnehmen(d) {
  const id = d.id
  if (!id) return
  let e = eintraege.get(id)
  if (!e) {
    e = { id, zeit: zeit(), befehl: d.befehl ?? '', cwd: d.cwd ?? '', phase: 'freigabe' }
    e.el = document.createElement('div')
    e.el.className = 'keintrag'
    eintraege.set(id, e)
    wurzel?.querySelector('#kverlauf')?.appendChild(e.el)
  }
  Object.assign(e, {
    phase: d.phase ?? e.phase,
    code: d.code ?? e.code,
    stdout: d.stdout ?? e.stdout,
    stderr: d.stderr ?? e.stderr,
    dauerMs: d.dauerMs ?? e.dauerMs,
    grund: d.grund ?? e.grund,
    befehl: d.befehl ?? e.befehl,
    cwd: d.cwd ?? e.cwd,
  })
  eintragZeichnen(id)
  nachUnten()
}

export default {
  id: 'konsole',
  titel: 'Konsole',
  symbol: '⌫',

  mount(el) {
    wurzel = el
    geruest()
    // Der Strom laeuft auch, wenn der Tab hinten ist: ein Befehl, der
    // waehrenddessen fertig wird, soll beim Zurueckkommen dastehen und nicht
    // verlorengegangen sein.
    abonnieren('konsole', aufnehmen)
  },

  sichtbar(an) {
    if (an) {
      nachUnten()
      wurzel?.querySelector('#kbefehl')?.focus()
    }
  },
}
