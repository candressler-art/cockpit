// Gemeinsames zum Obsidian-Vault (Syncthing-Spiegel): Ort, Verweis- und
// Schlagwortmuster, Titelregel. Suchen und Lesen macht src/notizen.ts.
//
// Frueher stand hier zusaetzlich ein Graph-Index fuer die 3D-Ansicht
// ("Wissenskern"); der ist mit der alten Oberflaeche weggefallen.

import { stat } from 'node:fs/promises'
import { sep } from 'node:path'
import { VARIANTE } from './variante.js'

/** Auch fuer andere Module (z.B. den Chat-Agenten), die denselben Spiegel lesen wollen. */
// Eine Variante mit eigenem Vault (z.B. das Roblox-Cockpit) nimmt den, nie den Spiegel.
export const VAULT = VARIANTE.vault ?? process.env.COCKPIT_VAULT ?? '/var/lib/cockpit/vault'

/** [[Ziel]], [[Ziel|Anzeigetext]] und [[Ziel#Abschnitt]]. */
export const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
/** #tag, aber nicht die Raute einer Ueberschrift und keine Raute in Wortmitte. */
export const TAG = /(?:^|\s)#([A-Za-z0-9ÄÖÜäöüß][A-Za-z0-9ÄÖÜäöüß/_-]*)/g

/** Titel: erste Ueberschrift, sonst Dateiname. Obsidian macht es genauso. */
export function titelAus(pfad: string, roh: string): string {
  const m = /^#\s+(.+)$/m.exec(roh)
  if (m?.[1]) return m[1].trim().slice(0, 120)
  const name = pfad.split(sep).pop() ?? pfad
  return name.replace(/\.md$/, '')
}

/** Existiert der Spiegel ueberhaupt? Fuer eine ehrliche Meldung im Bereich Notizen. */
export async function vaultDa(): Promise<boolean> {
  try {
    return (await stat(VAULT)).isDirectory()
  } catch {
    return false
  }
}
