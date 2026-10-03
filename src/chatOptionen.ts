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
 * To-do-Listen"). Die Hinweise zur To-do-Liste und zu Spezialisten sind der Grund,
 * warum die Oberflaeche ueberhaupt Checklisten und Spezialisten-Karten zeigen
 * kann -- ohne sie nutzt das Modell beides nur selten.
 */
export function chatSystemZusatz(
  vault: string | null,
  spezialisten: boolean,
  gedaechtnis: string | null = null,
  anweisungen: string | null = null,
): string {
  // Eine Variante (src/variante.ts) bringt ihre eigene Einleitung mit -- die
  // des Haupt-Cockpits spricht von Can und gilt dort nicht.
  if (anweisungen) return variantenZusatz(anweisungen, spezialisten, gedaechtnis, vault)
  const teile = [
    'Du arbeitest im Cockpit, Cans Oberflaeche fuer Claude Code. Antworte auf Deutsch, ' +
      'wenn Can Deutsch schreibt.',
    'Lege bei jeder Aufgabe mit mehr als einem Schritt zuerst eine To-do-Liste an ' +
      '(TaskCreate je Punkt, bzw. TodoWrite, falls es das gibt) und halte sie waehrend der ' +
      'Arbeit aktuell: Punkt auf in_progress, sobald du ihn beginnst, auf completed, sobald ' +
      'er fertig ist -- Can sieht sie als Checkliste.',
    'Lerne aus jeder Aufgabe. Ist eine Aufgabe erledigt, oder hat Can etwas korrigiert, ' +
      'verworfen, gelobt oder anders haben wollen, dann halte vor deiner Antwort fest, was ' +
      'davon auch beim naechsten Mal gilt -- in deinem Gedaechtnis (auto memory). Nicht, was ' +
      'nur fuer diese eine Aufgabe gilt oder ohnehin im Code steht.',
  ]
  if (spezialisten) {
    teile.push(
      'Du kannst Spezialisten (Subagenten) mit dem Agent-Werkzeug beauftragen, wenn ihre ' +
        'Beschreibung zur Aufgabe passt. Rufe sie immer im Vordergrund auf ' +
        '(run_in_background: false), damit ihr Ergebnis in diesem Zug zurueckkommt. ' +
        'Den Planer nur bei komplexen Vorhaben mit vielen Schritten -- einfache Aufgaben ' +
        'erledigst du selbst.',
    )
    if (gedaechtnis) {
      // Der Spezialist pflegt sein Gedaechtnis selbst, sieht aber nur seinen
      // Auftrag -- Cans Reaktion auf sein Ergebnis kommt nur hier an.
      teile.push(
        `Jeder Spezialist hat ein eigenes Gedaechtnis unter ${gedaechtnis}/<name>/ ` +
          '(MEMORY.md als Index, eine Datei je Erkenntnis) und pflegt es selbst. Cans ' +
          'Rueckmeldung zu seinem Ergebnis sieht er aber nie. Die traegst du dort ein: ' +
          'verwirft Can einen Entwurf des Gestalters oder macht er dem Server-Admin eine ' +
          'Vorgabe, gehoert das in dessen Gedaechtnis, damit er es beim naechsten Auftrag ' +
          'schon weiss. Lesen und Schreiben dort braucht keine Freigabe.',
      )
    }
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

/**
 * Systemprompt-Zusatz einer Variante: deren anweisungen.md, dazu dieselben
 * Hinweise zu Spezialisten und deren Gedaechtnis wie im Haupt-Cockpit, nur
 * ohne Namen -- eine Variante kann mehrere Leute haben. Einen Vault gibt es
 * dort nicht.
 */
function variantenZusatz(anweisungen: string, spezialisten: boolean, gedaechtnis: string | null, vault: string | null): string {
  const teile = [anweisungen]
  if (vault) {
    // Der eigene Vault einer Variante ist kein Spiegel: hier gehoert alles hin.
    teile.push(
      `Euer gemeinsamer Obsidian-Vault liegt unter ${vault}. Halte dort alles fest, was ueber ` +
        'diesen Chat hinaus wichtig ist: je Spiel eine Notiz (Idee, Stand, Systeme, offene Punkte), ' +
        'Entscheidungen mit Begruendung, Anleitungen fuer Studio. Obsidian-Markdown mit [[Verweisen]]; ' +
        'erst nachsehen, ob es die Notiz schon gibt, dann ergaenzen statt doppelt anlegen. ' +
        'Lesen und Schreiben dort braucht keine Freigabe. Die Nutzer sehen den Vault im Cockpit und in Obsidian.',
    )
  }
  if (spezialisten) {
    teile.push(
      'Du kannst Spezialisten (Subagenten) mit dem Agent-Werkzeug beauftragen, wenn ihre ' +
        'Beschreibung zur Aufgabe passt. Rufe sie immer im Vordergrund auf ' +
        '(run_in_background: false), damit ihr Ergebnis in diesem Zug zurueckkommt. ' +
        'Den Planer nur bei komplexen Vorhaben mit vielen Schritten -- einfache Aufgaben ' +
        'erledigst du selbst.',
    )
    if (gedaechtnis) {
      teile.push(
        `Jeder Spezialist hat ein eigenes Gedaechtnis unter ${gedaechtnis}/<name>/ ` +
          '(MEMORY.md als Index, eine Datei je Erkenntnis) und pflegt es selbst. Die ' +
          'Rueckmeldung des Nutzers zu seinem Ergebnis sieht er aber nie. Die traegst du dort ' +
          'ein: verwirft der Nutzer einen Entwurf eines Spezialisten oder macht ihm eine ' +
          'Vorgabe, gehoert das in dessen Gedaechtnis, damit er es beim naechsten Auftrag ' +
          'schon weiss. Lesen und Schreiben dort braucht keine Freigabe.',
      )
    }
  }
  return teile.join('\n\n')
}

export function chatOptionenBauen(
  e: Einstellungen,
  wunsch: Record<string, unknown> | null,
  agents: () => Record<string, AgentDefinition>,
  vault: string | null,
  gedaechtnis: string | null = null,
  anweisungen: string | null = null,
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
      systemPromptZusatz: chatSystemZusatz(vault, Object.keys(definitionen).length > 0, gedaechtnis, anweisungen),
    },
  }
}
