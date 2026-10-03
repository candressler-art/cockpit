// Regeln der Chat-Warteschlange (Nachrichten, die Can schreibt, waehrend
// Claude noch arbeitet). Rein und ohne Daemon, damit sie sich testen lassen;
// daemon.ts (warteschlangeAbarbeiten) fuehrt sie aus, chats.ts speichert.

import type { WarteEintrag } from './chats.js'

export interface Lage {
  /** Status des Chat-Agenten nach dem Zug, der gerade endete. */
  status: string | undefined
  /** Wann Can "Anhalten" gedrueckt hat, sofern bekannt. */
  angehaltenAm: number | null
  /** Can hat "Jetzt senden" gedrueckt: auch Gehaltenes geht raus. */
  trotzHalt: boolean
}

/**
 * Was nach dem Ende eines Zugs mit der Warteschlange geschieht:
 * - "Jetzt senden": alles raus.
 * - Kein Konto nutzbar: alles halten -- der Zug scheiterte sofort wieder.
 * - Angehalten: was VOR dem Anhalten geschrieben wurde, halten (Can wollte
 *   eingreifen, nicht dass die alte Anweisung ungefragt doch noch laeuft);
 *   was danach kam, ist schon die Antwort auf das Anhalten und geht raus.
 * - Sonst: alles Ungehaltene raus. Gehaltenes bleibt, bis Can es schickt.
 */
export function schlangeEntscheiden(
  eintraege: readonly WarteEintrag[], lage: Lage,
): { senden: WarteEintrag[]; halten: number[] } {
  if (lage.trotzHalt) return { senden: [...eintraege], halten: [] }
  const offen = eintraege.filter((e) => !e.gehalten)
  if (lage.status === 'waiting_ratelimit') return { senden: [], halten: offen.map((e) => e.nr) }
  if (lage.status === 'stopped') {
    const grenze = lage.angehaltenAm ?? Number.POSITIVE_INFINITY
    return {
      senden: offen.filter((e) => e.erstellt > grenze),
      halten: offen.filter((e) => e.erstellt <= grenze).map((e) => e.nr),
    }
  }
  return { senden: offen, halten: [] }
}

/**
 * Welche Optionen der Zug aus der Warteschlange bekommt. Die der letzten
 * Nachricht -- ausser am Chat wurde seither etwas umgestellt (Plan mit
 * "Selbststaendig" angenommen): dann gilt der aktuelle Stand, sonst drehte
 * eine Nachricht von vorhin den Modus still zurueck. {} heisst: wie gemerkt.
 */
export function schlangeOptionen(
  senden: readonly Pick<WarteEintrag, 'optionen' | 'erstellt'>[], gemerktAm: number | null,
): Record<string, unknown> {
  const letzte = senden.at(-1)
  if (!letzte || (gemerktAm !== null && gemerktAm > letzte.erstellt)) return {}
  return letzte.optionen
}
