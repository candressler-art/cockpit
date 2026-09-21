import { Agentengraph } from '../graph.js'
import { Zeitachse } from '../zeitachse.js'
import { api, basis, abonnieren, beiZustand, senden, anmeldungSetzen } from '../bus.js'

const $ = (s) => document.querySelector(s)

const logEl = $('#log'), agentenEl = $('#agenten'), freigabenEl = $('#freigaben')
const verbindungEl = $('#verbindung'), budgetEl = $('#budget'), laufwahlEl = $('#laufwahl')
const limitEl = $('#limit')

let runId = new URLSearchParams(location.search).get('run') || null
let letzteSeq = 0
let agenten = new Map()
let freigaben = new Map()
let gewaehlterAgent = null
let graph = null
let zeitachse = null

/** Zustaende, in denen ein Agent tatsaechlich Arbeit leistet. Nur sie
 *  bekommen den umlaufenden Rahmen -- auf allen Karten gleichzeitig waere er
 *  der Grund, warum ein Handy heiss wird. */
const ARBEITET = new Set(['thinking', 'tool', 'writing', 'starting'])

/** Farbe je Fachrolle, wie im Graphen und in der Zentrale. */
const FACHFARBE = {
  orchestrator: 'var(--akzent)',
  rechercheur: 'var(--lauf)',
  coder: 'var(--denkt)',
  kommunikator: 'var(--werkzeug)',
}

const zeit = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour12: false })
const zahl = (n) => new Intl.NumberFormat('de-DE').format(Math.round(n))

/**
 * Beim Bus anmelden.
 *
 * Die Verbindung selbst gehoert bus.js -- hier wird nur gesagt, welche
 * Nachrichten diese Ansicht interessieren. `anmeldungSetzen` legt fest, was
 * nach jedem (Wieder-)Verbinden als Erstes rausgeht: das `folgen` mit der
 * zuletzt gesehenen Sequenznummer, damit der Daemon den Rueckstand nachliefert
 * und kein Loch im Verlauf entsteht.
 */
function horchenAnmelden() {
  anmeldungSetzen(() => ({ typ: 'folgen', runId, seit: letzteSeq }))

  beiZustand((zustand) => {
    if (zustand === 'verbunden') {
      verbindungEl.textContent = 'verbunden'
      verbindungEl.className = 'pill an'
    } else {
      verbindungEl.textContent = 'getrennt \u2014 neuer Versuch'
      verbindungEl.className = 'pill ab'
    }
  })

  abonnieren('ereignis', (d) => ereignisAnhaengen(d))
  abonnieren('agent', (d) => agentSetzen(d))
  abonnieren('agenten', (d) => d.forEach((a) => agentSetzen(umbenennen(a))))
  abonnieren('freigabe', (d) => freigabeSetzen(d))
  abonnieren('freigaben', (d) => d.forEach((f) => freigabeSetzen(umbenennen(f))))
  abonnieren('limit', (d) => limitZeichnen(d))
  // 'orchestrator' wird bewusst ignoriert: dieselben Schritte kommen als
  // persistiertes 'protocol'-Ereignis durch, und die ueberleben einen
  // Neustart. Zwei Quellen fuer dieselbe Zeile hiesse sie doppelt zu zeigen.
  abonnieren('lauf_ende', (d) => endeAnhaengen(d.ende))
}

// Die REST-Antworten kommen in SQL-Schreibweise (snake_case), der Live-Strom in
// camelCase. Hier auf eine Form bringen, damit die Anzeige nur eine kennt.
function umbenennen(o) {
  const m = {
    agent_id:'agentId', run_id:'runId', session_id:'sessionId', parent_agent_id:'parentAgentId',
    started_at:'startedAt', ended_at:'endedAt', weighted_tokens:'weightedTokens',
    raw_tokens:'rawTokens', cost_usd:'costUsd', last_error:'lastError',
    tool_name:'toolName', requested_at:'requestedAt', decided_at:'decidedAt',
  }
  const r = {}
  for (const [k, v] of Object.entries(o)) r[m[k] ?? k] = v
  if (typeof r.input === 'string') { try { r.input = JSON.parse(r.input) } catch {} }
  return r
}

function ereignisAnhaengen(e, lebend = true) {
  if (e.seq > letzteSeq) letzteSeq = e.seq
  // Nur bei laufenden Ereignissen aufleuchten lassen; beim Nachladen eines
  // alten Laufs waere ein Gewitter aus Animationen nur Unruhe.
  if (lebend && e.kind !== 'protocol') graph?.puls(e.agentId)
  // Protokollschritte gehoeren zum Lauf, nicht zu einem Agenten -- sie bleiben
  // sichtbar, auch wenn nach einem einzelnen Agenten gefiltert wird.
  if (gewaehlterAgent && e.agentId !== gewaehlterAgent && e.kind !== 'protocol') return
  const unten = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60
  const div = document.createElement('div')
  const fall = e.kind === 'protocol' ? fallKlasse(e.summary) : ''
  div.className = `zeile k-${e.kind} neu` + (e.kind === 'protocol' ? ` protokoll ${fall}` : '')
  div.innerHTML =
    `<span class="zeit"></span><span class="wer"></span><span class="was"></span>`
  div.children[0].textContent = zeit(e.ts)
  div.children[1].textContent = e.agentId
  div.children[2].textContent = e.summary
  logEl.appendChild(div)
  while (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild)
  if (unten) logEl.scrollTop = logEl.scrollHeight
}

// Ereignisse der Orchestrator-Engine -- keine Agentennachrichten, sondern
// Schritte des Protokolls. Sie bekommen eine eigene, hervorgehobene Zeile,
// weil sie den Lauf steuern.
function fallKlasse(summary) {
  if (/^Fall B/.test(summary)) return 'fall-entscheidung'
  if (/^Fall C/.test(summary)) return 'fall-fertig'
  if (/^Fall D/.test(summary) || /^Leseanfrage/.test(summary)) return 'fall-lesen'
  if (/^BLOCKER|Report ohne/.test(summary)) return 'blocker'
  return ''
}

function endeAnhaengen(ende) {
  const gut = ende.grund === 'fertig'
  const frage = ende.grund === 'entscheidung'
  const texte = {
    fertig: 'Lauf fertig', entscheidung: 'Entscheidung noetig', rundenlimit: 'Rundenlimit erreicht',
    wiederholung: 'Gestoppt: der Lauf drehte sich im Kreis', budget: 'Gestoppt: Tokenbudget erschoepft',
    formatfehler: 'Gestoppt: Formatfehler des Orchestrators', blocker: 'Gestoppt: Blocker nicht behandelt',
    abgebrochen: 'Abgebrochen', fehler: 'Fehler',
  }
  const div = document.createElement('div')
  div.className = 'ende ' + (gut ? 'gut' : frage ? 'frage' : 'schlecht')
  div.textContent = (texte[ende.grund] ?? ende.grund) +
    (ende.text ? `\n\n${ende.text}` : '') + (ende.frage ? `\n\n${ende.frage}` : '') +
    (ende.verbraucht ? `\n\n${zahl(ende.verbraucht)} gewichtete Tokens verbraucht` : '')
  div.style.whiteSpace = 'pre-wrap'
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

function agentSetzen(a) {
  agenten.set(a.agentId, { ...(agenten.get(a.agentId) ?? {}), ...a })
  agentenZeichnen()
  budgetZeichnen()
  graph?.setzen([...agenten.values()])
  zeitachse?.setzen([...agenten.values()])
}

function agentenZeichnen() {
  if (agenten.size === 0) { agentenEl.innerHTML = '<div class="leer">noch keine</div>'; return }
  agentenEl.innerHTML = ''
  for (const a of agenten.values()) {
    const d = document.createElement('div')
    // Die Statusklasse traegt die Klammerfarbe (siehe hud.css); 'hud-aktiv'
    // laesst den Rahmen nur dann umlaufen, wenn der Agent WIRKLICH arbeitet.
    const arbeitet = ARBEITET.has(a.status)
    d.className = 'agent rolle-' + (a.role ?? 'chat') + ' s-' + a.status +
      (arbeitet ? ' hud-aktiv' : '') +
      (gewaehlterAgent === a.agentId ? ' aktiv' : '')
    if (a.fachrolle) d.style.setProperty('--klammer-farbe', FACHFARBE[a.fachrolle] ?? '')
    const dauer = ((a.endedAt ?? Date.now()) - a.startedAt) / 1000
    d.innerHTML = `<div class="kopf">
        <span class="name"></span><span class="punkt ${a.status}"></span>
      </div>
      <div class="meta"></div>`
    d.querySelector('.name').textContent = a.label || a.agentId
    d.querySelector('.meta').textContent =
      `${a.status} · ${zahl(a.weightedTokens ?? 0)} gew. · ${dauer.toFixed(0)}s` +
      (a.fachrolle ? ` · ${a.fachrolle}` : a.role ? ` · ${a.role}` : '')
    d.onclick = () => {
      agentWaehlen(gewaehlterAgent === a.agentId ? null : a.agentId)
    }
    agentenEl.appendChild(d)
  }
}

/**
 * Einen Agenten auswaehlen. Graph, Liste und Log zeigen danach dasselbe --
 * ohne diese Verknuepfung muesste man bei jeder Frage selbst zwischen den
 * Ansichten uebersetzen, und genau daran scheitern solche Fenster meistens.
 */
function agentWaehlen(agentId) {
  gewaehlterAgent = agentId
  graph?.auswaehlen(agentId)
  zeitachse?.auswaehlen(agentId)
  agentenZeichnen()
  const hinweis = $('#filterhinweis')
  if (agentId) {
    const a = agenten.get(agentId)
    $('#filtertext').textContent = `nur ${a?.label || agentId}`
    hinweis.classList.add('an')
  } else {
    hinweis.classList.remove('an')
  }
  logNeuLaden()
}

function budgetZeichnen() {
  let gew = 0, roh = 0, usd = 0
  for (const a of agenten.values()) {
    gew += a.weightedTokens ?? 0; roh += a.rawTokens ?? 0; usd += a.costUsd ?? 0
  }
  budgetEl.textContent = `${zahl(gew)} gew. / ${zahl(roh)} roh${usd ? ` · ${usd.toFixed(2)} $` : ''}`
  budgetEl.className = 'pill' + (gew > 600000 ? ' ab' : '')
  budgetEl.title = 'Gewichtet nach loop.py-Gewichten; 600.000 ist dort die Budgetgrenze je Lauf'
}

function limitZeichnen(l) {
  if (!l) return
  const p = (x) => (typeof x === 'number' ? Math.round(x * 100) + ' %' : '—')
  const reset = l.fuenfStundenResetsAt
    ? new Date(l.fuenfStundenResetsAt * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : '—'
  limitEl.textContent = `5h ${p(l.fuenfStundenAnteil)} · Woche ${p(l.siebenTageAnteil)} · Reset ${reset}`
  const eng = (l.fuenfStundenAnteil ?? 0) > 0.8 || (l.siebenTageAnteil ?? 0) > 0.8
  limitEl.className = 'pill' + (l.status !== 'allowed' ? ' ab' : eng ? ' ab' : ' an')
  limitEl.title = `Status: ${l.status}${l.rateLimitType ? ' · ' + l.rateLimitType : ''}` +
    ' — gemessene Werte vom Server, keine Schaetzung'
}

function freigabeSetzen(f) {
  if (f.decidedAt) freigaben.delete(f.id); else freigaben.set(f.id, f)
  freigabenZeichnen()
}

function freigabenZeichnen() {
  if (freigaben.size === 0) { freigabenEl.innerHTML = '<div class="leer">keine offen</div>'; return }
  freigabenEl.innerHTML = ''
  for (const f of freigaben.values()) {
    const d = document.createElement('div')
    d.className = 'freigabe'
    d.innerHTML = `<div class="werkzeug"></div><div class="meta"></div>
      <pre></pre><div class="knoepfe">
        <button class="ja">Erlauben</button><button class="nein">Ablehnen</button>
      </div>`
    d.querySelector('.werkzeug').textContent = f.toolName
    d.querySelector('.meta').textContent = `${f.agentId} · ${zeit(f.requestedAt)}`
    d.querySelector('pre').textContent = JSON.stringify(f.input, null, 1).slice(0, 1200)
    d.querySelector('.ja').onclick = () => entscheiden(f.id, true)
    d.querySelector('.nein').onclick = () => entscheiden(f.id, false)
    freigabenEl.appendChild(d)
  }
}

async function entscheiden(id, erlaubt) {
  await fetch(api('/api/freigabe'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, erlaubt, durch: 'ui' }),
  })
  freigaben.delete(id)
  freigabenZeichnen()
}

async function logNeuLaden() {
  if (!runId) return
  logEl.innerHTML = ''
  const r = await fetch(api(`/api/lauf/${runId}?seit=0`)).then((x) => x.json())
  agenten = new Map(r.agenten.map((a) => { const b = umbenennen(a); return [b.agentId, b] }))
  freigaben = new Map(r.freigaben.map((f) => { const b = umbenennen(f); return [b.id, b] }))
  letzteSeq = 0
  for (const e of r.ereignisse) ereignisAnhaengen(e, false)
  agentenZeichnen(); freigabenZeichnen(); budgetZeichnen()
  graph?.setzen([...agenten.values()])
  zeitachse?.setzen([...agenten.values()])
  zeitachse?.setzen([...agenten.values()])
}

async function laeufeLaden() {
  let r
  try {
    r = await fetch(api('/api/laeufe')).then((x) => x.json())
  } catch (e) {
    // Haeufigster Fall in der App: der Daemon laeuft nicht. Das gehoert
    // gesagt, nicht als leeres Fenster praesentiert.
    verbindungEl.textContent = `kein Daemon auf ${basis()}`
    verbindungEl.className = 'pill ab'
    logEl.innerHTML =
      `<div class="ende schlecht">Kein Daemon erreichbar auf ${basis()}.\n\n` +
      `Starten:  cd ~/projekte/cockpit && node dist/daemon.js\n` +
      `Andere Adresse:  COCKPIT_DAEMON=servertwo.tail9c8a2b.ts.net:8443 cockpit</div>`
    logEl.firstChild.style.whiteSpace = 'pre-wrap'
    return
  }
  laufwahlEl.innerHTML = ''
  for (const l of r.laeufe) {
    const o = document.createElement('option')
    o.value = l.run_id
    o.textContent = `${l.label} · ${zeit(l.started_at)} · ${l.status}`
    laufwahlEl.appendChild(o)
  }
  if (!runId && r.laeufe.length > 0) runId = r.laeufe[0].run_id
  if (runId) laufwahlEl.value = runId
}

laufwahlEl.onchange = async () => {
  runId = laufwahlEl.value
  history.replaceState(null, '', `?run=${runId}`)
  await logNeuLaden()
  senden({ typ: 'folgen', runId, seit: 0 })
}

$('#neu').onclick = () => { runId = null; agenten.clear(); freigaben.clear(); logEl.innerHTML = ''
  agentenZeichnen(); freigabenZeichnen(); $('#prompt').focus() }

async function starten() {
  const prompt = $('#prompt').value.trim()
  if (!prompt) return
  $('#senden').disabled = true
  try {
    const r = await fetch(api('/api/lauf'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, label: prompt.slice(0, 40), cwd: null }),
    }).then((x) => x.json())
    if (r.runId) {
      runId = r.runId
      letzteSeq = 0
      logEl.innerHTML = ''
      agenten.clear(); freigaben.clear()
      $('#prompt').value = ''
      history.replaceState(null, '', `?run=${runId}`)
      senden({ typ: 'folgen', runId, seit: 0 })
      await laeufeLaden()
    } else {
      alert('Start fehlgeschlagen: ' + JSON.stringify(r))
    }
  } finally {
    $('#senden').disabled = false
  }
}

$('#senden').onclick = starten
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); starten() }
})

// Dauer-Anzeige der laufenden Agenten mitlaufen lassen.
let vorn = true
setInterval(() => {
  if (!vorn) return
  if (![...agenten.values()].some((a) => !a.endedAt)) return
  agentenZeichnen()
  if (!$('#zeitachse').classList.contains('weg')) zeitachse?.zeichnen()
}, 1000)

graph = new Agentengraph($('#graph'), agentWaehlen)
zeitachse = new Zeitachse($('#zeitachse'), agentWaehlen)

for (const b of document.querySelectorAll('#ansichtwahl button')) {
  b.onclick = () => {
    const ansicht = b.dataset.ansicht
    for (const x of document.querySelectorAll('#ansichtwahl button')) x.classList.toggle('an', x === b)
    $('#graph').classList.toggle('weg', ansicht !== 'graph')
    $('#zeitachse').classList.toggle('weg', ansicht !== 'zeit')
    $('#ansichttitel').textContent = ansicht === 'graph' ? 'Agentengraph' : 'Zeitachse'
    // Nach dem Einblenden neu legen: ein verstecktes SVG hat Breite 0, die
    // Positionen waeren sonst auf der alten Rechnung stehengeblieben.
    if (ansicht === 'graph') graph.zeichnen()
    else zeitachse.zeichnen()
  }
}

$('#filterweg').onclick = () => agentWaehlen(null)
$('#graphklapp').onclick = () => {
  const box = $('#graphbox')
  box.classList.toggle('zu')
  $('#graphklapp').textContent = box.classList.contains('zu') ? 'ausklappen' : 'einklappen'
}
// Der Graph rechnet mit der Breite des Fensters -- nach einer Groessenaenderung
// muss er neu gelegt werden, sonst stehen die Knoten falsch oder ausserhalb.
let legeNeu
addEventListener('resize', () => {
  clearTimeout(legeNeu)
  legeNeu = setTimeout(() => {
    if (!$('#graph').classList.contains('weg')) graph?.zeichnen()
    if (!$('#zeitachse').classList.contains('weg')) zeitachse?.zeichnen()
  }, 120)
})

/**
 * Tab "Lauf" -- die urspruengliche Ansicht, unveraendert in ihrer Logik.
 *
 * `statisch: true`: Das Markup dieser Ansicht steht fest in index.html (aside,
 * main, #rechts sind direkte Kinder des Grids und muessen es bleiben, sonst
 * bricht das dreispaltige Layout). Der Router baut fuer sie deshalb keine
 * Flaeche, sondern schaltet nur #app.nur-lauf um.
 */
export default {
  id: 'lauf',
  titel: 'Lauf',
  symbol: '\u25B6',
  statisch: true,

  async mount() {
    horchenAnmelden()
    await laeufeLaden()
    if (runId) await logNeuLaden()
    try { limitZeichnen((await fetch(api('/api/gesundheit')).then((r) => r.json())).limit) } catch {}
  },

  sichtbar(an) {
    vorn = an
    // Ein verstecktes SVG hat Breite 0: beim Zurueckkommen waeren die
    // Positionen auf der alten Rechnung stehengeblieben.
    if (an) {
      if (!$('#graph').classList.contains('weg')) graph?.zeichnen()
      if (!$('#zeitachse').classList.contains('weg')) zeitachse?.zeichnen()
    }
  },
}