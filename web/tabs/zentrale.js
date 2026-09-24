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
import * as hoeren from '../hoeren.js'

let wurzel = null
let vorn = false
let kern = null
let welle = null
let schleife = null
let letzteAgenten = []
let letztesSystem = null
let letzteKonten = []
let letzterKontenModus = 'ausgeglichen'
let letztesNaechstesKonto = null
let letzterAbstandPunkte = null
let kontenIntervall = null
let ereignisse = []
let abmelden = []

// --- Sprachgespraech ---------------------------------------------------------
//
// Der Zustand einer laufenden Runde (hört zu -> versteht -> denkt -> spricht)
// und das Gedaechtnis darueber hinaus: gespraechSessionId traegt die SDK-
// Session ueber mehrere Runden, "Neues Gespräch" wirft sie weg.
let gespraechImGang = false
let gespraechSessionId = null
let gespraechVerlauf = []

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
        <div class="z-kopf"><span class="hud-titel">Nutzungsfenster</span>
          <div class="spacer"></div><span class="hud-titel" id="z-limitmodus">—</span></div>
        <div id="z-limitliste"><div class="leer">wird geholt…</div></div>
        <div class="z-fuss" id="z-reset">—</div>
      </section>

      <section class="z-panel hud-panel" id="z-last">
        <span class="hud-titel">Serverlast</span>
        <div id="z-lastliste"><div class="leer">wird geholt…</div></div>
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

      <section class="z-panel hud-panel" id="z-auftrag">
        <div class="z-kopf"><span class="hud-titel">Neuer Auftrag</span>
          <div class="spacer"></div>
          <span class="z-rollen" id="z-rollen"></span></div>
        <textarea id="a-text" rows="2" spellcheck="false"
          placeholder="Was soll getan werden? Mit 'AN-ROLLE: rechercheur' in der ersten Zeile gezielt adressieren."></textarea>
        <div class="z-auftragzeile">
          <input id="a-cwd" value="/opt/cockpit" spellcheck="false" title="Arbeitsverzeichnis">
          <label>Runden <input id="a-runden" type="number" min="1" max="40" value="6"></label>
          <label>Parallel <input id="a-parallel" type="number" min="1" max="4" value="2"></label>
          <div class="spacer"></div>
          <button class="still" id="a-start">Orchestrator starten</button>
        </div>
        <div class="z-auftragnote" id="a-note"></div>
      </section>
    </div>

    <div class="z-sprachblock">
      <div class="z-sprachleiste hud-panel" id="z-sprache">
        <button class="z-mikro" id="z-mikro" title="Mikrofon: tippen und sprechen">◉</button>
        <canvas id="z-welle" height="44"></canvas>
        <div class="z-sprachtext">
          <div class="hud-titel" id="z-sprachstatus">bereit</div>
          <div class="z-sprachnote" id="z-sprachnote">Tippen zum Sprechen</div>
        </div>
        <button class="still" id="z-neu" title="Verlauf verwerfen, neu anfangen">Neues Gespräch</button>
        <button class="still" id="z-testen">Sprechen testen</button>
      </div>
      <div class="z-gespraech" id="z-gespraech"></div>
    </div>`

  welle = wurzel.querySelector('#z-welle')
  wurzel.querySelector('#z-mikro').onclick = () => void mikroSchalten()
  wurzel.querySelector('#z-testen').onclick = () => void sprechenTesten()
  wurzel.querySelector('#z-neu').onclick = () => neuesGespraech()
  wurzel.querySelector('#a-start').onclick = () => void auftragStarten()
  verlaufZeichnen()
}

/**
 * Einen Orchestrator-Lauf starten.
 *
 * Das ging vorher nur ueber die API -- die ganzen Fachrollen waren aus der
 * Oberflaeche heraus nicht erreichbar, obwohl sie der Kern des Aufbaus sind.
 * Ein Weg, den man nur mit curl geht, wird nicht benutzt.
 */
async function auftragStarten() {
  const text = wurzel.querySelector('#a-text').value.trim()
  const note = wurzel.querySelector('#a-note')
  if (!text) { note.textContent = 'Kein Auftrag eingetragen.'; return }
  const knopf = wurzel.querySelector('#a-start')
  knopf.disabled = true
  note.textContent = 'wird gestartet…'
  try {
    const r = await fetch(api('/api/orchestrator'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: text.split('\n')[0].slice(0, 50),
        cwd: wurzel.querySelector('#a-cwd').value.trim() || '/opt/cockpit',
        anfangsPrompt: text,
        projektBlock: 'Auftrag aus der Cockpit-Zentrale.',
        maxRunden: Number(wurzel.querySelector('#a-runden').value) || 6,
        parallelitaet: Number(wurzel.querySelector('#a-parallel').value) || 2,
      }),
    }).then((x) => x.json())
    if (r.runId) {
      wurzel.querySelector('#a-text').value = ''
      note.textContent = `läuft: ${r.runId.slice(0, 8)} — im Tab „Lauf“ zu sehen`
      stimme.sagen('Der Auftrag läuft.', { wichtig: true })
    } else {
      note.textContent = `Start abgelehnt: ${r.fehler ?? JSON.stringify(r)}`
    }
  } catch (e) {
    note.textContent = `nicht absendbar: ${String(e)}`
  } finally {
    knopf.disabled = false
  }
}

/** Status und Notiz im Sprachbereich setzen. fehler=true faerbt die Notiz rot. */
function sprachStatusSetzen(status, note, fehler = false) {
  const s = wurzel?.querySelector('#z-sprachstatus')
  const n = wurzel?.querySelector('#z-sprachnote')
  if (s) s.textContent = status
  if (n && note !== undefined) {
    n.textContent = note
    n.classList.toggle('fehler', fehler)
  }
}

function neuesGespraech() {
  gespraechSessionId = null
  gespraechVerlauf = []
  verlaufZeichnen()
  sprachStatusSetzen('bereit', 'Neues Gespräch — tippen zum Sprechen')
}

function verlaufZeichnen() {
  const el = wurzel?.querySelector('#z-gespraech')
  if (!el) return
  el.classList.toggle('an', gespraechVerlauf.length > 0)
  el.innerHTML = gespraechVerlauf.slice(-6).map((z) =>
    `<div class="z-gzeile ${z.rolle}"><span class="wer">${z.rolle === 'du' ? 'Du' : 'Cockpit'}</span>${esc(z.text)}</div>`,
  ).join('')
  el.scrollTop = el.scrollHeight
}

/**
 * Mikro antippen: laeuft schon eine Aufnahme, beendet ein zweiter Tipp sie
 * sofort (statt der 1,2s-Stille zu warten). Waehrend Erkennung, Antwort oder
 * Sprechen ist der Knopf per .arbeitet gesperrt -- ein Tipp waere sonst eine
 * zweite Runde ueber eine laufende.
 */
async function mikroSchalten() {
  if (hoeren.aufnahmeLaeuft()) { hoeren.aufnahmeBeenden(); return }
  if (gespraechImGang) return
  await gespraechRunde()
}

/** Eine volle Runde: zuhoeren -> erkennen -> antworten -> vorlesen. */
async function gespraechRunde() {
  gespraechImGang = true
  const knopf = wurzel.querySelector('#z-mikro')
  knopf.classList.add('an')
  sprachStatusSetzen('hört zu', 'Sprich jetzt — Pause oder erneutes Tippen beendet')

  let wav = null
  try {
    wav = await hoeren.aufnahmeStarten()
  } catch (e) {
    console.warn('[zentrale] Aufnahme fehlgeschlagen:', String(e))
  }
  knopf.classList.remove('an')
  sp.mikroAus() // Aufnahme dieser Runde ist zu Ende -- die Leuchte soll das zeigen.

  if (wav === null) {
    sprachStatusSetzen('bereit', 'Mikrofon nicht freigegeben', true)
    gespraechImGang = false
    return
  }

  knopf.classList.add('arbeitet')
  sprachStatusSetzen('versteht…', 'Spracherkennung läuft')
  let erkannt
  try {
    const antwort = await fetch(api('/api/hoeren'), {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
    })
    const r = await antwort.json().catch(() => ({}))
    if (!antwort.ok) throw new Error(r?.fehler ?? `HTTP ${antwort.status}`)
    erkannt = String(r.text ?? '').trim()
  } catch (e) {
    knopf.classList.remove('arbeitet')
    sprachStatusSetzen('bereit', `Spracherkennung nicht erreichbar: ${String(e?.message ?? e)}`, true)
    gespraechImGang = false
    return
  }

  if (!erkannt) {
    knopf.classList.remove('arbeitet')
    sprachStatusSetzen('bereit', 'Nichts verstanden — noch einmal versuchen', true)
    gespraechImGang = false
    return
  }

  gespraechVerlauf.push({ rolle: 'du', text: erkannt })
  verlaufZeichnen()
  sprachStatusSetzen('denkt…', erkannt)

  let antwortText
  try {
    const r = await fetch(api('/api/gespraech'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: erkannt, sessionId: gespraechSessionId }),
    }).then(async (x) => {
      const daten = await x.json().catch(() => ({}))
      if (!x.ok) throw new Error(daten?.fehler ?? `HTTP ${x.status}`)
      return daten
    })
    antwortText = String(r.text ?? '').trim()
    gespraechSessionId = r.sessionId ?? gespraechSessionId
  } catch (e) {
    knopf.classList.remove('arbeitet')
    sprachStatusSetzen('bereit', `Antwort nicht bekommen: ${String(e?.message ?? e)}`, true)
    gespraechImGang = false
    return
  }

  gespraechVerlauf.push({ rolle: 'cockpit', text: antwortText })
  verlaufZeichnen()
  sprachStatusSetzen('spricht', antwortText)
  knopf.classList.remove('arbeitet')

  // sagen() respektiert die Stimmwahl selbst (aus -> bleibt stumm, nur Text
  // steht schon im Verlauf oben) -- hier nichts zusaetzlich pruefen.
  await stimme.sagen(antwortText, { wichtig: true })

  sprachStatusSetzen('bereit', 'Tippen zum Sprechen')
  gespraechImGang = false
}

async function sprechenTesten() {
  await sp.aufwecken()
  await stimme.sagen('Der Kern ist wach und hört zu.', { erzwingen: true })
}

/** Wie stark das System arbeitet: treibt den Herzschlag. */
function lastAnteil() {
  const aktive = letzteAgenten.filter((a) => AKTIV.has(a.status)).length
  // Der eigene Host (lokal gemessen), nicht einfach der erste: mit zwei
  // Hosts steht alphabetisch serverone vorn, die Agenten laufen aber hier.
  const hosts = letztesSystem?.hosts ?? []
  const eigener = hosts.find((h) => h.quelle === 'lokal') ?? hosts[0]
  const cpu = eigener?.cpuProzent ?? 0
  return Math.min(1, aktive * 0.34 + cpu / 160)
}

/**
 * Einen Agenten aus REST (snake_case) oder Live-Strom (camelCase) einpflegen.
 * Schluessel ist Lauf + Agent: 'chat' heisst der Agent in jedem Chat-Lauf.
 */
function agentEinpflegen(a) {
  const neu = {
    runId: a.runId ?? a.run_id, agentId: a.agentId ?? a.agent_id, label: a.label,
    status: a.status, role: a.role, fachrolle: a.fachrolle,
    weightedTokens: a.weightedTokens ?? a.weighted_tokens,
  }
  const i = letzteAgenten.findIndex((x) => x.agentId === neu.agentId && x.runId === neu.runId)
  if (i >= 0) letzteAgenten[i] = neu
  else letzteAgenten.push(neu)
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

/** Ein Ring wie in der Server-Auslastung -- gemeinsam fuer Konten und Hosts. */
function zRing(titel, wert, zusatz, groesse = 62) {
  const p = wert === null || wert === undefined ? null : Math.round(wert)
  const farbe = p === null ? 'var(--surface1)'
    : p >= 85 ? 'var(--fehler)' : p >= 60 ? 'var(--werkzeug)' : 'var(--hud)'
  return `<div class="z-ring">
    <div class="hud-ring" style="--prozent:${p ?? 0};--ring-farbe:${farbe};--ring-groesse:${groesse}px"><div>
      <div class="hud-zahl" style="--zahl-groesse:14px">${p === null ? '—' : p + '%'}</div></div></div>
    <div class="z-ringtitel">${titel}</div><div class="z-ringnote">${zusatz ?? ''}</div></div>`
}

/**
 * Nutzungsfenster BEIDER Konten -- vorher zeigte diese Kachel nur das
 * zuletzt aktive Konto (aus dem globalen 'limit'-Strom). Die Daten kommen
 * jetzt aus /api/konten, derselben Quelle wie der Server-Tab.
 */
function kontenZeichnen() {
  const liste = wurzel?.querySelector('#z-limitliste')
  const modusEl = wurzel?.querySelector('#z-limitmodus')
  if (!liste) return
  if (modusEl) {
    modusEl.textContent = letzterKontenModus === 'manuell' ? 'manuell' : 'ausgeglichen'
  }
  const angemeldet = letzteKonten.filter((k) => k.angemeldet)
  if (angemeldet.length === 0) {
    liste.innerHTML = '<div class="leer">keine Konten angemeldet</div>'
    wurzel.querySelector('#z-reset').textContent = ''
    return
  }
  liste.innerHTML = angemeldet.map((k) => {
    const wer = k.name === letztesNaechstesKonto ? ' · als naechstes' : ''
    const kopf = `${esc(k.name)}${k.bevorzugt ? ' · manuell' : wer}`
    return `<div class="z-kontoblock">
      <div class="z-kontoname" title="${esc(k.email ?? '')}">${kopf}</div>
      <div class="z-ringe">
        ${zRing('Woche', k.siebenTageAnteil === null ? null : k.siebenTageAnteil * 100, '', 50)}
        ${zRing('5 Std.', k.fuenfStundenAnteil === null ? null : k.fuenfStundenAnteil * 100, '', 50)}
      </div>
    </div>`
  }).join('')

  // Reset-Zeit des Kontos mit dem hoechsten Wochenanteil -- das ist die
  // Grenze, die als naechstes greift, wenn niemand eingreift.
  const engstes = angemeldet.reduce(
    (a, b) => (b.siebenTageAnteil ?? 0) > (a.siebenTageAnteil ?? 0) ? b : a, angemeldet[0],
  )
  // textContent, also kein esc() -- das wuerde ein & als &amp; anzeigen.
  // Ohne zwei gemessene Konten gibt es keinen Abstand, dann keine Zahl.
  const teile = []
  if (letzterAbstandPunkte !== null) teile.push(`Abstand ${letzterAbstandPunkte.toFixed(0)} Punkte`)
  if (engstes?.siebenTageAnteil !== null && engstes?.siebenTageAnteil !== undefined) {
    teile.push(`${engstes.name} am naechsten am Limit`)
  }
  wurzel.querySelector('#z-reset').textContent = teile.join(' · ')
}

async function kontenLaden() {
  try {
    const r = await fetch(api('/api/konten')).then((x) => x.json())
    letzteKonten = r.konten ?? []
    letzterAbstandPunkte = typeof r.abstandPunkte === 'number' ? r.abstandPunkte : null
    letzterKontenModus = r.modus ?? 'ausgeglichen'
    letztesNaechstesKonto = r.naechstesKonto ?? null
  } catch { /* Der naechste Poll oder das naechste 'limit'-Ereignis holt es nach. */ }
  kontenZeichnen()
}

function systemZeichnen() {
  const el = wurzel?.querySelector('#z-lastliste')
  if (!el || !letztesSystem) return
  const hosts = letztesSystem.hosts ?? []
  if (hosts.length === 0) { el.innerHTML = '<div class="leer">keine Daten</div>'; return }
  el.innerHTML = hosts.map((h) => {
    const temp = h.tempC === null || h.tempC === undefined ? '' : `${h.tempC.toFixed(0)} °C`
    return `<div class="z-hostblock">
      <div class="z-kontoname">${esc(h.name)}</div>
      <div class="z-ringe">
        ${zRing('CPU', h.cpuProzent, temp, 50)}
        ${zRing('Speicher', h.ramProzent, h.ramGesamtMb ? `${(h.ramGesamtMb / 1024).toFixed(1)} GB` : '', 50)}
        ${zRing('Platte', h.plattenProzent, h.plattenGesamtGb ? `${h.plattenGesamtGb} GB` : '', 50)}
      </div>
    </div>`
  }).join('')
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
    // 'agenten' ist die Nachlieferung fuer den Lauf, den der Lauf-Tab gerade
    // zeigt -- nur EIN Lauf. Einpflegen statt ersetzen: wer dort einen alten
    // Lauf aufschlug, loeschte sonst hier die Agenten des laufenden.
    abmelden.push(abonnieren('agenten', (d) => {
      for (const a of d ?? []) agentEinpflegen(a)
      agentenZeichnen()
    }))
    abmelden.push(abonnieren('agent', (a) => {
      agentEinpflegen(a)
      agentenZeichnen()
    }))
    abmelden.push(abonnieren('ereignis', (e) => {
      ereignisse.push(e)
      if (ereignisse.length > 40) ereignisse.shift()
      stromZeichnen()
      const notiz = notizAus(e)
      if (notiz) kern?.anstossen(notiz)
    }))
    // 'limit' kommt nur vom zuletzt aktiven Konto -- als Stossimpuls, die
    // eigentlichen (Zwei-Konten-)Daten holt kontenLaden() ueber /api/konten.
    abmelden.push(abonnieren('limit', () => void kontenLaden()))
    abmelden.push(abonnieren('system', (s) => { letztesSystem = s; systemZeichnen() }))
    abmelden.push(beiZustand((z) => {
      const s = wurzel?.querySelector('#z-sprachstatus')
      if (s) s.textContent = z === 'verbunden' ? 'bereit' : 'getrennt'
    }))

    try {
      const [sys] = await Promise.all([
        fetch(api('/api/system')).then((r) => r.json()),
        kontenLaden(),
      ])
      letztesSystem = sys
      systemZeichnen()
    } catch { /* der Live-Strom liefert es gleich nach */ }

    // Kein Live-Kanal fuer Konten -- gepollt, aber nur solange der Tab
    // offen ist (siehe sichtbar()), damit ein Hintergrundtab nicht mitzaehlt.
    if (kontenIntervall) clearInterval(kontenIntervall)
    kontenIntervall = setInterval(() => { if (vorn) void kontenLaden() }, 15_000)

    // Erstbefuellung des Agenten-Panels: die obigen abonnieren()-Aufrufe
    // zeigen nur, was ab JETZT passiert. Laeuft schon ein Auftrag, wenn diese
    // Seite (neu) geladen wird -- der Normalfall bei einem Reload waehrend
    // eines laengeren Orchestrator-Laufs --, bliebe die Karte sonst bis zum
    // naechsten Ereignis leer, obwohl laengst etwas laeuft. Anders als der
    // Lauf-Tab (der /api/lauf/<id> beim Mount abfragt) hatte Zentrale bisher
    // ueberhaupt keinen REST-Weg fuer den aktuellen Stand.
    try {
      const { laeufe } = await fetch(api('/api/laeufe')).then((r) => r.json())
      for (const l of (laeufe ?? []).filter((x) => x.status === 'running')) {
        const d = await fetch(api(`/api/lauf/${l.run_id}`)).then((r) => r.json())
        for (const a of d.agenten ?? []) agentEinpflegen(a)
      }
      agentenZeichnen()
    } catch { /* kein Beinbruch: die Karte bleibt leer, bis das erste Live-Ereignis kommt */ }

    // Die verfuegbaren Fachrollen anzeigen: ohne sie zu kennen schreibt
    // niemand eine AN-ROLLE-Zeile.
    try {
      const r = await fetch(api('/api/rollen')).then((x) => x.json())
      const ids = (r.rollen ?? []).filter((x) => x.id !== 'orchestrator').map((x) => x.id)
      const el = wurzel.querySelector('#z-rollen')
      if (el && ids.length) el.textContent = ids.join(' · ')
    } catch { /* ohne Liste geht es auch, nur unbequemer */ }

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
      // Laeuft gerade ein Sprachgespraech, muss sp.messen() weiterlaufen --
      // sonst friert die Stille-Erkennung ein, weil niemand mehr den Pegel
      // abfragt, nur weil der Tab gerade nicht vorn ist.
      if (schleife && !hoeren.aufnahmeLaeuft() && !gespraechImGang) {
        cancelAnimationFrame(schleife)
        schleife = null
      }
    }
  },

  unmount() {
    for (const f of abmelden) { try { f() } catch { /* egal */ } }
    abmelden = []
    if (kontenIntervall) clearInterval(kontenIntervall)
    kontenIntervall = null
    if (schleife) cancelAnimationFrame(schleife)
    schleife = null
    kern?.abbauen()
    kern = null
  },
}

/**
 * Eigene Schleife fuer Pegel und Wellenform -- der Kern hat seine eigene.
 *
 * Den Sprachstatus-Text zeichnet diese Schleife NICHT mehr selbst: der
 * gehoert jetzt der Gespraechsrunde (sprachStatusSetzen), die Zustaende wie
 * "versteht…" oder "denkt…" kennt, die der reine Pegel (still/hört/spricht)
 * nicht ausdruecken kann. Wuerde hier weiter jedes Bild ueberschrieben,
 * faelen diese Zustaende sofort wieder auf "hört zu"/"bereit" zurueck.
 */
function rahmen() {
  const bild = (jetzt) => {
    const beschaeftigt = hoeren.aufnahmeLaeuft() || gespraechImGang
    if (!vorn && !beschaeftigt) { schleife = null; return }
    schleife = requestAnimationFrame(bild)
    const s = sp.messen(jetzt)
    if (!vorn) return // Pegel aktuell halten, aber nichts zeichnen -- Tab ist nicht sichtbar.
    kern?.pegelSetzen(s.pegel)
    kern?.lastSetzen(lastAnteil())
    if (welle) {
      const b = welle.clientWidth || 300
      if (welle.width !== b) welle.width = b
      sp.wellenformZeichnen(welle, s.quelle === 'still' ? '#3b5570' : '#6fe3ff')
    }
  }
  schleife = requestAnimationFrame(bild)
}
