// Prueft, ob ein Werkzeugaufruf des Chat-Agenten automatisch erlaubt werden
// darf, weil er nur lesend im Obsidian-Vault-Spiegel unterwegs ist.
//
// Reine Funktion, keine Seiteneffekte -- der Aufrufer (supervisor.ts ueber
// autoErlauben) entscheidet, was mit dem Ergebnis passiert, und protokolliert
// es. Bewusst eng gefasst: nur Read/Glob/Grep, nur mit einem Zielpfad, der
// nach Aufloesung wirklich UNTER dem Vault liegt. Alles andere (Write, Bash,
// ein Pfad ausserhalb) faellt zurueck auf den normalen Freigabe-Broker.

import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Werkzeuge, die rein lesend sind und automatisch erlaubt werden koennen. */
const LESENDE_WERKZEUGE = new Set(['Read', 'Glob', 'Grep'])

/** Feld, das bei jedem Werkzeug den Zielpfad traegt. */
function zielpfadFeld(toolName: string, input: Record<string, unknown>): string | null {
  const feld = toolName === 'Read' ? 'file_path' : 'path'
  const wert = input[feld]
  return typeof wert === 'string' && wert ? wert : null
}

/**
 * Loest einen Pfad absolut auf und danach, falls er existiert, ueber
 * realpath -- damit ein Symlink aus dem Vault heraus nicht als "innerhalb"
 * durchgeht. Existiert der Pfad (noch) nicht, bleibt es bei der reinen
 * Aufloesung (resolve faengt `..` dabei schon ab).
 */
export function aufgeloest(pfad: string): string {
  const absolut = resolve(pfad)
  try {
    return realpathSync(absolut)
  } catch {
    return absolut
  }
}

/** Liegt `pfad` innerhalb von (oder ist gleich) `wurzel`? Praefixvergleich MIT Trenner, damit z.B. `/vault-x` nicht als Teil von `/vault` durchgeht. */
export function innerhalbVon(pfad: string, wurzel: string): boolean {
  if (pfad === wurzel) return true
  const wurzelMitTrenner = wurzel.endsWith(sep) ? wurzel : wurzel + sep
  return pfad.startsWith(wurzelMitTrenner)
}

/**
 * Darf dieser Werkzeugaufruf ohne Rueckfrage laufen, weil er nur lesend im
 * Vault unterwegs ist?
 *
 * Read: `file_path`. Glob/Grep: `path` -- fehlt der (Suche ohne
 * eingeschraenktes Verzeichnis), gilt das NICHT automatisch, denn dann liesse
 * sich nicht pruefen, wo gesucht wird. Jedes andere Werkzeug (Write, Edit,
 * Bash, ...) ist von vornherein ausgeschlossen.
 */
export function vaultZugriffErlaubt(
  toolName: string,
  input: Record<string, unknown>,
  vaultPfad: string,
): boolean {
  if (!LESENDE_WERKZEUGE.has(toolName)) return false
  const ziel = zielpfadFeld(toolName, input)
  if (!ziel) return false
  return innerhalbVon(aufgeloest(ziel), aufgeloest(vaultPfad))
}
