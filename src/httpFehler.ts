// HTTP-Statuscode fuer eine Ausnahme aus dem Anfrage-Handler in daemon.ts.
//
// Steht in einer eigenen Datei, weil daemon.ts beim Import den Server startet
// und sich deshalb nicht direkt testen laesst. Grundsatz: 500 nur, wenn
// wirklich der Daemon versagt hat -- eine krumme Anfrage ist Sache des
// Aufrufers und bekommt einen 4xx-Code, sonst sieht jeder Tippfehler in
// einer URL im Log aus wie ein Fehler im Code.

/** Statuscode fuer einen im Anfrage-Handler gefangenen Fehler. */
export function fehlerStatus(e: unknown): number {
  if (e instanceof AnfrageFehler) return e.status
  // decodeURIComponent auf kaputter Prozent-Kodierung (z. B. '/api/chats/%E0')
  if (e instanceof URIError) return 400
  const code = (e as { code?: string } | null)?.code
  // Statische Oberflaeche: fehlende Datei, Verzeichnis statt Datei ('/tabs')
  // oder Datei als Verzeichnis benutzt ('/index.html/x') -- alles "gibt es nicht".
  if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return 404
  return 500
}

/**
 * Fehler in der Anfrage selbst, mit fertigem Status und lesbarer Meldung.
 *
 * Gedacht fuer den Anfragekoerper: frueher kam ein zu grosser oder kaputter
 * Koerper als `null` zurueck, und /api/lauf antwortete darauf "prompt fehlt"
 * -- obwohl der Prompt da war, nur zu lang oder kein JSON. Wer das liest,
 * sucht den Fehler an der falschen Stelle.
 */
export class AnfrageFehler extends Error {
  constructor(readonly status: number, meldung: string) {
    super(meldung)
    this.name = 'AnfrageFehler'
  }
}

/**
 * Gelesenen Anfragekoerper als JSON auswerten.
 *
 * Leer (auch nur Leerraum) bleibt `null` wie bisher -- einige Routen kommen
 * ohne Koerper aus. Zu gross -> 413, kein gueltiges JSON -> 400.
 */
export function koerperAuswerten(roh: Buffer | null, zuGross: boolean, maxBytes: number): unknown {
  if (zuGross) {
    throw new AnfrageFehler(413, `Anfrage zu gross (hoechstens ${Math.round(maxBytes / 1024)} KB)`)
  }
  const text = roh ? roh.toString('utf-8') : ''
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new AnfrageFehler(400, 'Anfragekoerper ist kein gueltiges JSON')
  }
}
