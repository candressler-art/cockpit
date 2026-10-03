// Gedaechtnis der Fachrollen: was ein Spezialist aus frueheren Auftraegen
// gelernt hat.
//
// Die Ablage ist die der CLI (AgentDefinition.memory = 'user'):
// <CLAUDE_CONFIG_DIR>/agent-memory/<rolle>/ mit MEMORY.md als Index und einer
// Datei je Erkenntnis. Die CLI laedt MEMORY.md in den Prompt eines Subagenten
// und gibt ihm Read/Write/Edit dafuer -- auch einer Rolle, die sonst nur
// lesen darf.
//
// Drei Dinge macht die CLI nicht, und deshalb gibt es diese Datei:
//
//   - Orchestrator-Worker sind keine Subagenten. Ihr Gedaechtnis kommt ueber
//     gedaechtnisVorspann() in den Prompt, sonst lernten sie nur im Chat.
//   - Jedes Konto hat sein eigenes CLAUDE_CONFIG_DIR. Ohne den Symlink aus
//     deploy/konto-hinzufuegen.sh wuesste ein Spezialist unter 'zweit' nichts
//     von dem, was er unter 'haupt' gelernt hat. Massgeblich ist deshalb
//     immer das Verzeichnis des Hauptkontos.
//   - Schreiben ins Gedaechtnis ist fuer die CLI ein gewoehnlicher Write und
//     fragt im Modus "Nachfragen" nach -- auch der Chat selbst, wenn er in
//     sein eigenes Gedaechtnis (projects/<projekt>/memory/) schreibt.
//     gedaechtnisZugriffErlaubt() nimmt beides aus der Freigabe heraus.

import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { hauptConfigDir } from './konten.js'
import { innerhalbVon } from './vaultZugriff.js'

/** Wurzel aller Rollen-Gedaechtnisse (Hauptkonto). */
export function gedaechtnisWurzel(): string {
  return join(hauptConfigDir(), 'agent-memory')
}

/** So viele Zeilen MEMORY.md laedt auch die CLI; was darueber liegt, ist ein Index, der aufgeraeumt gehoert. */
const MAX_ZEILEN = 200

/**
 * Wie aufgeloest() in vaultZugriff.ts, aber auch fuer Dateien, die es noch
 * nicht gibt: realpath des naechsten vorhandenen Vorfahren. Noetig, weil eine
 * NEUE Notiz unter dem Symlink eines Zusatzkontos
 * (~/.claude-konten/zweit/agent-memory/...) sonst unaufgeloest bliebe und
 * nicht als "innerhalb" der Wurzel des Hauptkontos erkannt wuerde.
 */
function aufgeloestUeberVorfahr(pfad: string): string {
  let rest: string[] = []
  let aktuell = resolve(pfad)
  for (;;) {
    try {
      return join(realpathSync(aktuell), ...rest)
    } catch {
      const eltern = dirname(aktuell)
      if (eltern === aktuell) return resolve(pfad)
      rest = [basename(aktuell), ...rest]
      aktuell = eltern
    }
  }
}

/** Werkzeuge, mit denen ein Agent sein Gedaechtnis pflegt. Bash gehoert nicht dazu -- dort laesst sich das Ziel nicht pruefen. */
const GEDAECHTNIS_WERKZEUGE = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])

/** Aufgeloester Zielpfad eines Datei-Werkzeugs, oder null fuer alles andere (Bash, fehlender Pfad). */
function zielpfad(toolName: string, input: Record<string, unknown>): string | null {
  if (!GEDAECHTNIS_WERKZEUGE.has(toolName)) return null
  const feld = toolName === 'Glob' || toolName === 'Grep' ? 'path' : 'file_path'
  const ziel = input[feld]
  return typeof ziel === 'string' && ziel ? aufgeloestUeberVorfahr(ziel) : null
}

/**
 * Lesen und Schreiben ohne Rueckfrage in genau einem Ordner -- fuer den
 * eigenen Vault einer Variante (variante.ts vaultSchreiben), in den die
 * Agenten alles festhalten sollen. Dieselben Werkzeuge wie beim Gedaechtnis.
 */
export function ordnerZugriffErlaubt(toolName: string, input: Record<string, unknown>, wurzel: string): boolean {
  const pfad = zielpfad(toolName, input)
  return pfad !== null && innerhalbVon(pfad, aufgeloestUeberVorfahr(wurzel))
}

/**
 * Darf dieser Werkzeugaufruf ohne Rueckfrage laufen, weil er nur in einem
 * Gedaechtnis liest oder schreibt -- dem der Fachrollen (`wurzel`) oder dem
 * eines Chats (`projekte/<projekt>/memory/`)?
 *
 * Ohne diese Ausnahme stuende jeder Lernschritt im Modus "Nachfragen" und in
 * jedem Orchestrator-Lauf als Freigabe an -- und ein Lauf ueber Nacht wartete
 * wegen einer Notiz auf Can. Unter projects/ liegen auch die Sitzungsverlaeufe;
 * deshalb dort nur der memory-Ordner direkt unter einem Projekt.
 */
export function gedaechtnisZugriffErlaubt(
  toolName: string,
  input: Record<string, unknown>,
  wurzel: string = gedaechtnisWurzel(),
  projekte: string = join(hauptConfigDir(), 'projects'),
): boolean {
  const pfad = zielpfad(toolName, input)
  if (!pfad) return false
  if (innerhalbVon(pfad, aufgeloestUeberVorfahr(wurzel))) return true
  const teile = relative(aufgeloestUeberVorfahr(projekte), pfad).split(sep)
  return teile.length >= 2 && teile[0] !== '..' && teile[0] !== '' && teile[1] === 'memory'
}

/**
 * Je Rolle den Ordner anlegen, falls er fehlt. Sonst greift ein Agent vor der
 * ersten Notiz gern zu `mkdir` -- und Bash faellt nicht unter
 * gedaechtnisZugriffErlaubt, kostet im Modus "Nachfragen" also eine Freigabe.
 * Scheitern ist kein Startfehler: dann legt eben Write den Ordner an.
 */
export function gedaechtnisOrdnerAnlegen(rollen: string[], wurzel: string = gedaechtnisWurzel()): void {
  for (const rolle of rollen) {
    try {
      mkdirSync(join(wurzel, rolle), { recursive: true })
    } catch (e) {
      console.warn(`[gedaechtnis] ${join(wurzel, rolle)} nicht angelegt:`, String(e))
    }
  }
}

/**
 * Das Gedaechtnis einer Rolle als Prompt-Abschnitt fuer einen
 * Orchestrator-Worker -- das Gegenstueck zu dem, was die CLI einem
 * Subagenten von selbst mitgibt. Auch ohne vorhandene MEMORY.md, damit der
 * erste Worker einer Rolle weiss, wohin er schreiben soll.
 */
export function gedaechtnisVorspann(rolle: string, wurzel: string = gedaechtnisWurzel()): string {
  const verzeichnis = join(wurzel, rolle)
  let index = ''
  try {
    index = readFileSync(join(verzeichnis, 'MEMORY.md'), 'utf-8').split('\n').slice(0, MAX_ZEILEN).join('\n').trim()
  } catch {
    // Noch nichts gelernt -- kein Fehler.
  }
  return (
    `# Dein Gedaechtnis\n\n` +
    `Was du aus frueheren Auftraegen gelernt hast, liegt in ${verzeichnis}/: ` +
    `MEMORY.md ist der Index (eine Zeile je Notiz), jede Erkenntnis steht in einer eigenen Datei daneben. ` +
    `Lies eine Notiz, wenn ihre Indexzeile zu deinem Auftrag passt. ` +
    `Bevor du deinen Report schreibst: Was aus diesem Auftrag gilt auch beim naechsten Mal? ` +
    `Das haeltst du dort fest (neue Datei plus Zeile in MEMORY.md, oder eine vorhandene Notiz berichtigen). ` +
    `Lesen und Schreiben dort braucht keine Freigabe.\n\n` +
    (index ? `## MEMORY.md\n\n${index}` : 'MEMORY.md gibt es noch nicht -- du waerst der Erste.')
  )
}
