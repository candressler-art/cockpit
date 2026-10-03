// Aus einer Entscheidung in der Oberflaeche wird die Antwort an die SDK
// (PermissionResult) -- reine Funktion, damit sie sich ohne Agenten testen
// laesst.
//
// Die SDK kennt mehr als "ja/nein", und genau das braucht die Bedienung wie
// in Claude Code:
// - "Immer erlauben": die SDK schlaegt mit jeder Anfrage passende Regeln vor
//   (`suggestions`). Gibt man sie als `updatedPermissions` zurueck, fragt sie
//   in dieser Sitzung nicht noch einmal. Die Vorschlaege zielen oft auf
//   'localSettings' (so macht es die CLI bei "nicht mehr fragen"); hier wird
//   das Ziel auf 'session' umgeschrieben -- ein Klick im Cockpit soll keine
//   Einstellungsdatei im Projekt aendern, die dann auch Cans CLI-Sitzungen
//   am PC betrifft.
// - AskUserQuestion: die Antworten gehen als `updatedInput.answers`
//   ({Fragetext: Antwort}) zurueck, der Aufruf selbst wird "erlaubt".
// - ExitPlanMode: "Plan annehmen" erlaubt den Aufruf und schaltet die
//   Sitzung per `setMode` in den gewaehlten Modus; "weiter planen" lehnt ab,
//   und die Rueckmeldung landet als Ablehnungsgrund beim Modell.

import type { PermissionMode, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

export interface Entscheidung {
  erlaubt: boolean
  /** "Immer erlauben" fuer diese Sitzung. */
  immer?: boolean
  /** AskUserQuestion: Fragetext -> gewaehlte Antwort(en). */
  antworten?: Record<string, string>
  /** ExitPlanMode: Modus nach dem Annehmen des Plans. */
  modus?: PermissionMode
  /** Freitext: Ablehnungsgrund bzw. Rueckmeldung zum Plan. */
  nachricht?: string
}

/**
 * Modi, in die ein angenommener Plan wechseln darf. 'auto' ja (die
 * Sicherheitspruefung bleibt an), 'bypassPermissions' bewusst nicht.
 */
const PLAN_MODI = new Set<string>(['default', 'acceptEdits', 'auto'])

/** Vorschlaege auf die laufende Sitzung umschreiben -- nichts davon landet in einer Datei. */
export function sitzungsVorschlaege(vorschlaege: PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (vorschlaege ?? [])
    .filter((v) => v && typeof v === 'object' && typeof v.type === 'string')
    .map((v) => ({ ...v, destination: 'session' as const }))
}

/**
 * Entscheidung aus dem Anfragekoerper lesen. Unbekannte oder falsch getypte
 * Felder fallen weg statt den Aufruf scheitern zu lassen -- die Grundfrage
 * (erlaubt?) ist immer beantwortbar.
 */
export function entscheidungLesen(k: Record<string, unknown> | null): Entscheidung {
  const e: Entscheidung = { erlaubt: k?.erlaubt === true }
  if (k?.immer === true) e.immer = true
  if (k?.antworten && typeof k.antworten === 'object' && !Array.isArray(k.antworten)) {
    const a: Record<string, string> = {}
    for (const [frage, antwort] of Object.entries(k.antworten as Record<string, unknown>)) {
      if (typeof antwort === 'string') a[frage] = antwort.slice(0, 4000)
    }
    e.antworten = a
  }
  if (typeof k?.modus === 'string' && PLAN_MODI.has(k.modus)) e.modus = k.modus as PermissionMode
  if (typeof k?.nachricht === 'string' && k.nachricht.trim()) e.nachricht = k.nachricht.trim().slice(0, 4000)
  return e
}

export function freigabeErgebnis(
  toolName: string,
  input: Record<string, unknown>,
  vorschlaege: PermissionUpdate[] | undefined,
  e: Entscheidung,
  grund: string | null,
): PermissionResult {
  if (!e.erlaubt) {
    // Bei ExitPlanMode heisst Ablehnen "weiter planen" -- ohne Rueckmeldung
    // wuesste das Modell nicht, dass es weiterarbeiten soll.
    const standard = toolName === 'ExitPlanMode'
      ? 'Der Plan wurde noch nicht angenommen. Bitte weiter planen und den Plan ueberarbeiten.'
      : (grund && grund !== 'ui' ? grund : 'Im Cockpit abgelehnt')
    return { behavior: 'deny', message: e.nachricht ? `${standard}\nRueckmeldung: ${e.nachricht}` : standard }
  }
  const updatedPermissions: PermissionUpdate[] = []
  let updatedInput = input
  if (toolName === 'AskUserQuestion' && e.antworten) {
    updatedInput = { ...input, answers: e.antworten }
  }
  if (toolName === 'ExitPlanMode' && e.modus) {
    updatedPermissions.push({ type: 'setMode', mode: e.modus, destination: 'session' })
  }
  if (e.immer) updatedPermissions.push(...sitzungsVorschlaege(vorschlaege))
  return updatedPermissions.length
    ? { behavior: 'allow', updatedInput, updatedPermissions }
    : { behavior: 'allow', updatedInput }
}
