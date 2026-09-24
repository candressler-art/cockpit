// Pruefung von Zahlen und Verzeichnissen aus API-Anfragen.
//
// Steht in einer eigenen Datei, weil daemon.ts beim Import den Server startet
// und sich deshalb nicht direkt testen laesst. Grundsatz wie in httpFehler.ts:
// eine krumme Anfrage bekommt sofort ein 400 mit Klartext, statt einen Lauf
// anzulegen, der dann mit einer irrefuehrenden Meldung scheitert oder -- bei
// NaN -- still gar nichts tut.

import { statSync } from 'node:fs'

/**
 * Prueft ein Arbeitsverzeichnis, bevor ein Lauf oder eine Freigabe angelegt
 * wird. Frueher reichte existsSync: ein vertipptes Verzeichnis liess den
 * Agenten dann mit "native binary ... failed to launch" scheitern (die
 * SDK-Meldung fuer JEDEN Startfehler), und eine Datei statt eines
 * Verzeichnisses kam durch.
 */
export function cwdPruefen(cwd: string): string | null {
  if (!cwd) return 'cwd fehlt'
  if (!cwd.startsWith('/')) return 'cwd muss ein absoluter Pfad sein'
  let st
  try {
    st = statSync(cwd)
  } catch {
    return `${cwd} gibt es auf diesem Host nicht`
  }
  if (!st.isDirectory()) return `${cwd} ist kein Verzeichnis`
  return null
}

/**
 * Optionale Zahl aus einem Anfragekoerper. Fehlt sie (undefined, null, ''),
 * gilt der Standard des Aufrufers (zahl bleibt undefined). Sonst muss sie
 * endlich und mindestens `min` sein, bei ganzzahlig=true auch ganz.
 *
 * Ohne diese Pruefung wurde aus "maxRunden": "abc" ein NaN, und
 * `runde < NaN` ist nie wahr: der Lauf endete sofort als "fertig", ohne dass
 * ein Agent gearbeitet hatte. Ein NaN-tokenBudget schaltete die Grenze still ab.
 */
export function zahlLesen(
  wert: unknown,
  name: string,
  o: { min: number; ganzzahlig?: boolean },
): { zahl?: number; fehler?: string } {
  if (wert === undefined || wert === null || wert === '') return {}
  const n = typeof wert === 'number' ? wert : typeof wert === 'string' ? Number(wert.trim()) : NaN
  if (!Number.isFinite(n)) return { fehler: `${name} muss eine Zahl sein` }
  if (o.ganzzahlig && !Number.isInteger(n)) return { fehler: `${name} muss eine ganze Zahl sein` }
  if (n < o.min) return { fehler: `${name} muss mindestens ${o.min} sein` }
  return { zahl: n }
}
