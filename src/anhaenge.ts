// Dateien und Bilder, die man in den Chat zieht.
//
// Die SDK bekommt den Prompt als Text (supervisor.ts baut ihn bei einem
// Kontowechsel neu zusammen), deshalb gehen Anhaenge nicht als Bild-Bloecke
// mit, sondern als Datei im Anhang-Ordner des Daemons: der Prompt nennt die
// Pfade, der Agent sieht sie sich mit Read an (Read kann Bilder, PDFs und
// Text). Lesen dort ist ohne Freigabe erlaubt (daemon.ts, autoErlauben),
// alles andere laeuft wie immer ueber den Freigabe-Broker.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { aufgeloest, innerhalbVon } from './vaultZugriff.js'

/** Groesste Datei je Anhang. Read verkleinert Bilder selbst; PDFs bis 20 MB reichen. */
export const MAX_ANHANG_BYTES = 20 * 1024 * 1024
/** Hoechstens so viele Anhaenge je Nachricht. */
export const MAX_ANHAENGE = 10
/** Nach so vielen Tagen raeumt der Daemon alte Anhaenge weg. */
export const ANHANG_TAGE = 30
/** Ueberschrift des Anhang-Blocks im Prompt; die Oberflaeche erkennt ihn daran wieder. */
export const ANHANG_KOPF = 'Angehängte Dateien (mit Read ansehen):'

/** Dateiname ohne Pfad und ohne Zeichen, die in einem Prompt oder einer Shell stoeren. */
export function anhangName(name: string): string {
  const roh = basename(String(name ?? '').replace(/\\/g, '/'))
  const sauber = roh
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+/, '')
    .slice(-80)
  return sauber || 'anhang'
}

export interface Anhang {
  pfad: string
  name: string
  groesse: number
}

/** Ablegen unter `<wurzel>/<Datum>/<zufall>-<name>`; das Datum dient dem Aufraeumen. */
export function anhangSpeichern(wurzel: string, name: string, daten: Buffer, jetzt = new Date()): Anhang {
  const tag = jetzt.toISOString().slice(0, 10)
  const ordner = join(wurzel, tag)
  mkdirSync(ordner, { recursive: true, mode: 0o700 })
  const n = anhangName(name)
  const pfad = join(ordner, `${randomBytes(4).toString('hex')}-${n}`)
  writeFileSync(pfad, daten, { mode: 0o600, flag: 'wx' })
  return { pfad, name: n, groesse: daten.length }
}

/**
 * Die Pfade aus einer Chat-Anfrage pruefen: nur Dateien, die wirklich im
 * Anhang-Ordner liegen (nach realpath -- kein Symlink, kein `..` hinaus).
 * Sonst koennte eine Anfrage beliebige Dateien als "Anhang" unterschieben,
 * die der Agent dann ohne Freigabe liest.
 */
export function anhaengePruefen(wurzel: string, pfade: unknown): { fehler: string } | { pfade: string[] } {
  if (pfade === undefined || pfade === null) return { pfade: [] }
  if (!Array.isArray(pfade) || pfade.some((p) => typeof p !== 'string' || !p)) {
    return { fehler: 'anhaenge muss eine Liste von Pfaden sein' }
  }
  if (pfade.length > MAX_ANHAENGE) return { fehler: `hoechstens ${MAX_ANHAENGE} Anhaenge je Nachricht` }
  const w = aufgeloest(wurzel)
  const ergebnis: string[] = []
  for (const p of pfade as string[]) {
    const a = aufgeloest(p)
    let datei = false
    try { datei = statSync(a).isFile() } catch { /* fehlt */ }
    if (a === w || !innerhalbVon(a, w) || !datei) return { fehler: `Anhang unbekannt: ${basename(p)}` }
    if (!ergebnis.includes(a)) ergebnis.push(a)
  }
  return { pfade: ergebnis }
}

/** Den Prompt um den Anhang-Block ergaenzen (ohne Anhaenge unveraendert). */
export function promptMitAnhaengen(text: string, pfade: string[]): string {
  if (!pfade.length) return text
  return `${text}\n\n${ANHANG_KOPF}\n${pfade.map((p) => `- ${p}`).join('\n')}`
}

/** Tagesordner, die aelter als `tage` sind, entfernen. Gibt die Zahl der entfernten Ordner zurueck. */
export function alteAnhaengeLoeschen(wurzel: string, tage = ANHANG_TAGE, jetzt = new Date()): number {
  let eintraege: string[]
  try { eintraege = readdirSync(wurzel) } catch { return 0 }
  const grenze = new Date(jetzt.getTime() - tage * 86_400_000).toISOString().slice(0, 10)
  let entfernt = 0
  for (const e of eintraege) {
    // Nur eigene Tagesordner anfassen, sonst nichts in diesem Verzeichnis.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e) || e >= grenze) continue
    rmSync(join(wurzel, e), { recursive: true, force: true })
    entfernt++
  }
  return entfernt
}
