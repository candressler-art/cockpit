// Aufgaben-Bereich: was gerade (und kuerzlich) gearbeitet wird -- je Chat oder
// Team-Auftrag die Agenten, ihre To-do-Listen, Spezialisten und die letzte
// Taetigkeit.
//
// Warum kein eigener To-do-Agent: jeder Agent fuehrt seine Liste selbst mit
// TodoWrite bzw. TaskCreate/TaskUpdate (der Chat-Systemprompt verlangt das, siehe chatOptionen.ts). Das
// ist genauer als eine Liste, die ein zweiter Agent von aussen nachfuehrt,
// und kostet keinen einzigen Token extra -- die Liste steht ohnehin in den
// Ereignissen. Hier wird sie nur eingesammelt.
//
// Reine Buchfuehrung ohne DB und ohne Supervisor, damit sie sich mit
// erfundenen Ereignissen testen laesst. Der Daemon fuettert sie live und beim
// Start einmal mit den Ereignissen der letzten 24 Stunden.

import type { CockpitEvent } from './typen.js'

export interface Todo {
  inhalt: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Verlaufsform ("Schreibe Tests") -- zeigt die Oberflaeche beim laufenden Punkt. */
  aktiv: string | null
}

export interface Taetigkeit {
  text: string
  ts: number
}

export interface Spezialist {
  toolUseId: string
  typ: string
  beschreibung: string
  status: 'laeuft' | 'fertig' | 'fehler'
  start: number
  ende: number | null
  todos: Todo[] | null
  letzteTaetigkeit: Taetigkeit | null
}

/** Das, was die Oberflaeche ueber einen Agenten braucht -- aus AgentState oder einer DB-Zeile. */
export interface AgentKurz {
  runId: string
  agentId: string
  role: string
  fachrolle: string | null
  label: string
  status: string
  model: string | null
  startedAt: number
  endedAt: number | null
  /** Titel des Laufs (runs.label) -- fuer Team-Auftraege der Auftrag selbst. */
  laufLabel?: string | null
}

export interface AgentAufgaben extends AgentKurz {
  todos: Todo[] | null
  letzteTaetigkeit: Taetigkeit | null
  spezialisten: Spezialist[]
}

export interface LaufAufgaben {
  runId: string
  /** Bei Chats die Session-Id des Chats, sonst null (Team-Auftrag, Einzellauf). */
  chatId: string | null
  titel: string
  laeuft: boolean
  letzteAktivitaet: number
  agenten: AgentAufgaben[]
  /** Nur bei Team-Auftraegen: Stand des Orchestrators. */
  team: TeamStand | null
}

export interface TeamStand {
  runde: number
  /** Letzte Zusammenfassung des Orchestrators ("Index gebaut, Tests fehlen"). */
  stand: string | null
  /** Offene Entscheidungsfrage an Can -- der Lauf wartet, bis sie beantwortet ist. */
  frage: string | null
}

/** Protokollschritt des Orchestrators (Orchestrator.melden). */
export interface OrchestratorMeldung {
  runId: string
  art?: string
  daten?: unknown
  ts?: number
}

/** Werkzeugnamen, unter denen die CLI Subagenten startet (neu 'Agent', frueher 'Task'). */
const SPEZIALISTEN_WERKZEUGE = new Set(['Agent', 'Task'])

/** Status, in denen ein Agent noch arbeitet oder wartet. */
const AKTIV = new Set(['starting', 'running', 'waiting_permission'])

/** Ereignisarten, die als "letzte Taetigkeit" taugen -- nicht Nutzungsstand, Hooks o. ae. */
const TAETIGKEIT = new Set(['tool_use', 'text', 'thinking'])

export const AUFGABEN_FENSTER_MS = 24 * 60 * 60 * 1000

interface Eintrag {
  todos: Todo[] | null
  letzteTaetigkeit: Taetigkeit | null
  spezialisten: Map<string, Spezialist>
  zuletzt: number
  /** Task-Listen (TaskCreate/TaskUpdate): '' fuer den Agenten selbst, sonst je Spezialist. */
  tasks: Map<string, TaskBuch>
}

/**
 * Aufgabenliste der neueren CLI: statt TodoWrite mit der ganzen Liste legt
 * Claude Punkte einzeln an (TaskCreate) und aendert sie per Nummer
 * (TaskUpdate). Die Nummer steht erst im Ergebnis ("Task #3 created ...") --
 * deshalb zaehlt ein Punkt erst, wenn das Ergebnis da ist; ein abgelehnter
 * Aufruf legt so auch nichts an. Fehlt die Nummer, zaehlt die Reihenfolge,
 * wie die CLI selbst nummeriert.
 */
export class TaskBuch {
  private punkte = new Map<string, Todo>()
  private angefragt = new Map<string, { inhalt: string; aktiv: string | null }>()
  private zaehler = 0

  anlegen(toolUseId: string, input: unknown): void {
    const r = (input ?? {}) as Record<string, unknown>
    const inhalt = typeof r.subject === 'string' ? r.subject.trim() : ''
    if (inhalt) this.angefragt.set(toolUseId, { inhalt, aktiv: typeof r.activeForm === 'string' ? r.activeForm : null })
  }

  /** Ergebnis eines TaskCreate. true, wenn ein Punkt dazukam. */
  ergebnis(toolUseId: string, text: string, fehler: boolean): boolean {
    const a = this.angefragt.get(toolUseId)
    if (!a) return false
    this.angefragt.delete(toolUseId)
    if (fehler) return false
    const nr = /Task #(\w+)/.exec(text)?.[1]
    const id = nr ?? String(this.zaehler + 1)
    if (/^\d+$/.test(id)) this.zaehler = Math.max(this.zaehler, Number(id))
    this.punkte.set(id, { inhalt: a.inhalt, status: 'pending', aktiv: a.aktiv })
    return true
  }

  aendern(input: unknown): boolean {
    const r = (input ?? {}) as Record<string, unknown>
    const id = String(r.taskId ?? '')
    const p = this.punkte.get(id)
    if (!p) return false
    if (r.status === 'deleted') return this.punkte.delete(id)
    if (r.status === 'pending' || r.status === 'in_progress' || r.status === 'completed') p.status = r.status
    if (typeof r.subject === 'string' && r.subject.trim()) p.inhalt = r.subject.trim()
    if (typeof r.activeForm === 'string') p.aktiv = r.activeForm
    return true
  }

  todos(): Todo[] | null {
    return this.punkte.size ? [...this.punkte.values()].map((t) => ({ ...t })) : null
  }
}

/** Text eines tool_result-Blocks (String oder Liste von Textbloecken). */
function ergebnisText(b: Record<string, unknown>): string {
  const c = b.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n')
}

function todosLesen(input: unknown): Todo[] | null {
  const liste = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(liste)) return null
  const aus: Todo[] = []
  for (const t of liste) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    const inhalt = typeof r.content === 'string' ? r.content : ''
    if (!inhalt) continue
    const status = r.status === 'in_progress' || r.status === 'completed' ? r.status : 'pending'
    aus.push({ inhalt, status, aktiv: typeof r.activeForm === 'string' ? r.activeForm : null })
  }
  return aus
}

function bloecke(payload: unknown): Record<string, unknown>[] {
  const inhalt = ((payload as Record<string, unknown> | null)?.message as Record<string, unknown> | undefined)?.content
  return Array.isArray(inhalt) ? (inhalt.filter((b) => b && typeof b === 'object') as Record<string, unknown>[]) : []
}

export class AufgabenSammler {
  private eintraege = new Map<string, Eintrag>()
  private teams = new Map<string, TeamStand & { zuletzt: number }>()

  /**
   * Einen Protokollschritt des Orchestrators verbuchen. true, wenn sich Runde,
   * Stand oder Frage geaendert haben.
   */
  orchestrator(m: OrchestratorMeldung): boolean {
    const d = (m.daten ?? {}) as Record<string, unknown>
    let t = this.teams.get(m.runId)
    if (!t) {
      t = { runde: 0, stand: null, frage: null, zuletzt: 0 }
      this.teams.set(m.runId, t)
    }
    t.zuletzt = Math.max(t.zuletzt, m.ts ?? Date.now())
    switch (m.art) {
      case 'runde_start':
        t.runde = Number(d.runde) || t.runde
        return true
      case 'fall':
        t.stand = typeof d.statusKurz === 'string' && d.statusKurz ? d.statusKurz : t.stand
        return true
      case 'frage':
        t.frage = String(d.frage ?? '') || 'Der Orchestrator braucht eine Entscheidung.'
        return true
      case 'antwort':
        t.frage = null
        return true
      default:
        return false
    }
  }

  private eintrag(runId: string, agentId: string): Eintrag {
    const k = `${runId}::${agentId}`
    let e = this.eintraege.get(k)
    if (!e) {
      e = { todos: null, letzteTaetigkeit: null, spezialisten: new Map(), zuletzt: 0, tasks: new Map() }
      this.eintraege.set(k, e)
    }
    return e
  }

  /**
   * Ein Ereignis verbuchen. Gibt true zurueck, wenn sich eine Liste oder ein
   * Spezialist geaendert hat -- nur dann lohnt es, die Oberflaeche zu wecken.
   * Die letzte Taetigkeit allein zaehlt nicht (sonst jede Sekunde ein Weckruf).
   */
  ereignis(ev: CockpitEvent): boolean {
    const e = this.eintrag(ev.runId, ev.agentId)
    e.zuletzt = Math.max(e.zuletzt, ev.ts)
    // Ereignisse eines Subagenten tragen die tool_use-Id seines Aufrufs.
    const sub = ev.parentToolUseId ? e.spezialisten.get(ev.parentToolUseId) ?? null : null
    let geaendert = false
    // Task-Liste des Agenten bzw. des Spezialisten, von dem das Ereignis stammt.
    const taskSchluessel = ev.parentToolUseId ?? ''
    const taskBuch = (): TaskBuch => {
      let t = e.tasks.get(taskSchluessel)
      if (!t) e.tasks.set(taskSchluessel, (t = new TaskBuch()))
      return t
    }
    const taskListeSetzen = (): boolean => {
      const todos = taskBuch().todos()
      if (sub) sub.todos = todos
      else if (!ev.parentToolUseId) e.todos = todos
      else return false
      return true
    }

    if (TAETIGKEIT.has(ev.kind)) {
      const t = { text: ev.summary, ts: ev.ts }
      if (sub) sub.letzteTaetigkeit = t
      else if (!ev.parentToolUseId) e.letzteTaetigkeit = t
    }

    if (ev.kind === 'tool_use') {
      for (const b of bloecke(ev.payload)) {
        if (b.type !== 'tool_use') continue
        if (b.name === 'TaskCreate' && typeof b.id === 'string') {
          taskBuch().anlegen(b.id, b.input)
        } else if (b.name === 'TaskUpdate') {
          if (taskBuch().aendern(b.input)) geaendert = taskListeSetzen() || geaendert
        } else if (b.name === 'TodoWrite') {
          const todos = todosLesen(b.input)
          if (todos) {
            if (sub) sub.todos = todos
            else if (!ev.parentToolUseId) e.todos = todos
            geaendert = true
          }
        } else if (SPEZIALISTEN_WERKZEUGE.has(String(b.name)) && typeof b.id === 'string' && !ev.parentToolUseId) {
          const input = (b.input ?? {}) as Record<string, unknown>
          e.spezialisten.set(b.id, {
            toolUseId: b.id,
            typ: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
            beschreibung: typeof input.description === 'string' ? input.description : '',
            status: 'laeuft',
            start: ev.ts,
            ende: null,
            todos: null,
            letzteTaetigkeit: null,
          })
          geaendert = true
        }
      }
    }

    if (ev.kind === 'tool_result') {
      for (const b of bloecke(ev.payload)) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        if (taskBuch().ergebnis(b.tool_use_id, ergebnisText(b), b.is_error === true)) {
          geaendert = taskListeSetzen() || geaendert
          continue
        }
        if (ev.parentToolUseId) continue
        const s = e.spezialisten.get(b.tool_use_id)
        if (s && s.status === 'laeuft') {
          s.status = b.is_error === true ? 'fehler' : 'fertig'
          s.ende = ev.ts
          geaendert = true
        }
      }
    }
    return geaendert
  }

  /**
   * Alles fuer den Aufgaben-Bereich. `agenten` liefert der Daemon (laufende
   * aus dem Supervisor, kuerzliche aus der DB); ein Agent ohne jede
   * Aufzeichnung erscheint trotzdem -- "arbeitet, noch keine Liste" ist auch
   * eine Auskunft.
   */
  liste(agenten: AgentKurz[], jetzt = Date.now(), teamAktiv: ReadonlySet<string> = new Set()): LaufAufgaben[] {
    this.aufraeumen(jetzt)
    const laeufe = new Map<string, LaufAufgaben>()
    for (const a of agenten) {
      const e = this.eintraege.get(`${a.runId}::${a.agentId}`)
      const aktiv = AKTIV.has(a.status)
      // Endet ein Agent, laufen seine Spezialisten nicht weiter -- auch wenn
      // ihr Ergebnis nie ankam (Abbruch, Absturz).
      const spezialisten = [...(e?.spezialisten.values() ?? [])].map((s) =>
        !aktiv && s.status === 'laeuft' ? { ...s, status: 'fehler' as const, ende: a.endedAt } : s,
      )
      const eintrag: AgentAufgaben = {
        ...a,
        todos: e?.todos ?? null,
        letzteTaetigkeit: e?.letzteTaetigkeit ?? null,
        spezialisten,
      }
      let lauf = laeufe.get(a.runId)
      if (!lauf) {
        lauf = {
          runId: a.runId,
          chatId: a.runId.startsWith('chat-') ? a.runId.slice('chat-'.length) : null,
          titel: a.label.replace(/^Chat: /, ''),
          laeuft: false,
          letzteAktivitaet: 0,
          agenten: [],
          team: null,
        }
        laeufe.set(a.runId, lauf)
      }
      // Ein Team-Auftrag heisst wie der Auftrag (runs.label), nicht wie der
      // zuletzt gestartete Worker; ohne ihn benennt ihn der Orchestrator.
      // Chats behalten ihren Titel aus dem Agenten ("Chat: ...").
      if (!lauf.chatId && a.laufLabel) lauf.titel = a.laufLabel
      else if (a.role === 'orchestrator' && !lauf.chatId) lauf.titel = a.label
      lauf.laeuft ||= aktiv
      lauf.letzteAktivitaet = Math.max(lauf.letzteAktivitaet, e?.zuletzt ?? 0, a.endedAt ?? a.startedAt)
      lauf.agenten.push(eintrag)
    }
    for (const lauf of laeufe.values()) {
      const t = this.teams.get(lauf.runId)
      // Ein Orchestrator, der auf eine Antwort wartet, hat keinen laufenden
      // Agenten -- der Lauf ist trotzdem nicht fertig.
      const lebt = teamAktiv.has(lauf.runId)
      lauf.laeuft ||= lebt
      if (t) {
        // Ohne lebenden Orchestrator (Ende, Neustart) kann niemand mehr antworten.
        lauf.team = { runde: t.runde, stand: t.stand, frage: lebt ? t.frage : null }
        lauf.letzteAktivitaet = Math.max(lauf.letzteAktivitaet, t.zuletzt)
      } else if (lebt || lauf.agenten.some((a) => a.role === 'orchestrator' || a.role === 'worker')) {
        // Nach einem Neustart fehlt der Stand -- ein Team-Auftrag bleibt es trotzdem.
        lauf.team = { runde: 0, stand: null, frage: null }
      }
    }
    return [...laeufe.values()].sort(
      (x, y) => Number(y.laeuft) - Number(x.laeuft) || y.letzteAktivitaet - x.letzteAktivitaet,
    )
  }

  /** Eintraege, die laenger als das Fenster ruhen, vergessen -- der Speicher waechst sonst ewig. */
  private aufraeumen(jetzt: number): void {
    for (const [k, e] of this.eintraege) {
      if (jetzt - e.zuletzt > AUFGABEN_FENSTER_MS) this.eintraege.delete(k)
    }
    for (const [k, t] of this.teams) {
      if (jetzt - t.zuletzt > AUFGABEN_FENSTER_MS) this.teams.delete(k)
    }
  }
}

/** DB-Zeile aus `agents` in die Kurzform. */
export function agentAusZeile(r: Record<string, unknown>): AgentKurz {
  return {
    runId: String(r.run_id),
    agentId: String(r.agent_id),
    role: String(r.role),
    fachrolle: (r.fachrolle as string | null) ?? null,
    label: String(r.label ?? ''),
    status: String(r.status),
    model: (r.model as string | null) ?? null,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    laufLabel: typeof r.lauf_label === 'string' ? r.lauf_label : null,
  }
}
