/**
 * To-do-Liste eines Chats aus seinen Nachrichten -- fuer beide Formen, die
 * Claude Code kennt: TodoWrite (die ganze Liste je Aufruf) und die neuere
 * TaskCreate/TaskUpdate (Punkt fuer Punkt, Nummer erst im Ergebnis
 * "Task #3 created ..."). Dieselben Regeln wie src/aufgaben.ts (TaskBuch):
 * ein Punkt zaehlt erst mit einem fehlerfreien Ergebnis; fehlt die Nummer,
 * zaehlt die Reihenfolge.
 *
 * Ergebnis in TodoWrite-Form ({content, status, activeForm}), damit
 * todoListe() in werkzeuge.js beides gleich zeichnet.
 */

/**
 * @param nachrichten  Nachrichten des Chats (nur der Hauptverlauf zaehlt)
 * @returns {{ todos: object[]|null, namen: Map<string,string> }}
 *   todos: die zuletzt gueltige Liste (null = keine); namen: Nummer -> Titel,
 *   auch fuer geloeschte Punkte (fuer die Zeile "Aufgabe erledigt: ...").
 */
export function aktuelleTodos(nachrichten) {
  const ergebnisse = new Map()
  for (const n of nachrichten) {
    for (const b of n.bloecke ?? []) if (b.typ === 'ergebnis') ergebnisse.set(b.zu, b)
  }
  const punkte = new Map()
  const namen = new Map()
  let zaehler = 0
  let todos = null
  let tasksBenutzt = false
  for (const n of nachrichten) {
    if (n.eltern) continue
    for (const b of n.bloecke ?? []) {
      if (b.typ !== 'werkzeug') continue
      const e = b.eingabe ?? {}
      if (b.name === 'TodoWrite') {
        todos = Array.isArray(e.todos) ? e.todos : []
        tasksBenutzt = false
      } else if (b.name === 'TaskCreate') {
        const erg = ergebnisse.get(b.id)
        const inhalt = typeof e.subject === 'string' ? e.subject.trim() : ''
        if (!erg || erg.fehler || !inhalt) continue
        const id = /Task #(\w+)/.exec(erg.text ?? '')?.[1] ?? String(zaehler + 1)
        if (/^\d+$/.test(id)) zaehler = Math.max(zaehler, Number(id))
        punkte.set(id, { content: inhalt, status: 'pending', activeForm: e.activeForm ?? null })
        namen.set(id, inhalt)
        tasksBenutzt = true
      } else if (b.name === 'TaskUpdate') {
        const id = String(e.taskId ?? '')
        const p = punkte.get(id)
        if (!p) continue
        if (e.status === 'deleted') punkte.delete(id)
        else if (['pending', 'in_progress', 'completed'].includes(e.status)) p.status = e.status
        if (typeof e.subject === 'string' && e.subject.trim()) { p.content = e.subject.trim(); namen.set(id, p.content) }
        if (typeof e.activeForm === 'string') p.activeForm = e.activeForm
        tasksBenutzt = true
      }
    }
  }
  if (tasksBenutzt) todos = punkte.size ? [...punkte.values()].map((t) => ({ ...t })) : null
  return { todos, namen }
}
