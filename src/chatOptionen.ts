// Aus den Einstellungen und dem, was die Oberflaeche fuer DIESEN Zug waehlt
// (Modell, Denkaufwand, Berechtigungsmodus), werden die Optionen eines
// Chat-Zugs. Reine Funktion, damit sie sich ohne Daemon testen laesst.
//
// Die Einstellungen sind nur die Vorgabe: im Eingabefeld kann man Modell,
// Aufwand und Modus je Nachricht umstellen, wie in Claude Desktop. Ungueltige
// Werte aus der Anfrage sind ein Fehler (400), kein stilles Zurueckfallen auf
// die Vorgabe -- sonst liefe ein Chat mit einem anderen Modell als dem
// angezeigten.

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import {
  type Aufwand, type Berechtigung, type Einstellungen,
  aufwandGueltig, berechtigungGueltig, modellGueltig,
} from './einstellungen.js'

export interface ChatOptionen {
  model: string
  /** Fehlt bei Modellen ohne Denkaufwand-Stufen (Haiku). */
  effort?: Aufwand
  permissionMode: Berechtigung
  /** [] = isoliert, sonst wie die CLI (CLAUDE.md, Skills, settings.json). */
  settingSources: ('user' | 'project' | 'local')[]
  /** Fehlt, wenn Spezialisten aus sind. */
  agents?: Record<string, AgentDefinition>
  liveText: boolean
  systemPromptZusatz: string
}

/**
 * Haiku 4.5 kennt keine effort-Stufen; die CLI lehnt den Parameter dort je
 * nach Version ab. Deshalb nur fuer Modelle schicken, die ihn sicher kennen.
 */
export function kenntAufwand(modell: string): boolean {
  return !/haiku/i.test(modell)
}

/**
 * Zusatz zum claude_code-Systemprompt fuer Chats (Plan: "Spezialisten und
 * To-do-Listen"). Die Hinweise zu TodoWrite und Spezialisten sind der Grund,
 * warum die Oberflaeche ueberhaupt Checklisten und Spezialisten-Karten zeigen
 * kann -- ohne sie nutzt das Modell beides nur selten.
 */
export function chatSystemZusatz(vault: string | null, spezialisten: boolean): string {
  const teile = [
    'Du arbeitest im Cockpit, Cans Oberflaeche fuer Claude Code. Antworte auf Deutsch, ' +
      'wenn Can Deutsch schreibt.',
    'Lege bei jeder Aufgabe mit mehr als einem Schritt zuerst mit TodoWrite eine ' +
      'To-do-Liste an und halte sie waehrend der Arbeit aktuell -- Can sieht sie als Checkliste.',
  ]
  if (spezialisten) {
    teile.push(
      'Du kannst Spezialisten (Subagenten) mit dem Agent-Werkzeug beauftragen, wenn ihre ' +
        'Beschreibung zur Aufgabe passt. Rufe sie immer im Vordergrund auf ' +
        '(run_in_background: false), damit ihr Ergebnis in diesem Zug zurueckkommt. ' +
        'Den Planer nur bei komplexen Vorhaben mit vielen Schritten -- einfache Aufgaben ' +
        'erledigst du selbst.',
    )
  }
  if (vault) {
    teile.push(
      `Cans Obsidian-Vault (persoenliche Notizen, SOPs) liegt nur lesend unter ${vault}. ` +
        'Bei Fragen zu seinem Setup dort mit Grep/Glob/Read nachsehen. Schreiben dort ist ' +
        'sinnlos -- es ist nur ein Spiegel.',
    )
  }
  return teile.join('\n\n')
}

export function chatOptionenBauen(
  e: Einstellungen,
  wunsch: Record<string, unknown> | null,
  agents: () => Record<string, AgentDefinition>,
  vault: string | null,
): { fehler: string } | { optionen: ChatOptionen } {
  const modell = wunsch?.modell ?? e.modell
  if (!modellGueltig(modell)) return { fehler: `Unbekanntes Modell: ${String(modell)}` }
  const aufwand = wunsch?.aufwand ?? e.aufwand
  if (!aufwandGueltig(aufwand)) return { fehler: `Unbekannter Denkaufwand: ${String(aufwand)}` }
  const berechtigung = wunsch?.berechtigung ?? e.berechtigung
  if (!berechtigungGueltig(berechtigung)) return { fehler: `Unbekannter Berechtigungsmodus: ${String(berechtigung)}` }

  const mitSpezialisten = e.spezialisten
  const definitionen = mitSpezialisten ? agents() : {}
  return {
    optionen: {
      model: modell,
      ...(kenntAufwand(modell) ? { effort: aufwand } : {}),
      permissionMode: berechtigung,
      settingSources: e.claudeMdLaden ? ['user', 'project', 'local'] : [],
      ...(Object.keys(definitionen).length ? { agents: definitionen } : {}),
      liveText: e.liveText,
      systemPromptZusatz: chatSystemZusatz(vault, Object.keys(definitionen).length > 0),
    },
  }
}
