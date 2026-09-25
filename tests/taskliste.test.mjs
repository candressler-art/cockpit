// To-do-Liste der Chat-Ansicht aus TodoWrite bzw. TaskCreate/TaskUpdate (web/ui/taskliste.js).
import { aktuelleTodos } from '../web/ui/taskliste.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}
const w = (id, name, eingabe, eltern = null) => ({ rolle: 'assistant', eltern, bloecke: [{ typ: 'werkzeug', id, name, eingabe }] })
const e = (zu, text, fehler = false) => ({ rolle: 'user', eltern: null, bloecke: [{ typ: 'ergebnis', zu, text, fehler }] })

pruefe('ohne Liste: null', aktuelleTodos([{ rolle: 'user', bloecke: [{ typ: 'text', text: 'x' }] }]).todos === null)

const alt = aktuelleTodos([w('t', 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] })])
pruefe('TodoWrite: Liste wie eingegeben', alt.todos.length === 2 && alt.todos[0].status === 'completed')

const verlauf = [
  w('c1', 'TaskCreate', { subject: 'Lesen', activeForm: 'Lese' }), e('c1', 'Task #1 created successfully: Lesen'),
  w('c2', 'TaskCreate', { subject: 'Schreiben' }), e('c2', 'Task #2 created successfully: Schreiben'),
  w('c3', 'TaskCreate', { subject: 'Abgelehnt' }), e('c3', 'Permission denied', true),
  w('c4', 'TaskCreate', { subject: 'Laeuft noch' }),
  w('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
  w('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress', activeForm: 'Schreibe' }),
  w('s1', 'TaskCreate', { subject: 'vom Spezialisten' }, 'agent-1'), e('s1', 'Task #1 created'),
]
const t = aktuelleTodos(verlauf)
pruefe('Task: nur Punkte mit fehlerfreiem Ergebnis', t.todos.length === 2)
pruefe('Task: Status und Verlaufsform', t.todos[0].status === 'completed' && t.todos[1].status === 'in_progress' && t.todos[1].activeForm === 'Schreibe')
pruefe('Task: Spezialisten zaehlen nicht mit', t.todos.every((x) => x.content !== 'vom Spezialisten'))
pruefe('Task: Namen je Nummer', t.namen.get('2') === 'Schreiben')

const weg = aktuelleTodos([...verlauf, w('u3', 'TaskUpdate', { taskId: '1', status: 'deleted' }), w('u4', 'TaskUpdate', { taskId: '2', status: 'deleted' })])
pruefe('Task: alle geloescht -> keine Liste, Name bleibt', weg.todos === null && weg.namen.get('1') === 'Lesen')

const ohneNr = aktuelleTodos([w('c1', 'TaskCreate', { subject: 'X' }), e('c1', 'ok'), w('c2', 'TaskCreate', { subject: 'Y' }), e('c2', 'ok'), w('u', 'TaskUpdate', { taskId: '2', status: 'completed' })])
pruefe('Task: Nummer aus Reihenfolge', ohneNr.todos[1].status === 'completed')

const danach = aktuelleTodos([...verlauf, w('t2', 'TodoWrite', { todos: [{ content: 'Neu', status: 'pending' }] })])
pruefe('spaeteres TodoWrite gewinnt', danach.todos.length === 1 && danach.todos[0].content === 'Neu')

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
