/**
 * Chat-Ansicht -- Bedienung wie Claude Desktop.
 *
 * Ein Chat ist eine Session-Id. Der gespeicherte Verlauf kommt aus der
 * Sitzungsdatei (GET /api/chats/:id, schon normalisiert), ein laufender Zug
 * ueber den Bus: Ereignisse tragen dieselbe normalisierte `nachricht`
 * (nachrichten.ts), dazu Live-Text als `delta`. Beide Wege landen in
 * derselben Liste und werden mit demselben Code gezeichnet.
 *
 * Nach dem Ende eines Zugs wird der Verlauf einmal frisch aus der Datei
 * gelesen: sie ist die Wahrheit (die CLI schreibt sie selbst), und so
 * verschwinden Luecken, falls die Verbindung zwischendurch weg war.
 */
import * as bus from '../bus.js'
import { h, symbol, api, leeren, uhrzeit, pfadKurz, modellName, melden, fehlerText } from './dom.js'
import { markdown } from './markdown.js'
import { werkzeugZeichnen, rollenSetzen, todoListe, kopfDaten } from './werkzeuge.js'
import { aktuelleTodos } from './taskliste.js'
import { eingabeBauen, einstellungenHolen, NUR_ANHANG_TEXT } from './eingabe.js'
import { AKZENTE, akzentLesen, akzentSetzen } from '../akzent.js'
import { anhaengeTrennen, mitAnhaengen, istBild } from './anhangtext.js'
import { freigabeKarteBauen, freigabeNormalisieren } from './freigabekarten.js'
import { vorschauBauen } from './vorschau.js'
import { variante } from '../variante.js'

const ENDZUSTAENDE = new Set(['done', 'failed', 'stopped', 'waiting_ratelimit'])
const AUFWAND_TEXT = { low: 'niedrig', medium: 'mittel', high: 'hoch', xhigh: 'sehr hoch', max: 'maximal' }
const SCHREIB_WERKZEUGE = new Set(['Write', 'Edit', 'MultiEdit'])

export function chatBereich({ beiNeuemChat, beiTitel } = {}) {
  // --- Zustand --------------------------------------------------------------
  let id = null          // Session-Id; null = neuer, noch leerer Chat
  let kopf = null
  let laufId = null
  let todoStand = { todos: null, namen: new Map() } // aktuelle To-do-Liste (taskliste.js)
  let laeuft = false
  let nachrichten = []
  let ids = new Set()
  let gekuerzt = false
  let freigaben = new Map()
  let live = { text: '', denken: '' }
  let status = null       // Status des Chat-Agenten (thinking/tool/writing/...)
  let ladeNr = 0          // gegen spaet eintreffende Antworten eines vorigen Chats
  let offen = new Set()   // aufgeklappte Werkzeuge ueber Neuzeichnen hinweg
  let hinweise = []       // Hinweise dieses Zugs (Kontowechsel, Limit, Fehler)
  let optionenGeholt = false // gemerkte Chat-Optionen nur beim Oeffnen, nicht nach jedem Zug
  let warteschlange = []  // Nachrichten, die nach dem laufenden Zug rausgehen (daemon.ts)
  let letzterSchlangenStart = null // startSeq -- Bus und Antwort melden denselben Start

  // --- Geruest --------------------------------------------------------------
  const titelEl = h('div.chat-titel')
  const metaEl = h('div.chat-meta')
  const kopfEl = h('header.chat-kopf', {}, h('div.chat-kopf-text', {}, titelEl, metaEl))
  const verlaufEl = h('div.verlauf', { role: 'log', 'aria-live': 'off' })
  const liveEl = h('div.live')
  const freigabenEl = h('div.freigaben')
  const innen = h('div.verlauf-innen', {}, verlaufEl, liveEl, freigabenEl)
  const scroller = h('div.verlauf-scroll', {}, innen)
  const eingabe = eingabeBauen({ beiSenden: senden, beiStopp: anhalten })
  const vorschau = vorschauBauen({
    beiKommentar: (t) => eingabe.textAnhaengen(t),
    beiOffen: (an) => el.classList.toggle('mit-vorschau', an),
  })
  const schlangeEl = h('div.schlange', { hidden: true, 'aria-live': 'polite' })
  const el = h('section.chat', {}, kopfEl, scroller, vorschau.leiste, schlangeEl, eingabe.el, vorschau.el)
  // Anderer Bereich (Aufgaben, Terminal ...): Vorschau zu, Ton und Video aus.
  new MutationObserver(() => { if (!el.classList.contains('an')) vorschau.schliessen() })
    .observe(el, { attributes: true, attributeFilter: ['class'] })
  // Schreibende Werkzeugaufrufe, deren Ergebnis noch aussteht (id -> Pfad):
  // erst mit dem Ergebnis steht die Datei, dann laedt die Vorschau neu.
  const schreibend = new Map()

  api('/api/rollen').then((d) => { rollenSetzen(d.rollen); neuZeichnen() }).catch(() => {})

  // Unten kleben, solange man unten ist -- wer hochscrollt, um etwas
  // nachzulesen, soll nicht bei jedem Wort zurueckgerissen werden.
  let klebt = true
  scroller.addEventListener('scroll', () => {
    klebt = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  }, { passive: true })
  const nachUnten = (erzwingen = false) => {
    if (erzwingen || klebt) scroller.scrollTop = scroller.scrollHeight
  }

  // --- Laden ----------------------------------------------------------------
  async function zeigen(neueId) {
    if (neueId === id && neueId !== null) return
    const nr = ++ladeNr
    id = neueId
    kopf = null
    laufId = null
    laeuft = false
    nachrichten = []
    ids = new Set()
    gekuerzt = false
    freigaben = new Map()
    live = { text: '', denken: '' }
    status = null
    offen = new Set()
    hinweise = []
    optionenGeholt = false
    warteschlange = []
    letzterSchlangenStart = null
    schlangeZeichnen()
    schreibend.clear()
    vorschau.zuruecksetzen()
    eingabe.laeuftSetzen(false)
    eingabe.ordnerFestlegen(null)
    klebt = true

    if (!id) {
      // Neuer Chat: Modell, Aufwand und Modus wieder aus den Einstellungen.
      eingabe.optionenSetzen(null)
      kopfZeichnen()
      leeren(verlaufEl, willkommen())
      leeren(liveEl); leeren(freigabenEl)
      eingabe.fokus()
      return
    }
    kopfZeichnen()
    leeren(verlaufEl, h('div.laedt', {}, h('span.kreisel'), 'Verlauf wird geladen …'))
    leeren(liveEl); leeren(freigabenEl)
    try {
      await verlaufLaden(nr)
    } catch (e) {
      if (nr !== ladeNr) return
      leeren(verlaufEl, h('div.fehlerbox', {},
        h('strong', {}, e.status === 404 ? 'Diesen Chat gibt es nicht (mehr).' : 'Der Chat konnte nicht geladen werden.'),
        h('div', {}, fehlerText(e)),
        e.status === 404 ? null : h('button.knopf', { type: 'button', onclick: () => { const x = id; id = null; zeigen(x) } }, 'Nochmal versuchen')))
      return
    }
    vorschau.laden(id)
    eingabe.fokus()
  }

  async function verlaufLaden(nr = ladeNr) {
    const d = await api(`/api/chats/${encodeURIComponent(id)}`)
    if (nr !== ladeNr) return
    kopf = { ...d.kopf, titel: d.kopf.titel ?? kopf?.titel ?? null }
    gekuerzt = d.gekuerzt
    // Leere Datei, aber hier stehen schon Nachrichten: der erste Zug ist
    // gescheitert, bevor die CLI etwas geschrieben hat. Die eigene Eingabe
    // soll dann nicht verschwinden.
    if (d.nachrichten.length || !nachrichten.length) nachrichten = d.nachrichten
    ids = new Set(nachrichten.map((n) => n.id).filter(Boolean))
    laufId = kopf.fortsetzung?.laufId ?? `chat-${id}`
    eingabe.ordnerFestlegen(kopf.fortsetzung?.cwd ?? kopf.zielCwd ?? kopf.cwd)
    // Spaeter nicht mehr: wer waehrend eines Zugs den Modus umstellt, dem
    // soll ihn das Neuladen nach dem Zug nicht zuruecksetzen.
    if (!optionenGeholt) { optionenGeholt = true; eingabe.optionenSetzen(d.optionen) }
    warteschlange = d.warteschlange ?? []
    const lief = kopf.fortsetzung?.laeuft
    laeuftSetzen(Boolean(lief))
    if (lief) {
      await laufNachholen(nr, kopf.fortsetzung.startSeq ?? 0)
      // Wettlauf beim Anhalten: der Agent ist schon 'stopped', der Server
      // raeumt den Zug aber erst einen Moment spaeter ab. Ohne diesen
      // Nachgang stuende "Claude arbeitet" fuer immer da -- es kommt kein
      // Ereignis mehr, das es beendet. zugBeendet prueft nach kurzer Pause
      // erneut und laedt dann wieder.
      if (nr === ladeNr && ENDZUSTAENDE.has(status)) zugBeendet({})
    } else {
      // Auch ohne laufenden Zug koennen Freigaben offen sein -- etwa nach
      // einem Neuladen der Seite, waehrend der Zug wartet. Die kaemen sonst
      // nie wieder in Sicht.
      await laufNachholen(nr, kopf.fortsetzung?.startSeq ?? 0, true)
    }
    kopfZeichnen()
    neuZeichnen()
    nachUnten(true)
  }

  /** Ereignisse und offene Freigaben des aktuellen Zugs nachladen. */
  async function laufNachholen(nr, seit, nurFreigaben = false) {
    let d
    try {
      d = await api(`/api/lauf/${encodeURIComponent(laufId)}?seit=${seit}`)
    } catch {
      return
    }
    if (nr !== ladeNr) return
    for (const f of d.freigaben ?? []) freigabeAufnehmen(f)
    if (nurFreigaben) return
    const agent = (d.agenten ?? []).find((a) => a.agentId === 'chat')
    if (agent) status = agent.status
    for (const e of d.ereignisse ?? []) ereignisVerarbeiten(e, false)
  }

  // --- Bus ------------------------------------------------------------------
  bus.abonnieren('ereignis', (e) => {
    if (!laufId || e?.runId !== laufId) return
    ereignisVerarbeiten(e, true)
  })
  bus.abonnieren('delta', (d) => {
    if (!laufId || d?.runId !== laufId || d.eltern) return
    if (d.neu) live[d.art === 'denken' ? 'denken' : 'text'] = ''
    live[d.art === 'denken' ? 'denken' : 'text'] += d.text
    liveZeichnen()
  })
  // Umbenannt (in der Liste, evtl. auf einem anderen Geraet).
  bus.abonnieren('chats', (d) => {
    if (!d?.titel || d.id !== id || !kopf || kopf.titel === d.titel) return
    kopf = { ...kopf, titel: d.titel }
    kopfZeichnen()
  })
  bus.abonnieren('agent', (a) => {
    if (!laufId || a?.runId !== laufId || a.agentId !== 'chat') return
    status = a.status
    if (ENDZUSTAENDE.has(a.status)) zugBeendet(a)
    else { laeuftSetzen(true); liveZeichnen() }
  })
  // Warteschlange geaendert (auch von einem anderen Geraet) oder als
  // naechster Zug gestartet.
  bus.abonnieren('warteschlange', (d) => {
    if (!id || d?.id !== id) return
    warteschlange = d.eintraege ?? []
    if (d.gestartet) schlangeGestartet(d.gestartet)
    if (d.fehler) melden(`Warteschlange nicht gesendet: ${d.fehler}`, 'fehler')
    schlangeZeichnen()
  })
  bus.abonnieren('freigabe', (f) => {
    if (!laufId || f?.runId !== laufId) return
    freigabeAufnehmen(f)
  })
  // Nach dem Wiederverbinden koennte etwas verpasst worden sein.
  bus.beiZustand((z) => {
    if (z === 'verbunden' && id && laeuft) verlaufLaden().catch(() => {})
  })

  function ereignisVerarbeiten(e, zeichnen) {
    if (e.nachricht) {
      const n = e.nachricht
      if (n.id && ids.has(n.id)) return
      if (n.id) ids.add(n.id)
      // Die eigene Eingabe steht schon als Platzhalter da (senden()). Die SDK
      // wiederholt sie nicht, falls doch: nicht doppelt zeigen.
      if (n.rolle === 'user' && n.bloecke.every((b) => b.typ === 'text')) {
        const letzte = nachrichten.at(-1)
        if (letzte?.vorlaeufig && letzte.bloecke[0]?.text === n.bloecke[0]?.text) return
      }
      nachrichten.push(n)
      for (const b of n.bloecke) {
        if (b.typ === 'werkzeug' && SCHREIB_WERKZEUGE.has(b.name) && typeof b.eingabe?.file_path === 'string') schreibend.set(b.id, b.eingabe.file_path)
        else if (b.typ === 'ergebnis' && schreibend.has(b.zu)) { vorschau.geschrieben(schreibend.get(b.zu)); schreibend.delete(b.zu) }
      }
      // Sobald die fertige Nachricht da ist, ist der Live-Text ueberholt.
      if (n.rolle === 'assistant' && !n.eltern) live = { text: '', denken: '' }
    } else if (e.kind === 'permission_decision') {
      const fid = e.payload?.id
      if (fid && freigaben.delete(String(fid))) freigabenZeichnen()
    } else if ((e.kind === 'error' && !/^Lauf endet mit Fehler|Operation aborted|aborted by user/.test(e.summary ?? '')) || (e.kind === 'rate_limit' && e.payload?.istLimit)) {
      // rate_limit ohne istLimit ist nur der laufende Nutzungsstand der SDK
      // ("Limit allowed 40 %") -- kein Grund, den Chat zu unterbrechen. Und
      // "Lauf endet mit Fehler (...)" ist nur das Echo des eigentlichen Fehlers.
      // "Operation aborted" ist das Anhalten selbst -- kein Fehler, dafuer
      // steht am Zugende "Angehalten".
      hinweisDazu(e.kind === 'error' ? 'fehler' : 'limit', e.summary)
    } else if (e.kind === 'protocol' && e.payload?.modellwahl) {
      // Automatik (modellwahl.ts): welches Modell diesen Zug bzw. einen Spezialisten bekam.
      const w = e.payload.modellwahl
      const fuer = w.fuer ? `${(e.summary ?? '').match(/fuer ([^:]+):/)?.[1] ?? w.fuer}: ` : ''
      hinweisDazu('modell', w.automatisch
        ? `${fuer}${modellName(w.modell)}${w.aufwand ? ` · Denken ${AUFWAND_TEXT[w.aufwand] ?? w.aufwand}` : ''}${w.grund ? ` – ${w.grund}` : ''}`
        : `Modellwahl ausgefallen, weiter mit ${modellName(w.modell)}`)
    } else if (e.kind === 'protocol' && e.payload?.nach) {
      // Kontowechsel des Supervisors: ruhig erwaehnen, der Zug laeuft weiter.
      hinweisDazu('info', `Konto gewechselt: weiter mit „${e.payload.nach}“ (${e.payload.von} nicht nutzbar).`)
    } else return
    if (zeichnen) planeZeichnen()
  }

  function hinweisDazu(art, text) {
    if (!hinweise.some((x) => x.text === text)) hinweise.push({ art, text })
  }

  let geplant = false
  function planeZeichnen() {
    if (geplant) return
    geplant = true
    requestAnimationFrame(() => { geplant = false; neuZeichnen(); nachUnten() })
  }

  // Ein Endzustand ist nicht immer endgueltig: scheitert ein Konto, setzt
  // der Supervisor den Agenten erst auf 'waiting_ratelimit'/'failed' und
  // gleich darauf mit dem naechsten Konto wieder auf 'starting'. Deshalb
  // kurz abwarten und erst dann abschliessen -- sonst stuende "Alle Konten
  // im Limit" im Chat, waehrend er in Wahrheit weiterlaeuft.
  let endeTimer = null
  function zugBeendet(a) {
    if (!laeuft) return
    clearTimeout(endeTimer)
    const x = id
    endeTimer = setTimeout(() => {
      if (id !== x || !ENDZUSTAENDE.has(status)) return
      laeuftSetzen(false)
      live = { text: '', denken: '' }
      liveZeichnen()
      const schonFehler = hinweise.some((h0) => h0.art === 'fehler' || h0.art === 'limit')
      if (status === 'failed' && !schonFehler) hinweisDazu('fehler', `Der Zug ist fehlgeschlagen${a.lastError ? `: ${a.lastError}` : '.'}`)
      if (status === 'waiting_ratelimit') hinweisDazu('limit', 'Kein Konto ist gerade nutzbar (Limit oder Anmeldung) -- der Zug wurde angehalten.')
      if (status === 'stopped') hinweisDazu('info', 'Angehalten.')
      // Die Datei ist die Wahrheit; die Hinweise dieses Zugs stehen nicht
      // darin und bleiben erhalten.
      const h0 = hinweise
      verlaufLaden().then(() => { hinweise = h0; neuZeichnen() }).catch(() => neuZeichnen())
      vorschau.laden(x)
    }, 1200)
  }

  function laeuftSetzen(an) {
    laeuft = an
    eingabe.laeuftSetzen(an)
    el.classList.toggle('laeuft', an)
    schlangeZeichnen()
  }

  // --- Senden / Anhalten ----------------------------------------------------
  async function senden(text, optionen) {
    // So, wie der Daemon den Prompt baut -- dann erkennt ereignisVerarbeiten
    // die wiederholte Eingabe und nutzerBlase zeigt die Anhaenge gleich.
    const prompt = mitAnhaengen(text, optionen.anhaenge ?? [])
    const vorlaeufig = { id: '', rolle: 'user', ts: Date.now(), bloecke: [{ typ: 'text', text: prompt }], modell: null, eltern: null, vorlaeufig: true }
    if (!id) {
      const r = await api('/api/chats', { body: { text, ...optionen } })
      ladeNr++
      id = r.id
      laufId = r.laufId
      // Die Auswahl steht schon im Eingabefeld -- nicht beim ersten
      // Nachladen mit dem gemerkten Stand ueberschreiben (z.B. nach "Plan umsetzen").
      optionenGeholt = true
      vorschau.laden(id)
      kopf = { titel: text.slice(0, 60), cwd: r.cwd, zielCwd: r.cwd, fortsetzung: { laufId: r.laufId, cwd: r.cwd } }
      eingabe.ordnerFestlegen(r.cwd)
      nachrichten = [vorlaeufig]
      hinweise = []
      laeuftSetzen(true)
      status = 'starting'
      kopfZeichnen()
      neuZeichnen()
      beiNeuemChat?.(id, kopf.titel)
    } else {
      const { cwd, ...rest } = optionen
      const r = await api(`/api/chats/${encodeURIComponent(id)}/weiter`, { body: { text, ...rest } })
      // Claude arbeitet noch: die Nachricht wartet und geht danach raus.
      if (r.eingereiht) {
        warteschlange = r.warteschlange ?? warteschlange
        schlangeZeichnen()
        return
      }
      laufId = r.laufId
      hinweise = []
      // Lag noch etwas in der Warteschlange, ging es vorneweg mit raus.
      if (r.prompt) vorlaeufig.bloecke[0].text = r.prompt
      nachrichten.push(vorlaeufig)
      laeuftSetzen(true)
      status = 'starting'
      neuZeichnen()
    }
    liveZeichnen()
    nachUnten(true)
  }

  // --- Warteschlange ----------------------------------------------------------
  /** Der Server hat die Warteschlange als naechsten Zug gestartet. */
  function schlangeGestartet(g) {
    if (g.startSeq === letzterSchlangenStart) return
    letzterSchlangenStart = g.startSeq
    laufId = g.laufId
    // Scheiterte der vorige Zug, soll das sichtbar bleiben -- der naechste
    // startet sofort, und zugBeendet kommt dann nicht mehr zum Zug.
    hinweise = hinweise.filter((x) => x.art === 'fehler' || x.art === 'limit')
    nachrichten.push({ id: '', rolle: 'user', ts: Date.now(), bloecke: [{ typ: 'text', text: g.prompt }], modell: null, eltern: null, vorlaeufig: true })
    laeuftSetzen(true)
    status = 'starting'
    neuZeichnen()
    liveZeichnen()
    nachUnten(true)
  }

  async function schlangeSenden() {
    try {
      const r = await api(`/api/chats/${encodeURIComponent(id)}/warteschlange/senden`, { method: 'POST' })
      warteschlange = []
      schlangeGestartet(r)
      schlangeZeichnen()
    } catch (e) {
      melden(`Warteschlange nicht gesendet: ${fehlerText(e)}`, 'fehler')
    }
  }

  /** Zuruecknehmen: raus aus der Schlange, zurueck ins Eingabefeld -- zum Aendern oder Verwerfen. */
  async function schlangeZuruecknehmen(e) {
    try {
      const r = await api(`/api/chats/${encodeURIComponent(id)}/warteschlange/${e.nr}`, { method: 'DELETE' })
      warteschlange = r.eintraege ?? []
      if (e.text !== NUR_ANHANG_TEXT || !e.anhaenge?.length) eingabe.textAnhaengen(e.text)
      if (e.anhaenge?.length) eingabe.anhaengeUebernehmen(e.anhaenge)
      schlangeZeichnen()
    } catch (f) {
      // 404: schon losgeschickt -- dann ist nichts mehr zurueckzunehmen.
      melden(f.status === 404 ? 'Die Nachricht ist schon unterwegs.' : `Nicht zurückgenommen: ${fehlerText(f)}`, f.status === 404 ? 'info' : 'fehler')
    }
  }

  function schlangeZeichnen() {
    schlangeEl.hidden = !warteschlange.length
    if (!warteschlange.length) { leeren(schlangeEl); return }
    const n = warteschlange.length
    const titel = `${n} ${n === 1 ? 'Nachricht wartet' : 'Nachrichten warten'}`
    const gehalten = warteschlange.filter((e) => e.gehalten).length
    // Gehalten (nach Anhalten, Limit oder Neustart) geht nur auf Cans Knopfdruck raus.
    const unter = laeuft
      ? (gehalten === n ? 'Angehalten – sie gehen erst raus, wenn du willst' : 'Claude liest sie, sobald er fertig ist')
      : 'Nicht gesendet – sie gehen erst raus, wenn du willst'
    leeren(schlangeEl, h('div.schlange-rahmen', {},
      h('div.schlange-kopf', {},
        h('span.schlange-titel', {}, titel),
        h('span.leise', {}, unter),
        laeuft ? null : h('button.knopf.knopf-schmal.primaer', { type: 'button', onclick: schlangeSenden }, symbol('senden', 14), 'Jetzt senden')),
      warteschlange.map((e) => h('div.schlange-eintrag', {},
        h('span.schlange-text', { title: e.text }, e.text === NUR_ANHANG_TEXT && e.anhaenge?.length ? 'Nur Anhänge' : e.text),
        e.gehalten && laeuft && gehalten < n ? h('span.marke-klein', { title: 'Geht erst raus, wenn du „Jetzt senden“ drückst' }, 'angehalten') : null,
        e.anhaenge?.length ? h('span.leise.klein', {}, `+ ${e.anhaenge.length} ${e.anhaenge.length === 1 ? 'Anhang' : 'Anhänge'}`) : null,
        h('button.knopf-klein', { type: 'button', title: 'Zurücknehmen (zurück ins Eingabefeld)', 'aria-label': 'Nachricht zurücknehmen', onclick: () => schlangeZuruecknehmen(e) }, symbol('kreuz', 14))))))
  }

  async function anhalten() {
    if (!laufId) return
    try {
      await api('/api/abbrechen', { body: { runId: laufId, agentId: 'chat' } })
    } catch (e) {
      melden(`Anhalten fehlgeschlagen: ${fehlerText(e)}`, 'fehler')
    }
  }

  // --- Zeichnen -------------------------------------------------------------
  function kopfZeichnen() {
    if (!id) {
      leeren(titelEl, 'Neuer Chat')
      leeren(metaEl)
      document.title = document.documentElement.dataset.appName || 'Cockpit'
      beiTitel?.('Neuer Chat')
      return
    }
    const titel = kopf?.titel || 'Chat'
    leeren(titelEl, titel)
    document.title = `${titel} – ${document.documentElement.dataset.appName || 'Cockpit'}`
    beiTitel?.(titel)
    const teile = []
    const cwd = kopf?.fortsetzung?.cwd ?? kopf?.zielCwd ?? kopf?.cwd
    if (cwd) teile.push(h('span.meta-teil', { title: cwd }, symbol('ordner', 12), pfadKurz(cwd)))
    const modell = [...nachrichten].reverse().find((n) => n.modell)?.modell
    if (modell) teile.push(h('span.meta-teil', {}, modellName(modell)))
    if (kopf?.quelle === 'desktop') teile.push(h('span.meta-teil', { title: 'Vom PC (Claude Desktop/CLI) gespiegelt' }, 'vom PC'))
    if (kopf && kopf.hierVorhanden === false && kopf.cwd) {
      teile.push(h('span.meta-teil.warnung', { title: `Der Ordner ${kopf.cwd} existiert auf dem Server nicht -- weitergeschrieben wird in ${cwd}` }, 'anderer Ordner'))
    }
    leeren(metaEl, teile)
  }

  function willkommen() {
    const vorschlaege = variante.vorschlaege ?? [
      'Was hat sich heute auf den Servern getan?',
      'Erklär mir den Aufbau dieses Projekts.',
      'Plane mir ein neues Feature, bevor du etwas änderst.',
    ]
    // Wie fastfetch im Terminal: Logo und echte Werte (Konto, Modell, Modus,
    // Aufgaben, Server). Die Farbbloecke darunter wechseln den Akzent.
    const zeilen = h('dl.fetch-zeilen', { 'aria-live': 'polite' }, h('dt', {}, 'Lädt'), h('dd', {}, '…'))
    const farben = h('div.fetch-farben', { role: 'group', 'aria-label': 'Akzentfarbe' })
    const farbenZeichnen = () => {
      const jetzt = akzentLesen()
      leeren(farben, AKZENTE.map((x) => h('button.farbblock', {
        type: 'button', title: x.name, 'aria-label': `Akzent ${x.name}`, 'aria-pressed': String(x.id === jetzt),
        style: { '--a': x.a, '--b': x.b }, onclick: () => { akzentSetzen(x.id); farbenZeichnen() },
      })))
    }
    farbenZeichnen()
    fetchLaden(zeilen)
    return h('div.willkommen', {},
      h('div.willkommen-titel', {}, 'Womit fangen wir an?'),
      h('div.fetch', {},
        logoBauen(),
        h('div.fetch-kopf', {}, variante.nutzer, h('span', {}, '@'), variante.id === 'haupt' ? 'cockpit' : variante.id),
        zeilen, farben),
      h('div.vorschlaege', {}, vorschlaege.map((v) =>
        h('button.vorschlag', { type: 'button', onclick: () => { eingabe.textSetzen(v); eingabe.fokus() } }, v))))
  }

  /** Logo der Seitenleiste (index.html) als Kopie mit eigener Verlaufs-Id -- folgt so dem Akzent. */
  function logoBauen() {
    const svg = document.querySelector('.marke-logo svg')?.cloneNode(true)
    if (!svg) return h('span')
    svg.querySelector('linearGradient').id = 'logo-fetch'
    for (const el of svg.querySelectorAll('[fill^="url"], [stroke^="url"]')) {
      for (const a of ['fill', 'stroke']) if (el.getAttribute(a)?.startsWith('url')) el.setAttribute(a, 'url(#logo-fetch)')
    }
    svg.removeAttribute('width'); svg.removeAttribute('height')
    svg.setAttribute('class', 'fetch-logo')
    return svg
  }

  /** Werte fuer den fastfetch-Block. Was nicht laedt, faellt einfach weg. */
  async function fetchLaden(zeilen) {
    const [konten, vorgaben, aufgaben, system] = await Promise.allSettled([
      api('/api/konten'), einstellungenHolen(), api('/api/aufgaben'), api('/api/system')])
    const teile = []
    const zeile = (name, ...wert) => teile.push(h('dt', {}, name), h('dd', {}, ...wert))
    // Feste Leerzeichen (\u00a0): Zahl und Einheit reissen am Handy nicht auseinander.
    const prozent = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}\u00a0%` : '–')
    if (konten.status === 'fulfilled') {
      const d = konten.value
      const k = d.konten.find((x) => x.name === d.naechstesKonto && x.angemeldet) ?? d.konten.find((x) => x.angemeldet)
      if (k) {
        const gesperrt = k.gesperrtBis && k.gesperrtBis > Date.now()
        zeile('Konto', k.name, h('span.leise', {}, gesperrt ? ' · im Limit' : ` · 5\u00a0h\u00a0${prozent(k.fuenfStundenAnteil)} · Woche\u00a0${prozent(k.siebenTageAnteil)}`))
      }
    }
    if (vorgaben.status === 'fulfilled') {
      const { werte: w, modelle = [], aufwaende = [], berechtigungen = [] } = vorgaben.value
      const name = (liste, wert) => liste.find((x) => x.id === wert)?.name ?? wert
      zeile('Modell', name(modelle, w.modell), w.modell.includes('haiku') || w.modell === 'auto' ? null : h('span.leise', {}, ` · ${name(aufwaende, w.aufwand)}`))
      zeile('Modus', name(berechtigungen, w.berechtigung))
    }
    if (aufgaben.status === 'fulfilled') {
      const aktiv = (aufgaben.value.laeufe ?? []).filter((l) => l.laeuft)
      const wartet = aktiv.filter((l) => l.freigaben?.length || l.agenten?.some((a) => a.status === 'waiting_permission')).length
      teile.push(h('dt', {}, 'Aufgaben'), wartet
        ? h('dd.dran', {}, h('a', { href: '#/aufgaben', style: { color: 'inherit' } }, `${wartet} ${wartet === 1 ? 'wartet' : 'warten'} auf dich`))
        : h('dd', {}, aktiv.length ? `${aktiv.length} ${aktiv.length === 1 ? 'läuft' : 'laufen'}` : 'nichts läuft'))
    }
    if (system.status === 'fulfilled') {
      const hosts = system.value.hosts ?? []
      if (hosts.length) zeile('Server', hosts.map((x) => (x.status === 'ok' && typeof x.cpuProzent === 'number'
        ? `${x.name}\u00a0${Math.round(x.cpuProzent)}\u00a0%` : `${x.name}\u00a0offline`)).join(' · '), h('span.leise', {}, '\u00a0CPU'))
    }
    if (!zeilen.isConnected) return
    leeren(zeilen, teile.length ? teile : [h('dt', {}, 'Daemon'), h('dd', {}, 'keine Werte')])
  }

  /**
   * Verlauf zeichnen. Zusammengefuehrt wird hier:
   *  - Werkzeugergebnisse an ihre Aufrufe (Block 'ergebnis' -> zu),
   *  - Nachrichten von Subagenten (eltern) unter ihre Agent-Karte,
   *  - aufeinanderfolgende Antworten zu EINER Antwort (wie in Claude Desktop:
   *    Text, Werkzeuge, Text ... unter einem Absender).
   */
  function neuZeichnen() {
    if (!id) return
    // Offene Werkzeuge merken, damit Neuzeichnen sie nicht zuklappt.
    for (const d of verlaufEl.querySelectorAll('details[data-schluessel]')) {
      if (d.open) offen.add(d.dataset.schluessel); else offen.delete(d.dataset.schluessel)
    }
    todoStand = aktuelleTodos(nachrichten)
    const ergebnisse = new Map()
    const unter = new Map()
    const haupt = []
    for (const n of nachrichten) {
      for (const b of n.bloecke) if (b.typ === 'ergebnis') ergebnisse.set(b.zu, b)
      if (n.eltern) {
        if (!unter.has(n.eltern)) unter.set(n.eltern, [])
        unter.get(n.eltern).push(n)
      } else haupt.push(n)
    }

    const kinder = []
    if (gekuerzt) kinder.push(h('div.hinweis', {}, symbol('info', 14), 'Ältere Nachrichten sind ausgeblendet -- der Chat ist sehr lang.'))
    let antwort = null
    let eintraege = [] // Bloecke der laufenden Antwort, Schritte werden beim Schliessen gebuendelt
    let antwortModell = null
    const antwortSchliessen = () => {
      if (antwort) {
        antwort.append(h('div.antwort-kopf', {}, h('span.claude-marke'), h('span', {}, 'claude'),
          antwortModell ? h('span.antwort-modell', {}, modellName(antwortModell)) : null))
        antwort.append(...schritteBuendeln(eintraege, ergebnisse))
        kinder.push(antwort)
      }
      antwort = null
      eintraege = []
      antwortModell = null
    }

    for (const n of haupt) {
      const sichtbar = n.bloecke.filter((b) => b.typ !== 'ergebnis')
      if (!sichtbar.length) continue
      if (n.rolle === 'user') {
        const nurHinweis = sichtbar.every((b) => b.typ === 'hinweis')
        antwortSchliessen()
        if (nurHinweis) { for (const b of sichtbar) kinder.push(hinweisEl(b.text)); continue }
        kinder.push(nutzerBlase(n, sichtbar))
        continue
      }
      if (sichtbar.every((b) => b.typ === 'hinweis')) {
        antwortSchliessen()
        for (const b of sichtbar) kinder.push(hinweisEl(b.text, b.art ?? 'limit'))
        continue
      }
      if (!antwort) antwort = h('div.antwort')
      if (n.modell) antwortModell = n.modell
      for (const b of sichtbar) eintraege.push({ b, el: blockEl(b, ergebnisse, unter, n) })
    }
    antwortSchliessen()
    // Letzte Frage ohne Antwort und nichts laeuft: angehalten oder
    // abgebrochen (dasselbe wie zwischen zwei Fragen, src/nachrichten.ts).
    const letzte = haupt[haupt.length - 1]
    if (!laeuft && !hinweise.some((x) => x.art !== 'modell') && letzte?.rolle === 'user' && letzte.bloecke.some((b) => b.typ === 'text')) {
      kinder.push(hinweisEl('Ohne Antwort (angehalten oder abgebrochen).', 'info'))
    }
    for (const x of hinweise) kinder.push(hinweisEl(x.text, x.art))
    leeren(verlaufEl, kinder)
    kopfZeichnen()
    liveZeichnen()
  }

  function nutzerBlase(n, bloecke) {
    const { text, anhaenge } = anhaengeTrennen(bloecke.filter((b) => b.typ === 'text').map((b) => b.text).join('\n\n'))
    const bilder = bloecke.filter((b) => b.typ === 'bild').length
    // Terminal-Stil: Prompt-Zeile wie in der Shell (› can ~/ordner 14:02), darunter der Text.
    const ort = kopf?.fortsetzung?.cwd ?? kopf?.zielCwd ?? kopf?.cwd
    return h('div.nutzer', {},
      h('div.prompt-zeile', {},
        h('span.prompt-pfeil', { 'aria-hidden': 'true' }, symbol('pfeil', 13)),
        h('span.prompt-wer', {}, variante.nutzer),
        ort ? h('span.prompt-ort', {}, pfadKurz(ort)) : null,
        n.ts ? h('span.prompt-zeit', {}, uhrzeit(n.ts)) : null),
      h('div.blase', { title: uhrzeit(n.ts) }, text,
        anhaenge.length ? h('div.blase-anhaenge', {}, ...anhaenge.map(anhangEl)) : null,
        bilder ? h('div.bild-hinweis', {}, `${bilder} Bild${bilder > 1 ? 'er' : ''} angehängt`) : null))
  }

  /** Bild als Vorschau, andere Dateien als Name -- beides oeffnet die Datei. */
  function anhangEl(a) {
    const url = bus.api(`/api/anhaenge/datei?pfad=${encodeURIComponent(a.pfad)}`)
    if (istBild(a.name)) {
      return h('a.blase-bild', { href: url, target: '_blank', rel: 'noopener', title: a.name },
        h('img', { src: url, alt: a.name, loading: 'lazy' }))
    }
    return h('a.blase-datei', { href: url, title: a.pfad, download: a.name }, symbol('datei', 14), h('span', {}, a.name))
  }

  function hinweisEl(text, art = 'info') {
    return h(`div.hinweis.${art}`, {}, symbol(art === 'modell' ? 'denken' : 'info', 14), h('span', {}, text))
  }

  function blockEl(b, ergebnisse, unter, n) {
    switch (b.typ) {
      case 'text': return markdown(b.text)
      case 'denken': {
        const d = h('details.denken', { dataset: { schluessel: `denken-${n.id}-${b.text.length}` } },
          h('summary', {}, symbol('denken', 14), 'Gedanken'))
        if (offen.has(d.dataset.schluessel)) d.open = true
        let gebaut = false
        const bauen = () => { if (d.open && !gebaut) { gebaut = true; d.append(h('div.denken-text', {}, b.text)) } }
        d.addEventListener('toggle', bauen)
        bauen()
        return d
      }
      case 'werkzeug': {
        const erg = ergebnisse.get(b.id) ?? null
        const w = werkzeugZeichnen(b, erg, {
          laeuft: laeuft && !erg,
          unter: unter.get(b.id) ?? [],
          zeichneUnter: (liste) => unterZeichnen(liste, ergebnisse, unter),
          aufgabenNamen: todoStand.namen,
        })
        if (w.tagName === 'DETAILS') {
          w.dataset.schluessel = b.id
          if (offen.has(b.id)) { w.open = true; w.dispatchEvent(new Event('toggle')) }
        }
        // HTML-Entwurf: direkt von hier in die Live-Vorschau.
        if (erg && SCHREIB_WERKZEUGE.has(b.name) && vorschau.istHtml(b.eingabe?.file_path)) {
          return h('div.werkzeug-mit-vorschau', {}, w,
            h('button.knopf-klein.vorschau-link', { type: 'button', onclick: () => vorschau.oeffnen(b.eingabe.file_path) },
              symbol('auge', 14), 'Vorschau ansehen'))
        }
        return w
      }
      case 'hinweis': return hinweisEl(b.text)
      case 'bild': return h('div.leise', {}, '(Bild)')
      default: return document.createTextNode('')
    }
  }

  /** Verlauf eines Subagenten in seiner Karte: dieselben Bausteine, kompakter. */
  function unterZeichnen(liste, ergebnisse, unter) {
    const eintraege = []
    for (const n of liste) {
      for (const b of n.bloecke) {
        if (b.typ === 'ergebnis') continue
        // Der Auftrag an den Subagenten steht schon oben in der Karte.
        if (n.rolle === 'user' && b.typ === 'text') continue
        eintraege.push({ b, el: blockEl(b, ergebnisse, unter, n) })
      }
    }
    return h('div.unter-verlauf', {}, schritteBuendeln(eintraege, ergebnisse))
  }

  /**
   * Aufeinanderfolgende Arbeitsschritte (Werkzeugzeilen, Gedanken) an eine
   * Schiene haengen; ab drei Schritten zu EINER Zeile zuklappen, die den
   * letzten Schritt, Fehler und den Zustand zeigt. Can will zuerst die
   * Antwort lesen, die Arbeit dahinter nur bei Bedarf. Spezialisten-Karten,
   * To-do-Listen und Text unterbrechen eine Reihe.
   */
  function schritteBuendeln(eintraege, ergebnisse) {
    const raus = []
    let reihe = []
    const schliessen = () => { if (reihe.length) raus.push(schritteBauen(reihe, ergebnisse)); reihe = [] }
    for (const x of eintraege) {
      const schritt = x.b.typ === 'denken'
        || (x.b.typ === 'werkzeug' && (x.el.classList.contains('werkzeug') || x.el.classList.contains('werkzeug-mit-vorschau')))
      if (schritt) reihe.push(x)
      else { schliessen(); raus.push(x.el) }
    }
    schliessen()
    return raus
  }

  function schritteBauen(reihe, ergebnisse) {
    const schiene = h('div.schritte', {}, reihe.map((x) => x.el))
    if (reihe.length < 3) return schiene
    const werkzeuge = reihe.filter((x) => x.b.typ === 'werkzeug')
    const fehler = werkzeuge.filter((x) => ergebnisse.get(x.b.id)?.fehler).length
    const laufend = laeuft && werkzeuge.some((x) => !ergebnisse.has(x.b.id))
    const letzter = werkzeuge.at(-1)
    const [sym, titel, ziel] = letzter ? kopfDaten(letzter.b.name, letzter.b.eingabe ?? {}, todoStand.namen) : ['denken', 'Gedanken', '']
    // Fehler meldet allein das Etikett: ein frueher, laengst behobener Fehlschlag
    // soll die ganze Reihe nicht rot faerben.
    const zustand = laufend ? 'laeuft' : 'ok'
    const schluessel = `schritte-${reihe[0].b.id ?? reihe[0].el.dataset.schluessel ?? ''}`
    const d = h(`details.schritte-gruppe.${zustand}`, { dataset: { schluessel } },
      h('summary', { title: `${reihe.length} Arbeitsschritte -- antippen zum Aufklappen` },
        h('span.sg-pfeil', {}, symbol('pfeil', 14)),
        h('span.sg-zahl', {}, `${reihe.length} Schritte`),
        h('span.sg-letzter', {}, symbol(sym, 13),
          h('span', {}, laufend && ziel ? `${titel} · ${String(ziel).split('\n')[0]}` : titel)),
        fehler ? h('span.sg-fehler', {}, `${fehler} Fehler`) : null,
        h('span.w-zustand', { title: zustand === 'laeuft' ? 'läuft' : 'fertig' })),
      schiene)
    if (offen.has(schluessel)) d.open = true
    return d
  }

  const STATUS_TEXT = {
    starting: 'Claude startet …', queued: 'Wartet auf einen freien Platz …', thinking: 'Claude denkt nach …',
    tool: 'Claude arbeitet mit Werkzeugen …', writing: 'Claude schreibt …',
    waiting_permission: 'Wartet auf deine Freigabe', waiting_ratelimit: 'Wartet auf ein freies Konto …',
  }

  function liveZeichnen() {
    // Wartet Claude auf Can, steht der drehende Rand der Kachel still (stil.css).
    el.classList.toggle('wartet', laeuft && (status === 'waiting_permission' || freigaben.size > 0))
    if (!laeuft) { leeren(liveEl); return }
    const teile = []
    if (live.denken && !live.text) {
      teile.push(h('div.live-denken', {}, symbol('denken', 14), h('span', {}, live.denken.slice(-280))))
    }
    if (live.text) teile.push(markdown(live.text))
    // Aktuelle To-do-Liste des Chats sichtbar halten, solange er arbeitet --
    // das ist die Antwort auf "was hat er noch vor".
    const todo = letzteTodos()
    teile.push(h('div.arbeitet', {},
      h('span.puls-punkt'),
      h('span', {}, status === 'waiting_permission' && [...freigaben.values()].every((f) => f.toolName === 'AskUserQuestion') && freigaben.size
        ? 'Wartet auf deine Antwort' : STATUS_TEXT[status] ?? 'Claude arbeitet …'),
      todo ? h('span.leise', {}, ` · ${todo.fertig}/${todo.gesamt} erledigt`) : null,
      h('button.knopf-klein.stopp-text', { type: 'button', onclick: anhalten, title: 'Anhalten (Esc)' }, symbol('stopp', 12), 'Anhalten')))
    // Die Liste selbst nur, solange noch etwas offen ist: TaskCreate/TaskUpdate
    // zeigen im Verlauf nur einzelne Zeilen, das Ganze sieht man sonst nirgends.
    if (todo && todo.fertig < todo.gesamt) teile.push(h('div.live-todos', {}, todoListe(todoStand.todos)))
    leeren(liveEl, teile)
    nachUnten()
  }

  function letzteTodos() {
    const t = todoStand.todos
    return t ? { fertig: t.filter((x) => x.status === 'completed').length, gesamt: t.length } : null
  }

  // --- Freigaben ------------------------------------------------------------
  function freigabeAufnehmen(f) {
    if (f.decidedAt || f.decided_at || f.decision) {
      if (freigaben.delete(String(f.id))) freigabenZeichnen()
      return
    }
    const norm = freigabeNormalisieren(f)
    freigaben.set(norm.id, norm)
    freigabenZeichnen()
    nachUnten(true)
  }

  function freigabenZeichnen() {
    leeren(freigabenEl, [...freigaben.values()].map(freigabeKarte))
  }

  async function entscheiden(f, koerper, karte) {
    for (const b of karte.querySelectorAll('button')) b.disabled = true
    try {
      await api('/api/freigabe', { body: { id: f.id, ...koerper } })
      // Sonst stuende die Auswahl weiter auf "Nur planen", und die naechste
      // Nachricht finge wieder mit einem Plan an.
      if (f.toolName === 'ExitPlanMode' && koerper.erlaubt && koerper.modus) eingabe.modusSetzen(koerper.modus)
      freigaben.delete(f.id)
      freigabenZeichnen()
    } catch (e) {
      for (const b of karte.querySelectorAll('button')) b.disabled = false
      melden(`Freigabe fehlgeschlagen: ${fehlerText(e)}`, 'fehler')
    }
  }

  function freigabeKarte(f) {
    return freigabeKarteBauen(f, { entscheiden, neuZeichnen: freigabenZeichnen })
  }

  // Esc haelt an -- wie in Claude Code. Nur, wenn kein Dialog offen ist.
  addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && laeuft && el.isConnected && el.offsetParent && !document.querySelector('dialog[open]')) anhalten()
  })

  return { el, zeigen, aktuelleId: () => id }
}
