// Treibt die Agenten-Sessions und haelt ihren Zustand.
//
// Ein Agent = eine SDK-Session mit eigenem Kontext. Orchestrator und Worker
// sind getrennte Sessions (Cans Zwei-Rollen-Modell), Subagenten innerhalb
// eines Workers erkennt der Supervisor an den task_started-Nachrichten und
// haengt sie als Kinder in den Graphen.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { query, USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import type { CockpitDb } from './db.js'
import { einordnen } from './normalisieren.js'
import {
  limitStandLesen,
  tokensWiegen,
  type AgentRole,
  type AgentState,
  type AgentStatus,
  type CockpitEvent,
  type LimitStand,
  type PermissionRequest,
} from './typen.js'

/** Statuswechsel, den ein Ereignis am Agenten ausloest. */
const STATUS_JE_KIND: Partial<Record<CockpitEvent['kind'], AgentStatus>> = {
  thinking: 'thinking',
  tool_use: 'tool',
  tool_result: 'thinking',
  text: 'writing',
  permission_request: 'waiting_permission',
  rate_limit: 'waiting_ratelimit',
}

export interface AgentStartOptionen {
  runId: string
  agentId: string
  role: AgentRole
  label: string
  prompt: string
  cwd: string
  model?: string
  parentAgentId?: string | null
  maxTurns?: number
  maxBudgetUsd?: number
  /** Session fortsetzen statt neu beginnen. */
  resume?: string
  /** Werkzeuge, die ohne Rueckfrage laufen duerfen. */
  allowedTools?: string[]
}

export class Supervisor extends EventEmitter {
  private db: CockpitDb
  private seq = new Map<string, number>()
  private agenten = new Map<string, AgentState>()
  private laufende = new Map<string, { abort: AbortController }>()
  /** Letzter gemessener Limitstand des Kontos. Gilt kontoweit, nicht je Lauf. */
  private limitStand: LimitStand | null = null
  private offeneFreigaben = new Map<
    string,
    { aufloesen: (erlaubt: boolean, grund: string | null) => void; anfrage: PermissionRequest }
  >()

  constructor(db: CockpitDb) {
    super()
    this.db = db
  }

  private naechsteSeq(runId: string): number {
    const jetzt = (this.seq.get(runId) ?? this.db.letzteSeq(runId)) + 1
    this.seq.set(runId, jetzt)
    return jetzt
  }

  private schluessel(runId: string, agentId: string): string {
    return `${runId}::${agentId}`
  }

  /** Schreibt ein Ereignis, persistiert es und gibt es an die Kanaele weiter. */
  private melden(
    runId: string,
    agentId: string,
    kind: CockpitEvent['kind'],
    summary: string,
    payload: unknown,
    sessionId: string | null = null,
    parentToolUseId: string | null = null,
  ): CockpitEvent {
    const e: CockpitEvent = {
      seq: this.naechsteSeq(runId),
      ts: Date.now(),
      runId,
      agentId,
      sessionId,
      kind,
      parentToolUseId,
      summary,
      payload,
    }
    this.db.ereignisSpeichern(e)
    this.emit('ereignis', e)
    return e
  }

  private agentAendern(runId: string, agentId: string, aenderung: Partial<AgentState>): void {
    const k = this.schluessel(runId, agentId)
    const vorher = this.agenten.get(k)
    if (!vorher) return
    const nachher = { ...vorher, ...aenderung }
    this.agenten.set(k, nachher)
    this.db.agentSpeichern(nachher)
    this.emit('agent', nachher)
  }

  agentenListe(runId: string): AgentState[] {
    return [...this.agenten.values()].filter((a) => a.runId === runId)
  }

  /**
   * Startet einen Agenten und laeuft seinen Nachrichtenstrom ab. Loest auf,
   * wenn der Agent fertig ist; wirft nicht, sondern vermerkt Fehler am
   * Agentenzustand -- ein gestorbener Worker darf den Lauf nicht mitnehmen.
   */
  async agentStarten(o: AgentStartOptionen): Promise<{ ergebnis: string | null; fehler: string | null }> {
    const k = this.schluessel(o.runId, o.agentId)
    const zustand: AgentState = {
      agentId: o.agentId,
      runId: o.runId,
      role: o.role,
      status: 'starting',
      sessionId: null,
      label: o.label,
      parentAgentId: o.parentAgentId ?? null,
      model: o.model ?? null,
      cwd: o.cwd,
      startedAt: Date.now(),
      endedAt: null,
      weightedTokens: 0,
      rawTokens: 0,
      costUsd: 0,
      turns: 0,
      lastError: null,
    }
    this.agenten.set(k, zustand)
    this.db.agentSpeichern(zustand)
    this.emit('agent', zustand)

    const abort = new AbortController()
    this.laufende.set(k, { abort })

    let ergebnis: string | null = null
    let fehler: string | null = null

    try {
      const lauf = query({
        prompt: o.prompt,
        options: {
          cwd: o.cwd,
          abortController: abort,
          model: o.model,
          maxTurns: o.maxTurns,
          maxBudgetUsd: o.maxBudgetUsd,
          resume: o.resume,
          allowedTools: o.allowedTools,
          // Subagenten sollen auch ihren Text zeigen, nicht nur Tool-Aufrufe --
          // sonst bleibt im Graphen ein stummer Knoten stehen.
          forwardSubagentText: true,
          includeHookEvents: true,
          // Token-Deltas brauchen wir nicht: parent_tool_use_id ist dort immer
          // null, sie sind keinem Subagenten zuordenbar.
          includePartialMessages: false,
          canUseTool: (toolName: string, input: Record<string, unknown>) =>
            this.freigabeEinholen(o.runId, o.agentId, toolName, input),
        },
      })

      for await (const nachricht of lauf) {
        this.nachrichtVerarbeiten(o.runId, o.agentId, nachricht as Record<string, unknown>)
        const m = nachricht as Record<string, unknown>
        if (m.type === 'result') {
          ergebnis = typeof m.result === 'string' ? m.result : null
          if (m.is_error === true) fehler = `Lauf endete mit is_error (subtype=${String(m.subtype)})`
        }
      }
      this.agentAendern(o.runId, o.agentId, {
        status: fehler ? 'failed' : 'done',
        endedAt: Date.now(),
        lastError: fehler,
      })
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      // Ein Ratenlimit ist kein Absturz, sondern ein Wartezustand -- die
      // Unterscheidung macht den Unterschied zwischen "Lauf ist tot" und
      // "Lauf schlaeft", und genau die war in loop.py die haeufigste Fehldiagnose.
      const istLimit = USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.includes(p))
      fehler = text
      this.melden(
        o.runId, o.agentId, istLimit ? 'rate_limit' : 'error',
        istLimit ? `Nutzungslimit: ${text.slice(0, 180)}` : `Fehler: ${text.slice(0, 180)}`,
        { fehler: text, istLimit },
      )
      this.agentAendern(o.runId, o.agentId, {
        status: istLimit ? 'waiting_ratelimit' : 'failed',
        endedAt: Date.now(),
        lastError: text,
      })
    } finally {
      this.laufende.delete(k)
    }

    return { ergebnis, fehler }
  }

  private nachrichtVerarbeiten(runId: string, agentId: string, m: Record<string, unknown>): void {
    const z = einordnen(m)
    if (!z) return

    // Session-ID beim ersten Auftreten festhalten.
    if (z.sessionId) {
      const a = this.agenten.get(this.schluessel(runId, agentId))
      if (a && a.sessionId !== z.sessionId) {
        this.agentAendern(runId, agentId, { sessionId: z.sessionId })
      }
    }

    // Verbrauch fortschreiben, wo die Nachricht ihn mitbringt.
    const usage = (m.usage ?? (m.message as Record<string, unknown> | undefined)?.usage) as
      | Record<string, number>
      | undefined
    if (usage) {
      const a = this.agenten.get(this.schluessel(runId, agentId))
      if (a) {
        const { roh, gewichtet } = tokensWiegen(usage)
        this.agentAendern(runId, agentId, {
          rawTokens: a.rawTokens + roh,
          weightedTokens: a.weightedTokens + gewichtet,
          costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : a.costUsd,
          turns: typeof m.num_turns === 'number' ? m.num_turns : a.turns,
        })
      }
    }

    if (m.type === 'rate_limit_event') {
      const stand = limitStandLesen(m)
      if (stand) {
        this.limitStand = stand
        this.emit('limit', stand)
      }
    }

    const neuerStatus = STATUS_JE_KIND[z.kind]
    if (neuerStatus) {
      const a = this.agenten.get(this.schluessel(runId, agentId))
      // Wartet der Agent auf eine Freigabe, bleibt das der Zustand, bis
      // entschieden ist. Sonst ueberschreibt die naechste Nachricht -- etwa ein
      // Nutzungsstand -- den einzigen Zustand, der eine Handlung von Can braucht.
      const haeltFest =
        a?.status === 'waiting_permission' &&
        [...this.offeneFreigaben.values()].some(
          (o) => o.anfrage.runId === runId && o.anfrage.agentId === agentId,
        )
      if (!haeltFest) this.agentAendern(runId, agentId, { status: neuerStatus })
    }

    this.melden(runId, agentId, z.kind, z.summary, m, z.sessionId, z.parentToolUseId)
  }

  /**
   * Freigabe-Broker: haelt den Tool-Aufruf an, meldet die Anfrage an alle
   * Kanaele und wartet auf eine Entscheidung aus UI oder Discord.
   */
  private freigabeEinholen(
    runId: string,
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    const anfrage: PermissionRequest = {
      id: randomUUID(),
      runId,
      agentId,
      toolName,
      input,
      requestedAt: Date.now(),
      decidedAt: null,
      decision: null,
      decidedBy: null,
      reason: null,
    }
    this.db.freigabeAnlegen(anfrage)
    this.melden(runId, agentId, 'permission_request', `Freigabe noetig: ${toolName}`, anfrage)
    this.agentAendern(runId, agentId, { status: 'waiting_permission' })
    this.emit('freigabe', anfrage)

    return new Promise((resolve) => {
      this.offeneFreigaben.set(anfrage.id, {
        anfrage,
        aufloesen: (erlaubt, grund) => {
          this.offeneFreigaben.delete(anfrage.id)
          this.db.freigabeEntscheiden(anfrage.id, erlaubt ? 'allow' : 'deny', grund ?? 'ui', null)
          this.melden(
            runId, agentId, 'permission_decision',
            `${toolName}: ${erlaubt ? 'erlaubt' : 'abgelehnt'}`,
            { id: anfrage.id, erlaubt, grund },
          )
          resolve(
            erlaubt
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: grund ?? 'Im Cockpit abgelehnt' },
          )
        },
      })
    })
  }

  /** Entscheidet eine offene Freigabe. Gibt false zurueck, wenn sie unbekannt ist. */
  freigabeEntscheiden(id: string, erlaubt: boolean, durch: string): boolean {
    const offen = this.offeneFreigaben.get(id)
    if (!offen) return false
    offen.aufloesen(erlaubt, durch)
    return true
  }

  /** Letzter gemessener Limitstand, oder null solange keiner gemeldet wurde. */
  limitStandLesen(): LimitStand | null {
    return this.limitStand
  }

  offeneFreigabenListe(runId: string): PermissionRequest[] {
    return [...this.offeneFreigaben.values()]
      .map((o) => o.anfrage)
      .filter((a) => a.runId === runId)
  }

  /** Bricht einen Agenten ab. SIGINT-Semantik: der Turn endet sauber. */
  agentAbbrechen(runId: string, agentId: string): boolean {
    const l = this.laufende.get(this.schluessel(runId, agentId))
    if (!l) return false
    l.abort.abort()
    this.agentAendern(runId, agentId, { status: 'stopped', endedAt: Date.now() })
    return true
  }

  alleAbbrechen(): void {
    for (const [, l] of this.laufende) l.abort.abort()
  }
}
