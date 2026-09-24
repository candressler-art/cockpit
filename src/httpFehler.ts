// HTTP-Statuscode fuer eine Ausnahme aus dem Anfrage-Handler in daemon.ts.
//
// Steht in einer eigenen Datei, weil daemon.ts beim Import den Server startet
// und sich deshalb nicht direkt testen laesst. Grundsatz: 500 nur, wenn
// wirklich der Daemon versagt hat -- eine krumme Anfrage ist Sache des
// Aufrufers und bekommt einen 4xx-Code, sonst sieht jeder Tippfehler in
// einer URL im Log aus wie ein Fehler im Code.

/** Statuscode fuer einen im Anfrage-Handler gefangenen Fehler. */
export function fehlerStatus(e: unknown): number {
  // decodeURIComponent auf kaputter Prozent-Kodierung (z. B. '/api/chats/%E0')
  if (e instanceof URIError) return 400
  const code = (e as { code?: string } | null)?.code
  // Statische Oberflaeche: fehlende Datei, Verzeichnis statt Datei ('/tabs')
  // oder Datei als Verzeichnis benutzt ('/index.html/x') -- alles "gibt es nicht".
  if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return 404
  return 500
}
