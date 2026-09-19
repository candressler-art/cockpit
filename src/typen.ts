// Normalisiertes Ereignisschema des Cockpits.
//
// Warum eine eigene Schicht und nicht die SDK-Typen direkt: das Frontend soll
// nicht brechen, wenn das SDK seine Nachrichtenformen aendert, und die
// Persistenz braucht eine stabile, monoton numerierte Reihenfolge fuer den
// Backfill nach einem Reconnect. Die Rohnachricht bleibt in `payload`
// erhalten, damit nichts verloren geht, was spaeter noch gebraucht wird.

/** Was ein Ereignis bedeutet. Bewusst grob -- das UI faerbt danach. */
export type EventKind =
  | 'run_start'
  | 'run_end'
  | 'agent_start'
  | 'agent_end'
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'permission_decision'
  | 'usage'
  | 'result'
  | 'rate_limit'
  | 'error'
  | 'hook'
  | 'protocol'

/** Rolle eines Agenten im Lauf. */
export type AgentRole = 'orchestrator' | 'worker' | 'chat' | 'subagent'

/** Status eines Agenten, wie ihn der Graph anzeigt. */
export type AgentStatus =
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'writing'
  | 'waiting_permission'
  | 'waiting_ratelimit'
  | 'queued'
  | 'done'
  | 'failed'
  | 'stopped'

export interface CockpitEvent {
  /** Monoton steigend je Lauf. Der Client schickt seine letzte seq beim Reconnect. */
  seq: number
  ts: number
  runId: string
  /** Stabile Kennung des Agenten innerhalb des Laufs, z.B. "orchestrator" oder "worker-2". */
  agentId: string
  /** Session-ID der CLI, sobald bekannt -- vorher null. */
  sessionId: string | null
  kind: EventKind
  /** Fuer Subagenten: die tool_use-ID des Aufrufs, der sie gestartet hat. */
  parentToolUseId: string | null
  /** Kurztext fuer Listenansichten; das Volle steht in payload. */
  summary: string
  payload: unknown
}

/** Ein Agent, wie der Graph ihn kennt. */
export interface AgentState {
  agentId: string
  runId: string
  role: AgentRole
  status: AgentStatus
  sessionId: string | null
  label: string
  parentAgentId: string | null
  model: string | null
  cwd: string | null
  startedAt: number
  endedAt: number | null
  /** Gewichteter Tokenverbrauch nach loop.py-Gewichten. */
  weightedTokens: number
  rawTokens: number
  costUsd: number
  turns: number
  lastError: string | null
}

/** Offene Freigabeanfrage, die in UI und Discord entschieden werden kann. */
export interface PermissionRequest {
  id: string
  runId: string
  agentId: string
  toolName: string
  input: unknown
  requestedAt: number
  decidedAt: number | null
  decision: 'allow' | 'deny' | null
  decidedBy: string | null
  reason: string | null
}

/**
 * Gewichte des Tokenbudgets, uebernommen aus loop.py (TOKEN_GEWICHTE, Z. 141-146).
 * Eine ungewichtete Summe misst Cache-Treffer statt Kosten: im Messlauf war
 * cache_read 92,9 % der Rohsumme und zugleich das billigste Feld.
 */
export const TOKEN_GEWICHTE = {
  input_tokens: 1.0,
  cache_creation_input_tokens: 1.25,
  cache_read_input_tokens: 0.1,
  output_tokens: 5.0,
} as const

export interface UsageLike {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

/** Rohe und gewichtete Summe eines usage-Objekts. */
export function tokensWiegen(usage: UsageLike | null | undefined): {
  roh: number
  gewichtet: number
} {
  if (!usage) return { roh: 0, gewichtet: 0 }
  let roh = 0
  let gewichtet = 0
  for (const [feld, gewicht] of Object.entries(TOKEN_GEWICHTE)) {
    const wert = (usage as Record<string, number | undefined>)[feld] ?? 0
    roh += wert
    gewichtet += wert * gewicht
  }
  return { roh, gewichtet }
}

/**
 * Auslastung der Nutzungsfenster, wie sie das SDK in `rate_limit_event`
 * mitliefert. Das sind gemessene Werte vom Server -- deutlich verlaesslicher
 * als die gewichtete Schaetzung aus loop.py, die nur ein Hilfsmittel war,
 * solange niemand die echten Zahlen kannte. Die Gewichte bleiben trotzdem
 * nuetzlich, um den Verbrauch einzelnen Agenten zuzuordnen; die Fenster gelten
 * fuer das ganze Konto.
 */
export interface LimitStand {
  /** 'allowed' heisst: laeuft. Alles andere ist eine Bremse. */
  status: string
  rateLimitType: string | null
  resetsAt: number | null
  /** Anteil 0..1 des Fuenf-Stunden-Fensters. */
  fuenfStundenAnteil: number | null
  fuenfStundenResetsAt: number | null
  /** Anteil 0..1 des Wochenfensters. */
  siebenTageAnteil: number | null
  siebenTageResetsAt: number | null
  gemessenAm: number
}

/** Liest den Limitstand aus einem rate_limit_event. Gibt null bei unbekannter Form. */
export function limitStandLesen(payload: unknown): LimitStand | null {
  const p = payload as Record<string, unknown> | null
  const info = p?.rate_limit_info as Record<string, unknown> | undefined
  if (!info) return null
  const fenster = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number }>
  const f5 = fenster.five_hour
  const f7 = fenster.seven_day
  return {
    status: String(info.status ?? 'unknown'),
    rateLimitType: info.rateLimitType ? String(info.rateLimitType) : null,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
    fuenfStundenAnteil: typeof f5?.utilization === 'number' ? f5.utilization : null,
    fuenfStundenResetsAt: typeof f5?.resetsAt === 'number' ? f5.resetsAt : null,
    siebenTageAnteil: typeof f7?.utilization === 'number' ? f7.utilization : null,
    siebenTageResetsAt: typeof f7?.resetsAt === 'number' ? f7.resetsAt : null,
    gemessenAm: Date.now(),
  }
}
