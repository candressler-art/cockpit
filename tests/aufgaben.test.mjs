// Aufgaben-Bereich (src/aufgaben.ts): To-do-Listen aus TodoWrite,
// Spezialisten aus Agent/Task-Aufrufen, letzte Taetigkeit. Gegen dist/.
import { AufgabenSammler, agentAusZeile, AUFGABEN_FENSTER_MS } from '../dist/aufgaben.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

let seq = 0
const ev = (runId, agentId, kind, summary, bloecke, parent = null, ts = 1000 + seq) => ({
  seq: ++seq, ts, runId, agentId, sessionId: null, kind, parentToolUseId: parent, summary,
  payload: { type: kind === 'tool_result' ? 'user' : 'assistant', message: { content: bloecke } },
})
const agent = (runId, agentId, status, extra = {}) => ({
  runId, agentId, role: 'chat', fachrolle: null, label: 'Chat: Hallo', status, model: 'm',
  startedAt: 1000, endedAt: status === 'running' ? null : 5000, ...extra,
})

const J = 5000 // 'jetzt' fuer liste(): die erfundenen Zeitstempel liegen bei ~1000
const s = new AufgabenSammler()
const todos = [
  { content: 'Lesen', status: 'completed', activeForm: 'Lese' },
  { content: 'Bauen', status: 'in_progress', activeForm: 'Baue' },
  { content: 'Testen', status: 'weiss nicht' },
  { content: '', status: 'pending' },
]
pruefe('TodoWrite meldet Aenderung',
  s.ereignis(ev('chat-abc', 'chat', 'tool_use', 'ruft TodoWrite', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }])))
pruefe('Text allein weckt nicht', !s.ereignis(ev('chat-abc', 'chat', 'text', 'Ich fange an', [{ type: 'text', text: 'x' }])))
pruefe('Spezialist gestartet',
  s.ereignis(ev('chat-abc', 'chat', 'tool_use', 'ruft Agent', [{ type: 'tool_use', id: 'sub1', name: 'Agent', input: { subagent_type: 'pruefer', description: 'Tests pruefen', prompt: 'p' } }])))
s.ereignis(ev('chat-abc', 'chat', 'tool_use', 'ruft TodoWrite', [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'Sub-Schritt', status: 'pending' }] } }], 'sub1'))
s.ereignis(ev('chat-abc', 'chat', 'tool_use', 'ruft Bash', [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }], 'sub1'))

let l = s.liste([agent('chat-abc', 'chat', 'running')], J)
let a = l[0]?.agenten[0]
pruefe('ein Lauf, chatId aus runId', l.length === 1 && l[0].chatId === 'abc' && l[0].laeuft === true)
pruefe('Titel ohne "Chat: "', l[0].titel === 'Hallo')
pruefe('Todos: leere verworfen, Status normalisiert', a.todos.length === 3 && a.todos[2].status === 'pending' && a.todos[1].aktiv === 'Baue')
pruefe('Subagenten-Liste nicht beim Hauptagenten', a.todos[0].inhalt === 'Lesen')
pruefe('letzte Taetigkeit des Hauptagenten', a.letzteTaetigkeit?.text === 'ruft Agent')
const sp = a.spezialisten[0]
pruefe('Spezialist mit Typ und Beschreibung', sp?.typ === 'pruefer' && sp.beschreibung === 'Tests pruefen' && sp.status === 'laeuft')
pruefe('Spezialist hat eigene Todos und Taetigkeit', sp.todos?.[0]?.inhalt === 'Sub-Schritt' && sp.letzteTaetigkeit?.text === 'ruft Bash')

pruefe('Ergebnis beendet Spezialisten',
  s.ereignis(ev('chat-abc', 'chat', 'tool_result', '1x', [{ type: 'tool_result', tool_use_id: 'sub1', content: 'fertig' }])))
l = s.liste([agent('chat-abc', 'chat', 'running')], J)
pruefe('Spezialist fertig', l[0].agenten[0].spezialisten[0].status === 'fertig')

// Abgebrochener Agent: laufender Spezialist gilt als gescheitert
s.ereignis(ev('run-x', 'worker-1', 'tool_use', 'ruft Task', [{ type: 'tool_use', id: 'sub2', name: 'Task', input: {} }]))
l = s.liste([
  agent('run-x', 'orchestrator', 'done', { role: 'orchestrator', label: 'Team: Umbau' }),
  agent('run-x', 'worker-1', 'stopped', { role: 'worker', label: 'Worker 1' }),
  agent('chat-abc', 'chat', 'done'),
], J)
const team = l.find((x) => x.runId === 'run-x')
pruefe('Team-Lauf: Titel vom Orchestrator, kein chatId', team.titel === 'Team: Umbau' && team.chatId === null)
pruefe('Team-Lauf: zwei Agenten', team.agenten.length === 2)
const sp2 = team.agenten.find((x) => x.agentId === 'worker-1').spezialisten[0]
pruefe('Task ohne Typ -> general-purpose, beim Abbruch fehler', sp2.typ === 'general-purpose' && sp2.status === 'fehler')
pruefe('Agent ohne Aufzeichnung erscheint mit leeren Feldern',
  team.agenten.find((x) => x.agentId === 'orchestrator').todos === null)

// Sortierung: laufende zuerst
l = s.liste([agent('chat-abc', 'chat', 'done'), agent('run-y', 'chat', 'waiting_permission', { startedAt: 1 })], J)
pruefe('laufende (auch wartende) zuerst', l[0].runId === 'run-y' && l[0].laeuft)

// Aufraeumen nach dem Fenster
l = s.liste([agent('chat-abc', 'chat', 'done')], 1000 + seq + AUFGABEN_FENSTER_MS + 1)
pruefe('alte Eintraege vergessen', l[0].agenten[0].todos === null)

// Kaputte Payloads werfen nicht
let wirft = false
try {
  s.ereignis({ seq: 1, ts: 1, runId: 'r', agentId: 'a', sessionId: null, kind: 'tool_use', parentToolUseId: null, summary: '', payload: null })
  s.ereignis({ seq: 2, ts: 1, runId: 'r', agentId: 'a', sessionId: null, kind: 'tool_use', parentToolUseId: null, summary: '', payload: { message: { content: [null, { type: 'tool_use', name: 'TodoWrite', input: { todos: 'x' } }] } } })
} catch { wirft = true }
pruefe('kaputte Payloads werfen nicht', !wirft)

const z = agentAusZeile({ run_id: 'r', agent_id: 'a', role: 'chat', fachrolle: null, label: 'L', status: 'done', model: null, started_at: 5, ended_at: null })
pruefe('DB-Zeile -> Kurzform', z.runId === 'r' && z.startedAt === 5 && z.endedAt === null)

// --- Team-Auftraege: Stand und offene Frage des Orchestrators ---
{
  const t = new AufgabenSammler()
  const orch = (art, daten, ts = 2000) => t.orchestrator({ runId: 'team1', art, daten, ts })
  const agenten = [
    agent('team1', 'orchestrator', 'done', { role: 'orchestrator', label: 'Baue die Suche' }),
    agent('team1', 'w1', 'done', { role: 'worker', fachrolle: 'coder', label: 'coder: Suche' }),
  ]
  pruefe('Runde weckt', orch('runde_start', { runde: 2, auftraege: 1 }))
  pruefe('Blocker allein weckt nicht', !orch('blocker', []))
  orch('fall', { runde: 2, fall: 'entscheidung', statusKurz: 'Index gebaut, Frage offen' })
  pruefe('Frage weckt', orch('frage', { runde: 2, frage: 'SQLite oder Postgres?' }))
  let tl = t.liste(agenten, J, new Set(['team1']))
  pruefe('Team: Titel vom Orchestrator, Runde und Stand', tl[0].titel === 'Baue die Suche' && tl[0].team?.runde === 2 &&
    tl[0].team?.stand === 'Index gebaut, Frage offen')
  pruefe('Team: wartet auf Antwort zaehlt als laufend', tl[0].laeuft === true && tl[0].team?.frage === 'SQLite oder Postgres?')
  tl = t.liste(agenten, J, new Set())
  pruefe('Team: ohne lebenden Orchestrator keine offene Frage', tl[0].laeuft === false && tl[0].team?.frage === null)
  orch('antwort', { runde: 2, text: 'SQLite' })
  tl = t.liste(agenten, J, new Set(['team1']))
  pruefe('Team: Antwort schliesst die Frage', tl[0].team?.frage === null)
  const r1 = t.liste([agent('team2', 'w1', 'running', { role: 'worker', fachrolle: 'coder', label: 'Entwickler R1', laufLabel: 'Suche bauen' })], J)
  pruefe('Team: Titel aus dem Lauf, nicht vom Worker (Runde 1 ohne Orchestrator)', r1[0].titel === 'Suche bauen')
  pruefe('Team: ohne Stand (Neustart) an Workern erkannt', r1[0].team !== null && r1[0].team.runde === 0)
  pruefe('Chat hat keinen Team-Stand', s.liste([agent('chat-x', 'chat', 'running')], J)[0].team === null)
}

console.log(`\n${ok}/${gesamt} Pruefungen bestanden`)
if (ok !== gesamt) process.exit(1)
