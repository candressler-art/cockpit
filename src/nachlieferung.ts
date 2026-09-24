// Senden an WebSocket-Klienten und die Nachlieferung nach `folgen`.
//
// Aus daemon.ts herausgeloest, damit sich Rueckstau und Seitenweise-Nachliefern
// ohne echten Server und ohne echtes langsames Netz testen lassen.
//
// Frueher lieferte der Daemon den Rueckstand in EINEM synchronen Rutsch aus
// (db.ereignisseSeit, gedeckelt bei 5000 Ereignissen). Zwei Folgen:
// - Ein Lauf mit mehr als 5000 Ereignissen (Orchestrator mit mehreren Workern
//   ueber viele Runden) bekam im Lauf-Tab ein Loch: REST liefert 1..5000, das
//   `folgen` danach 5001..10000, alles darueber fehlte, bis neue Live-
//   Ereignisse die letzte seq darueber hinaus schoben.
// - Nahm der Klient nicht sofort ab (Handy, schlechtes Netz -- in der
//   Testinstanz reichte eine Sekunde Pause), lief der Puffer ueber die
//   Rueckstau-Grenze, und senden() trennte die Verbindung. Der Klient
//   verband neu, bekam den naechsten Brocken, wurde wieder getrennt -- die
//   ganze Oberflaeche (alle Tabs teilen sich die Verbindung) blinkte
//   "getrennt", bis der Rueckstand in Etappen durch war.
//
// Jetzt: Seite fuer Seite, und zwischen den Seiten warten, bis der Puffer
// wieder abgeflossen ist. Live-Nachrichten, die waehrenddessen anfallen,
// warten in einer Schlange und gehen erst hinterher raus -- sonst schoebe
// ein neues Ereignis die letzte seq des Klienten ueber den Rest der
// Nachlieferung hinweg, und der Lauf-Tab verwuerfe ihn als "schon gezeigt".

import type { CockpitEvent } from './typen.js'

export interface KlientSocket {
  readyState: number
  bufferedAmount: number
  send(daten: string): void
  terminate(): void
}

export interface Klient {
  sock: KlientSocket
  runId: string | null
  /** Solange gesetzt, laeuft eine Nachlieferung; Live-Nachrichten warten hier. */
  wartend?: Array<[string, unknown]> | null
  /** Zaehlt `folgen` hoch -- eine aeltere Nachlieferung bricht dann ab. */
  folgeNr?: number
}

/**
 * Ab hier gilt ein Klient als ueberfahren.
 *
 * Ein Handy im schlechten Netz nimmt die Ereignisse eines schnellen Laufs
 * nicht schnell genug ab; der Puffer im Prozess waechst dann unbegrenzt.
 * Zwei Megabyte sind rund ein Tausendfaches einer normalen Nachricht --
 * wer so weit hinterherhaengt, hat den Anschluss ohnehin verloren und holt
 * ihn beim Wiederverbinden per Backfill nach.
 */
export const MAX_RUECKSTAU = 2 * 1024 * 1024
/** Nachlieferung pausiert ab hier und wartet, bis der Puffer abgeflossen ist. */
const NACHLIEFER_SCHWELLE = MAX_RUECKSTAU / 4
/** So viele Live-Nachrichten duerfen hinter einer Nachlieferung warten. */
const MAX_WARTEND = 20_000

function trennen(k: Klient, grund: string, entfernen: (k: Klient) => void): void {
  console.warn(`[cockpit] Klient haengt zurueck, Verbindung getrennt bei: ${grund}`)
  k.wartend = null
  k.sock.terminate()
  entfernen(k)
}

/**
 * Direkt auf die Leitung, an einer laufenden Nachlieferung vorbei. Nur fuer
 * die Nachlieferung selbst und fuer senden() unten.
 */
function direktSenden(k: Klient, typ: string, daten: unknown, entfernen: (k: Klient) => void): void {
  if (k.sock.readyState !== 1) return
  if (k.sock.bufferedAmount > MAX_RUECKSTAU) {
    // Trennen statt nur diese Nachricht verwerfen: sonst kaemen die
    // spaeteren an, der Klient zoege seine letzte seq darueber hinaus, und
    // das Loch bliebe auch nach dem Wiederverbinden (Nachlieferung ab seq).
    // So verbindet er neu und holt alles nach, was ihm fehlt.
    return trennen(k, typ, entfernen)
  }
  k.sock.send(JSON.stringify({ typ, daten }))
}

/** Eine Live-Nachricht senden -- oder hinter die laufende Nachlieferung stellen. */
export function senden(k: Klient, typ: string, daten: unknown, entfernen: (k: Klient) => void): void {
  if (k.wartend) {
    if (k.wartend.length >= MAX_WARTEND) return trennen(k, typ, entfernen)
    k.wartend.push([typ, daten])
    return
  }
  direktSenden(k, typ, daten, entfernen)
}

export interface NachlieferQuelle {
  /** Ereignisse mit seq > ab, aufsteigend, hoechstens `anzahl`. */
  seite(runId: string, ab: number, anzahl: number): CockpitEvent[]
  /** Was nach den Ereignissen kommt (agenten, freigaben, limit, bereit). */
  abschluss(runId: string | null): Array<[string, unknown]>
}

export interface NachlieferOptionen {
  seitenGroesse?: number
  /** Laenger als so lange ohne Abfluss -> trennen wie bei MAX_RUECKSTAU. */
  maxWartenMs?: number
  pruefAbstandMs?: number
}

/** Wartet, bis der Puffer unter die Schwelle faellt. false: aufgeben. */
async function abfliessen(k: Klient, o: Required<NachlieferOptionen>): Promise<boolean> {
  const bis = Date.now() + o.maxWartenMs
  while (k.sock.readyState === 1 && k.sock.bufferedAmount > NACHLIEFER_SCHWELLE) {
    if (Date.now() > bis) return false
    await new Promise((r) => setTimeout(r, o.pruefAbstandMs))
  }
  return true
}

/**
 * Rueckstand ab `seit` nachliefern, danach den Abschluss, danach alles, was
 * inzwischen live angefallen ist. Kommt waehrenddessen ein neues `folgen`,
 * hoert diese Nachlieferung auf und die neue uebernimmt die Schlange.
 */
export async function nachliefern(
  k: Klient,
  runId: string | null,
  seit: number,
  quelle: NachlieferQuelle,
  entfernen: (k: Klient) => void,
  optionen: NachlieferOptionen = {},
): Promise<void> {
  const o: Required<NachlieferOptionen> = {
    seitenGroesse: 500, maxWartenMs: 60_000, pruefAbstandMs: 50, ...optionen,
  }
  const nr = (k.folgeNr ?? 0) + 1
  k.folgeNr = nr
  k.runId = runId
  k.wartend ??= []
  const ueberholt = () => k.folgeNr !== nr || k.sock.readyState !== 1 || !k.wartend

  try {
    if (runId) {
      let ab = seit
      for (;;) {
        const seite = quelle.seite(runId, ab, o.seitenGroesse)
        for (const e of seite) {
          direktSenden(k, 'ereignis', e, entfernen)
          if (k.sock.bufferedAmount > NACHLIEFER_SCHWELLE) {
            if (!(await abfliessen(k, o))) return trennen(k, 'Nachlieferung', entfernen)
            if (ueberholt()) return
          }
        }
        if (seite.length < o.seitenGroesse) break
        ab = seite[seite.length - 1]!.seq
        // Zwischen zwei Seiten einmal die Ereignisschleife freigeben: ein
        // grosser Rueckstand soll Agenten und andere Klienten nicht anhalten.
        await new Promise((r) => setImmediate(r))
        if (ueberholt()) return
      }
    }
    for (const [typ, daten] of quelle.abschluss(runId)) direktSenden(k, typ, daten, entfernen)
  } catch (e) {
    // Wie im HTTP-Handler: ein Fehler beim Beantworten trifft diesen
    // Klienten, nicht den Daemon.
    console.error('[cockpit] Nachlieferung fehlgeschlagen:', e)
  }
  if (k.folgeNr !== nr) return
  const schlange = k.wartend ?? []
  k.wartend = null
  for (const [typ, daten] of schlange) senden(k, typ, daten, entfernen)
}
