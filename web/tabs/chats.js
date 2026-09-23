/**
 * Tab "Chats" -- die bisherigen Claude-Code-Sitzungen, jetzt mit echter
 * Fortsetzung.
 *
 * Gelesen wird der Syncthing-Spiegel vom Desktop. Fortsetzen geht immer:
 * ohne das urspruengliche Arbeitsverzeichnis auf diesem Host schreibt der
 * Daemon im Home-Verzeichnis weiter (Backend, fortsetzungVorbereiten) --
 * "hier" bzw. "vom Desktop" in der Liste sagt nur, wo die Werkzeuge laufen.
 *
 * Eine geoeffnete Sitzung geht in den Fokusmodus: Suchkopf und Liste treten
 * zurueck, der Chat legt sich ueber die volle Flaeche und laesst sich direkt
 * darunter weiterschreiben -- echtes SDK-`resume`, kein neuer Lauf. Gepollt
 * wird bewusst statt ueber den Bus (bus.js) zu gehen: der WebSocket-Bus
 * filtert je Klient nach EINER runId, aber diese Ansicht kann jederzeit die
 * Sitzung wechseln.
 */
import { api } from '../bus.js'

let wurzel = null
let suchzeit = null
let offen = null          // sessionId der geoeffneten Sitzung
let sichtbarFlag = true   // ob der Tab gerade vorn ist (Router ruft sichtbar())

// Zustand des offenen Chats -- nur gueltig, solange `offen` gesetzt ist.
let aktLaufId = null
let aktZielCwd = ''
let letzteSeq = 0
let pollAktiv = false      // "sollte pollen", ueberlebt ein sichtbar(false)
let pollTimer = null
let claudeBlase = null     // die gerade wachsende Antwortblase (DOM-Element)
let freigabenKarten = new Map() // Freigabe-Id -> Karten-Element im Verlauf

const datum = (ts) =>
  ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—'

const mb = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`)

const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Die REST-Antworten liefern Agenten und Freigaben in SQL-Schreibweise
// (snake_case) -- hier auf die Form bringen, mit der der Rest dieser Datei
// arbeitet. Kleine eigene Kopie statt Import aus lauf.js: die beiden Module
// teilen sich sonst nichts, und ein gemeinsames Modul fuer sieben Zeilen
// waere mehr Kopplung als Ersparnis.
function umbenennen(o) {
  const m = {
    agent_id: 'agentId', session_id: 'sessionId', last_error: 'lastError',
    tool_name: 'toolName', requested_at: 'requestedAt', decided_at: 'decidedAt',
  }
  const r = {}
  for (const [k, v] of Object.entries(o)) r[m[k] ?? k] = v
  if (typeof r.input === 'string') { try { r.input = JSON.parse(r.input) } catch { /* Rohtext reicht */ } }
  return r
}

function geruest() {
  wurzel.innerHTML = `
    <div class="chatkopf">
      <input id="chatsuche" type="search" placeholder="Sitzungen durchsuchen… (Titel und eigene Eingaben)">
      <span class="pill" id="chatzahl">—</span>
    </div>
    <div class="chatspalten">
      <div id="chatliste"><div class="leer">wird geladen…</div></div>
      <div id="chatlese"><div class="leer">Links eine Sitzung waehlen.</div></div>
    </div>`
  const feld = wurzel.querySelector('#chatsuche')
  feld.addEventListener('input', () => {
    // Entprellt: bei 285 Sitzungen je Tastendruck zu suchen waere Unfug.
    clearTimeout(suchzeit)
    suchzeit = setTimeout(() => void laden(feld.value), 220)
  })
}

async function laden(q = '') {
  const liste = wurzel.querySelector('#chatliste')
  try {
    const r = await fetch(api(`/api/chats?q=${encodeURIComponent(q)}`)).then((x) => x.json())
    const chats = r.chats ?? []
    wurzel.querySelector('#chatzahl').textContent = `${chats.length} Sitzungen`
    if (!chats.length) {
      liste.innerHTML = '<div class="leer">Nichts gefunden.</div>'
      return
    }
    liste.innerHTML = chats.map((c) => `
      <button class="chateintrag${c.sessionId === offen ? ' an' : ''}" data-id="${esc(c.sessionId)}">
        <div class="cheintitel">${esc(c.titel)}</div>
        <div class="cheinmeta">
          <span>${esc(c.projekt ?? '—')}</span>
          <span>${datum(c.startedAt)}</span>
          <span>${c.zuege} Züge</span>
          <span>${mb(c.groesse)}</span>
          ${c.hierVorhanden ? '<span class="ja">hier</span>' : '<span class="nein">vom Desktop</span>'}
        </div>
      </button>`).join('')
    for (const b of liste.querySelectorAll('.chateintrag')) {
      b.onclick = () => void oeffnen(b.dataset.id)
    }
  } catch (e) {
    liste.innerHTML = `<div class="leer">Liste nicht abrufbar: ${esc(e)}</div>`
  }
}

function listenauswahlZeichnen() {
  for (const b of wurzel.querySelectorAll('.chateintrag')) b.classList.toggle('an', b.dataset.id === offen)
}

function beitragHtml(b) {
  return `<div class="beitrag ${b.rolle}">
    <div class="brolle">${b.rolle === 'user' ? 'Du' : 'Claude'} · ${datum(b.ts)}</div>
    <pre>${esc(b.text)}</pre>
  </div>`
}

/** Eine Sitzung oeffnen -- geht immer in den Fokusmodus, auch bei "nur lesen". */
async function oeffnen(id) {
  pollGanzStoppen()
  offen = id
  aktLaufId = null
  aktZielCwd = ''
  letzteSeq = 0
  claudeBlase = null
  freigabenKarten = new Map()

  wurzel.classList.add('fokus')
  listenauswahlZeichnen()
  const lese = wurzel.querySelector('#chatlese')
  lese.innerHTML = '<div class="leer">wird geladen…</div>'

  try {
    const d = await fetch(api(`/api/chats/${encodeURIComponent(id)}`)).then((x) => x.json())
    if (offen !== id) return // inzwischen eine andere Sitzung geoeffnet
    if (d.fehler) {
      lese.innerHTML = `<div class="leer">${esc(d.fehler)}</div>`
      return
    }
    sitzungZeichnen(d)
    const f = d.kopf?.fortsetzung
    if (f?.laeuft) {
      aktLaufId = f.laufId
      letzteSeq = f.startSeq ?? 0
      eingabeSperren(true)
      pollStarten()
    }
  } catch (e) {
    if (offen !== id) return
    lese.innerHTML = `<div class="leer">Sitzung nicht lesbar: ${esc(e)}</div>`
  }
}

function fokusVerlassen() {
  wurzel.classList.remove('fokus')
}

/** Baut die Chatspalte (Kopf/Verlauf/Eingabe) neu auf -- Erstladung wie nach einem Zug. */
function sitzungZeichnen(d) {
  const k = d.kopf ?? {}
  aktLaufId = k.fortsetzung?.laufId ?? aktLaufId ?? `chat-${offen}`
  aktZielCwd = k.zielCwd ?? k.cwd ?? ''
  const hierVorhanden = Boolean(k.hierVorhanden)

  const lese = wurzel.querySelector('#chatlese')
  lese.innerHTML = `
    <div class="chatlesekopf">
      <button class="still" id="chatzurueck">← Alle Chats</button>
      <h3>${esc(k.titel)}</h3>
      <div class="spacer"></div>
    </div>
    <div class="lesemeta">weiter auf servertwo in ${esc(aktZielCwd)}${k.gitBranch ? ' · ' + esc(k.gitBranch) : ''}</div>
    ${hierVorhanden ? '' : '<div class="chatzielhinweis">Das urspruengliche Arbeitsverzeichnis gibt es hier nicht -- Werkzeuge laufen auf dem Server statt auf dem Desktop.</div>'}
    <div class="chatverlauf" id="chatverlauf">
      ${d.gekuerzt ? '<div class="chatgekuerzt">ältere Beiträge ausgeblendet</div>' : ''}
      ${(d.beitraege ?? []).map(beitragHtml).join('')}
    </div>
    <div class="chateingabe">
      <textarea id="chattext" rows="1" placeholder="Nachricht… (Enter sendet, Shift+Enter Zeilenumbruch)"></textarea>
      <button id="chatsenden">Senden</button>
    </div>`

  lese.querySelector('#chatzurueck').onclick = fokusVerlassen
  const feld = lese.querySelector('#chattext')
  feld.addEventListener('input', () => {
    feld.style.height = 'auto'
    feld.style.height = `${Math.min(feld.scrollHeight, 150)}px`
  })
  feld.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void nachrichtSenden() }
  })
  lese.querySelector('#chatsenden').onclick = () => void nachrichtSenden()

  verlaufAnsEndeScrollen()
  feld.focus()
}

function eingabeSperren(gesperrt) {
  const lese = wurzel.querySelector('#chatlese')
  const feld = lese?.querySelector('#chattext')
  const knopf = lese?.querySelector('#chatsenden')
  if (feld) feld.disabled = gesperrt
  if (knopf) knopf.disabled = gesperrt
}

function verlaufAnsEndeScrollen() {
  const verlauf = wurzel.querySelector('#chatverlauf')
  if (verlauf) verlauf.scrollTop = verlauf.scrollHeight
}

function fehlerZeileAnhaengen(text) {
  const verlauf = wurzel.querySelector('#chatverlauf')
  if (!verlauf) return
  const d = document.createElement('div')
  d.className = 'chatfehlerzeile'
  d.textContent = text
  verlauf.appendChild(d)
  verlaufAnsEndeScrollen()
}

async function nachrichtSenden() {
  const id = offen
  const lese = wurzel.querySelector('#chatlese')
  const feld = lese?.querySelector('#chattext')
  const text = feld?.value.trim()
  if (!text) return

  const verlauf = lese.querySelector('#chatverlauf')
  verlauf.insertAdjacentHTML('beforeend', beitragHtml({ rolle: 'user', ts: Date.now(), text }))
  claudeBlase = null
  feld.value = ''
  feld.style.height = 'auto'
  eingabeSperren(true)
  verlaufAnsEndeScrollen()

  try {
    const r = await fetch(api(`/api/chats/${encodeURIComponent(id)}/weiter`), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    }).then((x) => x.json())
    if (offen !== id) return
    if (!r.laufId) {
      fehlerZeileAnhaengen(`Senden fehlgeschlagen: ${r.fehler ?? JSON.stringify(r)}`)
      eingabeSperren(false)
      return
    }
    aktLaufId = r.laufId
    letzteSeq = r.startSeq ?? letzteSeq
    pollStarten()
  } catch (e) {
    if (offen !== id) return
    fehlerZeileAnhaengen(`Senden fehlgeschlagen: ${String(e)}`)
    eingabeSperren(false)
  }
}

// --- Live-Antwort per Poll ---------------------------------------------------

function pollStarten() {
  pollAktiv = true
  if (pollTimer || !sichtbarFlag) return
  pollTimer = setInterval(() => void pollSchritt(), 1200)
  void pollSchritt()
}

function pollTimerStoppen() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function pollGanzStoppen() {
  pollAktiv = false
  pollTimerStoppen()
}

async function pollSchritt() {
  if (!aktLaufId || !offen) return
  const id = offen
  let r
  try {
    r = await fetch(api(`/api/lauf/${aktLaufId}?seit=${letzteSeq}`)).then((x) => x.json())
  } catch {
    return // naechster Tick versucht es erneut -- ein einzelner Netzfehler ist kein Abbruch
  }
  if (offen !== id) return // Sitzung wurde inzwischen gewechselt

  for (const e of r.ereignisse ?? []) ereignisVerarbeiten(e)
  freigabenZeichnen(r.freigaben ?? [])

  const agent = (r.agenten ?? []).map(umbenennen).find((a) => a.agentId === 'chat')
  const endzustand = agent && ['done', 'failed', 'stopped'].includes(agent.status)
  if (!endzustand) return

  pollGanzStoppen()
  const fehlertext = agent.status !== 'done' ? (agent.lastError || `Sitzung endete: ${agent.status}`) : null
  await sitzungNeuLaden(id)
  if (offen !== id) return
  if (fehlertext) fehlerZeileAnhaengen(fehlertext)
  eingabeSperren(false)
  wurzel.querySelector('#chattext')?.focus()
}

/** Nach dem Ende eines Zuges: den kanonischen Verlauf laden statt dem live mitgeschriebenen zu trauen. */
async function sitzungNeuLaden(id) {
  try {
    const d = await fetch(api(`/api/chats/${encodeURIComponent(id)}`)).then((x) => x.json())
    if (offen !== id || d.fehler) return
    sitzungZeichnen(d)
  } catch {
    // Der live mitgeschriebene Stand bleibt stehen -- besser als ihn zu loeschen.
  }
}

function ereignisVerarbeiten(e) {
  if (e.seq > letzteSeq) letzteSeq = e.seq
  if (e.agentId !== 'chat') return // Subagenten-Rauschen gehoert nicht in den Chat
  const verlauf = wurzel.querySelector('#chatverlauf')
  if (!verlauf) return

  if (e.kind === 'text') {
    const p = e.payload
    if (p?.type === 'assistant' && !p.parent_tool_use_id) {
      const inhalt = Array.isArray(p.message?.content) ? p.message.content : []
      const text = inhalt.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
      if (text) claudeBlaseErgaenzen(verlauf, text)
    }
  } else if (e.kind === 'tool_use') {
    const z = document.createElement('div')
    z.className = 'chatwerkzeugzeile'
    z.textContent = `⚙ ${e.summary}`
    verlauf.appendChild(z)
    claudeBlase = null // die naechste Textblase ist eine neue, getrennt vom Werkzeugaufruf
    verlaufAnsEndeScrollen()
  }
}

function claudeBlaseErgaenzen(verlauf, text) {
  if (!claudeBlase) {
    claudeBlase = document.createElement('div')
    claudeBlase.className = 'beitrag assistant'
    claudeBlase.innerHTML = '<div class="brolle">Claude</div><pre></pre>'
    verlauf.appendChild(claudeBlase)
  }
  claudeBlase.querySelector('pre').textContent += text
  verlaufAnsEndeScrollen()
}

function freigabenZeichnen(liste) {
  const verlauf = wurzel.querySelector('#chatverlauf')
  if (!verlauf) return
  const aktuelle = new Set()
  for (const roh of liste) {
    const f = umbenennen(roh)
    aktuelle.add(f.id)
    if (freigabenKarten.has(f.id)) continue
    const d = document.createElement('div')
    d.className = 'chatfreigabe'
    d.innerHTML = `<div class="werkzeug"></div><pre></pre>
      <div class="knoepfe"><button class="ja">Erlauben</button><button class="nein">Ablehnen</button></div>`
    d.querySelector('.werkzeug').textContent = f.toolName
    d.querySelector('pre').textContent = JSON.stringify(f.input, null, 1).slice(0, 800)
    d.querySelector('.ja').onclick = () => void freigabeEntscheiden(f.id, true)
    d.querySelector('.nein').onclick = () => void freigabeEntscheiden(f.id, false)
    verlauf.appendChild(d)
    freigabenKarten.set(f.id, d)
    claudeBlase = null // ein Werkzeugaufruf trennt die naechste Antwort von der vorigen Blase
  }
  for (const [id, el] of freigabenKarten) {
    if (!aktuelle.has(id)) { el.remove(); freigabenKarten.delete(id) }
  }
  verlaufAnsEndeScrollen()
}

async function freigabeEntscheiden(id, erlaubt) {
  freigabenKarten.get(id)?.remove()
  freigabenKarten.delete(id)
  try {
    await fetch(api('/api/freigabe'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, erlaubt, durch: 'chat' }),
    })
  } catch {
    // Der naechste Poll zeigt die Karte wieder, falls die Entscheidung nicht ankam.
  }
}

export default {
  id: 'chats',
  titel: 'Chats',
  symbol: '≡',

  mount(el) {
    wurzel = el
    geruest()
    void laden('')
  },

  sichtbar(an) {
    sichtbarFlag = an
    if (an) {
      // Beim Zurueckkommen neu laden: der Index waechst im Hintergrund weiter,
      // waehrend Syncthing neue Sitzungen vom Desktop holt.
      if (wurzel) void laden(wurzel.querySelector('#chatsuche')?.value ?? '')
      if (pollAktiv) pollStarten()
    } else {
      // Nur den Zeitgeber anhalten, nicht pollAktiv loeschen -- ein Handy im
      // Hintergrund soll keinen Akku fuer einen Tab verbrauchen, den niemand
      // ansieht, aber beim Zurueckkommen soll der Zug dort weitergehen, wo er
      // steht, statt als beendet zu gelten.
      pollTimerStoppen()
    }
  },
}
