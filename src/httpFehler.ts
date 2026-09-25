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
 *
 * Gueltiges JSON, das kein Objekt ist (`[1,2]`, `"text"`, `5`), ebenfalls
 * 400: alle Routen lesen Felder daraus, und `k?.name` auf einem Array ist
 * schlicht undefined. POST /api/konten hob so still den Kontovorzug auf
 * (fehlender Name heisst dort "Vorzug aufheben") und antwortete ok.
 * Ein JSON-`null` zaehlt wie ein leerer Koerper.
 */
export function koerperAuswerten(roh: Buffer | null, zuGross: boolean, maxBytes: number): unknown {
  if (zuGross) {
    throw new AnfrageFehler(413, `Anfrage zu gross (hoechstens ${Math.round(maxBytes / 1024)} KB)`)
  }
  const text = roh ? roh.toString('utf-8') : ''
  if (!text.trim()) return null
  let wert: unknown
  try {
    wert = JSON.parse(text)
  } catch {
    throw new AnfrageFehler(400, 'Anfragekoerper ist kein gueltiges JSON')
  }
  if (wert !== null && (typeof wert !== 'object' || Array.isArray(wert))) {
    throw new AnfrageFehler(400, 'Anfragekoerper muss ein JSON-Objekt sein')
  }
  return wert
}

/**
 * Ein Textfeld aus dem Anfragekoerper. Fehlt es (undefined/null), kommt
 * undefined zurueck -- den Standard setzt der Aufrufer. Zahlen und
 * Wahrheitswerte werden wie bisher zu Text; ein Objekt oder Array dagegen
 * wirft AnfrageFehler 400. Frueher wurde daraus per String() still
 * "[object Object]" -- /api/lauf startete damit einen echten Agenten auf
 * Kosten des Kontingents, mit genau diesem Prompt.
 */
export function textFeld(k: Record<string, unknown> | null, name: string): string | undefined {
  const w = k?.[name]
  if (w === undefined || w === null) return undefined
  if (typeof w === 'object') throw new AnfrageFehler(400, `${name} muss Text sein`)
  return String(w)
}
