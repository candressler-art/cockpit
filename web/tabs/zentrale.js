/**
 * Tab "Zentrale" -- alles auf einen Blick.
 *
 * Die anderen Tabs zeigen je eine Sache gruendlich. Diese Seite zeigt den
 * Zustand des ganzen Systems gleichzeitig, weil genau das den Unterschied
 * zwischen "fuenf Ansichten nacheinander" und einer Zentrale ausmacht.
 *
 * Jede Bewegung hier bildet etwas Gemessenes ab:
 *   - der Kern schlaegt schneller, wenn Agenten arbeiten,
 *   - er leuchtet auf, wo eine Notiz angefasst wurde,
 *   - die Wellenform folgt dem echten Sprachpegel,
 *   - die Ringe zeigen Nutzungsfenster und Serverlast.
 * Es gibt bewusst nichts, was nur so tut.
 */
import { api, abonnieren, beiZustand } from '../bus.js'
import { Wissenskern } from '../kern.js'
import * as sp from '../sprachpegel.js'
import * as stimme from '../stimme.js'

let wurzel = null
let vorn = false
let kern = null
let welle = null
let schleife = null
let letzteAgenten = []
let letztesSystem = null
let letztesLimit = null
let ereignisse = []
let abmelden = []

const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const pz = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}`)
const zeit = (ts) => (ts ? new Date(ts).toLocaleTimeString('de-DE', { hour12: false }) : '')

const ROLLENFARBE = {
  orchestrator: 'var(--akzent)',
  rechercheur: 'var(--lauf)',
  coder: 'var(--denkt)',
  kommunikator: 'var(--werkzeug)',
}
const STATUSFARBE = {
  thinking: 'var(--denkt)', tool: 'var(--werkzeug)', writing: 'var(--lauf)',
  waiting_permission: 'var(--wartet)', waiting_ratelimit: 'var(--wartet)',
  failed: 'var(--fehler)', done: 'var(--fertig)', stopped: 'var(--overlay)',
  starting: 'var(--akzent)', queued: 'var(--overlay)',
}
const AKTIV = new Set(['thinking', 'tool', 'writing', 'starting'])

function geruest() {
  wurzel.innerHTML = `
    <div class="z-raster">
      <section class="z-panel hud-panel hud-raster" id="z-kern">
        <div class="z-kopf"><span class="hud-titel">Wissenskern</span>
          <div class="spacer"></div><span class="hud-titel" id="z-kernstand">—</span></div>
        <div id="z-buehne"></div>
        <div id="z-kernhinweis" class="z-hinweis"></div>
      </section>

      <section class="z-panel hud-panel" id="z-limit">
        <span class="hud-titel">Nutzungsfenster</span>
        <div class="z-ringe">
          <div class="z-ring"><div class="hud-ring" id="r-5h"><div>
            <div class="hud-zahl" style="--zahl-groesse:17px" id="r-5h-t">—</div></div></div>
            <div class="z-ringtitel">5 Stunden</div></div>
          <div class="z-ring"><div class="hud-ring" id="r-7t"><div>
            <div class="hud-zahl" style="--zahl-groesse:17px" id="r-7t-t">—</div></div></div>
            <div class="z-ringtitel">7 Tage</div></div>
        </div>
        <div class="z-fuss" id="z-reset">—</div>
      </section>

      <section class="z-panel hud-panel" id="z-last">
        <span class="hud-titel">Serverlast</span>
        <div class="z-ringe" id="z-lastringe"><div class="leer">wird geholt…</div></div>
      </section>

      <section class="z-panel hud-panel" id="z-agenten">
        <div class="z-kopf"><span class="hud-titel">Agenten</span>
          <div class="spacer"></div><span class="hud-titel" id="z-agentenzahl">0</span></div>
        <div id="z-agentenliste"><div class="leer">keine aktiven</div></div>
      </section>

      <section class="z-panel hud-panel" id="z-strom">
        <span class="hud-titel">Strom</span>
        <div id="z-stromliste"><div class="leer">still</div></div>
      </section>
    </div>

    <div class="z-sprachleiste hud-panel" id="z-sprache">
      <button class="z-mikro" id="z-mikro" title="Mikrofon">◉</button>
      <canvas id="z-welle" height="44"></canvas>
      <div class="z-sprachtext">
        <div class="hud-titel" id="z-sprachstatus">bereit</div>
        <div class="z-sprachnote" id="z-sprachnote">Tippen zum Zuhören</div>
      </div>
      <button class="still" id="z-testen">Sprechen testen</button>
    </div>`

  welle = wurzel.querySelector('#z-welle')
  wurzel.querySelector('#z-mikro').onclick = () => void mikroSchalten()
  wurzel.querySelector('#z-testen').onclick = () => void sprechenTesten()
}

async function mikroSchalten() {
  const knopf = wurzel.querySelector('#z-mikro')
  if (sp.mikroLaeuft()) {
    sp.mikroAus()
    knopf.classList.remove('an')
    return
  }
  const ok = await sp.mikroAn()
  knopf.classList.toggle('an', ok)
  wurzel.querySelector('#z-sprachnote').textContent = ok
    ? 'Mikrofon offen — der Kern hört mit'
    : 'Mikrofon nicht freigegeben'
}

async function sprechenTesten() {
  await sp.aufwecken()
  await stimme.sagen('Der Kern ist wach und hört zu.', { erzwingen: true })
}

/** Wie stark das System arbeitet: treibt den Herzschlag. */
function lastAnteil() {
  const aktive = letzteAgenten.filter((a) => AKTIV.has(a.status)).length
  const cpu = letztesSystem?.hosts?.[0]?.cpuProzent ?? 0
  return Math.min(1, aktive * 0.34 + cpu / 160)
}

function agentenZeichnen() {
  const el = wurzel?.querySelector('#z-agentenliste')
  if (!el) return
  const liste = [...letzteAgenten].sort(
    (a, b) => (AKTIV.has(b.status) ? 1 : 0) - (AKTIV.has(a.status) ? 1 : 0),
  ).slice(0, 8)
  wurzel.querySelector('#z-agentenzahl').textContent =
    `${letzteAgenten.filter((a) => AKTIV.has(a.status)).length} aktiv`
  if (!liste.length) {
    el.innerHTML = '<div class="leer">keine aktiven</div>'
    return
  }
  el.innerHTML = liste.map((a) => {
    const farbe = ROLLENFARBE[a.fachrolle] ?? STATUSFARBE[a.status] ?? 'var(--overlay)'
    const aktiv = AKTIV.has(a.status)
    return `<div class="z-agent hud-panel${aktiv ? ' hud-aktiv' : ''}"
             style="--klammer-farbe:${farbe}">
        <div class="z-agentname">${esc(a.label || a.agentId)}</div>
        <div class="z-agentmeta">
          <span style="color:${farbe}">${esc(a.fachrolle ?? a.role ?? '')}</span>
          <span>${esc(a.status)}</span>
          <span>${new Intl.NumberFormat('de-DE').format(Math.round(a.weightedTokens ?? 0))}</span>
        </div>
      </div>`
  }).join('')
}

function limitZeichnen() {
  if (!wurzel || !letztesLimit) return
  const setz = (id, anteil) => {
    const r = wurzel.querySelector(`#${id}`)
    const t = wurzel.querySelector(`#${id}-t`)
    if (!r || !t) return
    const p = anteil === null || anteil === undefined ? null : Math.round(anteil * 100)
    r.style.setProperty('--prozent', p ?? 0)
    r.style.setProperty('--ring-farbe',
      p === null ? 'var(--surface1)' : p >= 85 ? 'var(--fehler)' : p >= 60 ? 'var(--werkzeug)' : 'var(--hud)')
    t.textContent = p === null ? '—' : `${p}%`
    t.className = `hud-zahl${p >= 85 ? ' heiss' : p >= 60 ? ' warm' : ''}`
  }
  setz('r-5h', letztesLimit.fuenfStundenAnteil)
  setz('r-7t', letztesLimit.siebenTageAnteil)
  const r = letztesLimit.fuenfStundenResetsAt ?? letztesLimit.resetsAt
  wurzel.querySelector('#z-reset').textContent = r
    ? `zurückgesetzt ${new Date(r).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
    : ''
}

function systemZeichnen() {
  const el = wurzel?.querySelector('#z-lastringe')
  if (!el || !letztesSystem) return
  const h = letztesSystem.hosts?.[0]
  if (!h) { el.innerHTML = '<div class="leer">keine Daten</div>'; return }
  const ring = (titel, wert, zusatz) => {
    const p = wert === null || wert === undefined ? null : Math.round(wert)
    const farbe = p === null ? 'var(--surface1)'
      : p >= 85 ? 'var(--fehler)' : p >= 60 ? 'var(--werkzeug)' : 'var(--hud)'
    return `<div class="z-ring">
      <div class="hud-ring" style="--prozent:${p ?? 0};--ring-farbe:${farbe};--ring-groesse:62px"><div>
        <div class="hud-zahl" style="--zahl-groesse:15px">${p === null ? '—' : p + '%'}</div></div></div>
      <div class="z-ringtitel">${titel}</div><div class="z-ringnote">${zusatz}</div></div>`
  }
  const temp = h.tempC === null || h.tempC === undefined ? '' : `${h.tempC.toFixed(0)} °C`
  el.innerHTML =
    ring('CPU', h.cpuProzent, temp) +
    ring('Speicher', h.ramProzent, h.ramGesamtMb ? `${(h.ramGesamtMb / 1024).toFixed(1)} GB` : '') +
    ring('Platte', h.plattenProzent, h.plattenGesamtGb ? `${h.plattenGesamtGb} GB` : '')
}

function stromZeichnen() {
  const el = wurzel?.querySelector('#z-stromliste')
  if (!el) return
  if (!ereignisse.length) { el.innerHTML = '<div class="leer">still</div>'; return }
  el.innerHTML = ereignisse.slice(-9).reverse().map((e) => `
    <div class="z-strom-zeile">
      <span class="z-strom-zeit">${zeit(e.ts)}</span>
      <span class="z-strom-art" style="color:${STATUSFARBE[e.kind] ?? 'var(--hud)'}">${esc(e.kind)}</span>
      <span class="z-strom-text">${esc(String(e.summary ?? '').slice(0, 90))}</span>
    </div>`).join('')
}

/** Dateipfade aus Werkzeugaufrufen: daran haengt das Aufleuchten im Kern. */
function notizAus(ereignis) {
  const p = ereignis?.payload
  const kandidat = p?.input?.file_path ?? p?.input?.path ?? p?.input?.notebook_path
  if (typeof kandidat !== 'string') return null
  const m = /([^/]+)\.md$/.exec(kandidat)
  return m ? m[1] : null
}

export default {
  id: 'zentrale',
  titel: 'Zentrale',
  symbol: '◉',

  async mount(el) {
    wurzel = el
    geruest()

    const buehne = el.querySelector('#z-buehne')
    kern = new Wissenskern(buehne)

    try {
      const g = await fetch(api('/api/vault/graph')).then((r) => r.json())
      if (g?.knoten?.length) {
        kern.setzen(g)
        el.querySelector('#z-kernstand').textContent =
          `${g.knoten.length} Notizen · ${g.kanten.length} Verknüpfungen`
      } else {
        el.querySelector('#z-kernhinweis').textContent =
          'Der Vault-Spiegel ist leer — der Kern zeigt noch nichts.'
      }
    } catch (e) {
      el.querySelector('#z-kernhinweis').textContent = `Vault nicht abrufbar: ${String(e)}`
    }

    // --- echte Daten anzapfen ---
    abmelden.push(abonnieren('agenten', (d) => {
      letzteAgenten = (d ?? []).map((a) => ({
        agentId: a.agent_id ?? a.agentId, label: a.label,
        status: a.status, role: a.role, fachrolle: a.fachrolle ?? a.fachrolle,
        weightedTokens: a.weighted_tokens ?? a.weightedTokens,
      }))
      agentenZeichnen()
    }))
    abmelden.push(abonnieren('agent', (a) => {
      const id = a.agentId ?? a.agent_id
      const i = letzteAgenten.findIndex((x) => x.agentId === id)
      const neu = {
        agentId: id, label: a.label, status: a.status, role: a.role,
        fachrolle: a.fachrolle, weightedTokens: a.weightedTokens ?? a.weighted_tokens,
      }
      if (i >= 0) letzteAgenten[i] = neu
      else letzteAgenten.push(neu)
      agentenZeichnen()
    }))
    abmelden.push(abonnieren('ereignis', (e) => {
      ereignisse.push(e)
      if (ereignisse.length > 40) ereignisse.shift()
      stromZeichnen()
      const notiz = notizAus(e)
      if (notiz) kern?.anstossen(notiz)
    }))
    abmelden.push(abonnieren('limit', (l) => { letztesLimit = l; limitZeichnen() }))
    abmelden.push(abonnieren('system', (s) => { letztesSystem = s; systemZeichnen() }))
    abmelden.push(beiZustand((z) => {
      const s = wurzel?.querySelector('#z-sprachstatus')
      if (s) s.textContent = z === 'verbunden' ? 'bereit' : 'getrennt'
    }))

    try {
      const [sys, ges] = await Promise.all([
        fetch(api('/api/system')).then((r) => r.json()),
        fetch(api('/api/gesundheit')).then((r) => r.json()),
      ])
      letztesSystem = sys
      letztesLimit = ges.limit
      systemZeichnen()
      limitZeichnen()
    } catch { /* der Live-Strom liefert es gleich nach */ }

    kern.starten()
    this.sichtbar(true)
  },

  sichtbar(an) {
    vorn = an
    if (!kern) return
    if (an) {
      kern.anpassen()
      kern.starten()
      if (!schleife) rahmen()
    } else {
      kern.anhalten()
      if (schleife) { cancelAnimationFrame(schleife); schleife = null }
    }
  },

  unmount() {
    for (const f of abmelden) { try { f() } catch { /* egal */ } }
    abmelden = []
    if (schleife) cancelAnimationFrame(schleife)
    schleife = null
    kern?.abbauen()
    kern = null
  },
}

/** Eigene Schleife fuer Pegel und Wellenform -- der Kern hat seine eigene. */
function rahmen() {
  const bild = (jetzt) => {
    if (!vorn) { schleife = null; return }
    schleife = requestAnimationFrame(bild)
    const s = sp.messen(jetzt)
    kern?.pegelSetzen(s.pegel)
    kern?.lastSetzen(lastAnteil())
    if (welle) {
      const b = welle.clientWidth || 300
      if (welle.width !== b) welle.width = b
      sp.wellenformZeichnen(welle, s.quelle === 'still' ? '#3b5570' : '#6fe3ff')
    }
    const note = wurzel?.querySelector('#z-sprachstatus')
    if (note) {
      note.textContent = s.quelle === 'spricht' ? 'spricht' : s.quelle === 'hoert' ? 'hört zu' : 'bereit'
    }
  }
  schleife = requestAnimationFrame(bild)
}
