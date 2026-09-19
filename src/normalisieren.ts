// SDK-Nachricht -> CockpitEvent.
//
// Bewusst defensiv: die SDKMessage-Union hat ueber vierzig Varianten und
// waechst mit jeder CLI-Version. Alles, was hier nicht ausdruecklich behandelt
// wird, landet als generisches Ereignis mit vollem Rohinhalt -- das Cockpit
// verliert dann Farbe, aber keine Information, und bricht nicht.

import type { CockpitEvent, EventKind } from './typen.js'

export interface Zuordnung {
  kind: EventKind
  summary: string
  parentToolUseId: string | null
  sessionId: string | null
}

function kuerzen(s: string, n = 200): string {
  const eine = s.replace(/\s+/g, ' ').trim()
  return eine.length > n ? eine.slice(0, n - 1) + '…' : eine
}

/** Liest Textbloecke und Tool-Aufrufe aus einer Assistant-Nachricht. */
function assistantZusammenfassen(msg: Record<string, unknown>): { kind: EventKind; summary: string } {
  const inhalt = (msg.content ?? []) as Record<string, unknown>[]
  const werkzeuge = inhalt.filter((b) => b.type === 'tool_use')
  if (werkzeuge.length > 0) {
    const namen = werkzeuge.map((w) => String(w.name ?? '?')).join(', ')
    return { kind: 'tool_use', summary: `ruft ${namen}` }
  }
  const denken = inhalt.filter((b) => b.type === 'thinking')
  if (denken.length > 0 && inhalt.every((b) => b.type === 'thinking')) {
    return { kind: 'thinking', summary: 'denkt' }
  }
  const texte = inhalt
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join(' ')
  return { kind: 'text', summary: kuerzen(texte) || 'antwortet' }
}

/**
 * Ordnet eine SDK-Nachricht ein. Gibt null zurueck fuer Nachrichten, die im
 * Cockpit kein eigenes Ereignis verdienen (z.B. reine Token-Deltas -- die
 * kaemen tausendfach und sind fuer die Uebersicht wertlos).
 */
export function einordnen(m: Record<string, unknown>): Zuordnung | null {
  const typ = String(m.type ?? '')
  const subtyp = m.subtype ? String(m.subtype) : null
  const sessionId = m.session_id ? String(m.session_id) : null
  const parent = m.parent_tool_use_id ? String(m.parent_tool_use_id) : null
  const basis = { parentToolUseId: parent, sessionId }

  switch (typ) {
    case 'assistant': {
      const msg = (m.message ?? {}) as Record<string, unknown>
      const { kind, summary } = assistantZusammenfassen(msg)
      return { ...basis, kind, summary }
    }

    case 'user': {
      // Tool-Ergebnisse kommen als user-Nachricht mit tool_result-Bloecken zurueck.
      const msg = (m.message ?? {}) as Record<string, unknown>
      const inhalt = (msg.content ?? []) as Record<string, unknown>[]
      const ergebnisse = Array.isArray(inhalt)
        ? inhalt.filter((b) => b && b.type === 'tool_result')
        : []
      if (ergebnisse.length > 0) {
        const fehler = ergebnisse.some((e) => e.is_error === true)
        return {
          ...basis,
          kind: 'tool_result',
          summary: fehler ? 'Werkzeug meldet Fehler' : `${ergebnisse.length}× Werkzeugergebnis`,
        }
      }
      const text = typeof msg.content === 'string' ? msg.content : ''
      return { ...basis, kind: 'text', summary: kuerzen(text) || 'Eingabe' }
    }

    case 'stream_event':
      // Token-Deltas: absichtlich verworfen. parent_tool_use_id ist hier immer
      // null, sie sind also keinem Subagenten zuordenbar, und als Ereignis im
      // Log waeren sie nur Rauschen.
      return null

    case 'rate_limit_event': {
      // Achtung: dieses Ereignis kommt im Normalbetrieb mehrfach und meldet
      // dann nur den Nutzungsstand (status 'allowed'). Es als Bremse zu deuten
      // war ein Fehlschluss -- nur ein status != 'allowed' haelt wirklich auf.
      const info = (m.rate_limit_info ?? {}) as Record<string, unknown>
      const status = String(info.status ?? 'unknown')
      const fenster = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number }>
      const anteil = fenster.five_hour?.utilization
      const prozent = typeof anteil === 'number' ? ` (${Math.round(anteil * 100)} % im 5-h-Fenster)` : ''
      if (status === 'allowed') {
        return { ...basis, kind: 'usage', summary: `Nutzungsstand${prozent}` }
      }
      return { ...basis, kind: 'rate_limit', summary: `Limit ${status}${prozent}` }
    }

    case 'auth_status': {
      const fehler = m.error ? String(m.error) : null
      return {
        ...basis,
        kind: fehler ? 'error' : 'hook',
        summary: fehler ? `Anmeldung: ${kuerzen(fehler, 120)}` : 'Anmeldestatus geprueft',
      }
    }

    case 'result': {
      const fehler = m.is_error === true
      const grund = subtyp ?? 'ok'
      return {
        ...basis,
        kind: fehler ? 'error' : 'result',
        summary: fehler ? `Lauf endet mit Fehler (${grund})` : `fertig (${grund})`,
      }
    }

    case 'system': {
      switch (subtyp) {
        case 'init':
          return { ...basis, kind: 'agent_start', summary: `Session bereit (${m.model ?? '?'})` }
        case 'task_started': {
          const art = m.subagent_type ? String(m.subagent_type) : 'Subagent'
          return {
            ...basis,
            kind: 'agent_start',
            parentToolUseId: m.tool_use_id ? String(m.tool_use_id) : parent,
            summary: `${art} startet: ${kuerzen(String(m.description ?? ''), 120)}`,
          }
        }
        case 'task_updated':
        case 'task_progress':
          return { ...basis, kind: 'hook', summary: kuerzen(String(m.description ?? 'Task-Fortschritt'), 120) }
        case 'task_notification':
          return { ...basis, kind: 'hook', summary: 'Task-Meldung' }
        case 'status':
          return { ...basis, kind: 'hook', summary: `Status: ${JSON.stringify(m.status ?? '')}`.slice(0, 160) }
        case 'permission_denied':
          return { ...basis, kind: 'permission_decision', summary: 'Freigabe abgelehnt' }
        case 'compact_boundary':
          return { ...basis, kind: 'hook', summary: 'Kontext verdichtet' }
        default:
          return { ...basis, kind: 'hook', summary: `system/${subtyp ?? '?'}` }
      }
    }

    case 'hook_started':
    case 'hook_progress':
    case 'hook_response':
      return { ...basis, kind: 'hook', summary: `Hook ${typ.replace('hook_', '')}` }

    default:
      return { ...basis, kind: 'hook', summary: typ || 'unbekanntes Ereignis' }
  }
}
