// Push-Benachrichtigungen ans Handy/Tablet, auch wenn das Cockpit dort gerade
// nicht offen ist.
//
// Die Benachrichtigungen in web/benachrichtigen.js zeigt die Seite selbst --
// die gibt es nur, solange sie laeuft. Ein gesperrtes Handy oder eine
// geschlossene App bekommt davon nichts mit, und genau dann wartet meist eine
// Freigabe. Web Push geht ueber den Push-Dienst des Browsers (Google, Apple,
// Mozilla) und weckt den Service Worker (web/sw.js), der die Meldung zeigt.
//
// Was gemeldet wird, entscheidet DIESELBE Regel wie im Browser
// (web/ui/meldungen.js, ohne DOM) -- mit demselben `tag`. Zeigt die offene
// Seite eine Meldung und kommt dieselbe als Push, ersetzt die zweite die
// erste statt doppelt zu erscheinen.
//
// Schluessel (VAPID) entstehen beim ersten Start und liegen neben der
// Datenbank (vapid.json, 0600). Abos in der Tabelle push_abos; ein Abo, das
// der Push-Dienst als erloschen meldet (404/410), wird geloescht.

import webpush from 'web-push'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface Meldung {
  titel: string
  text: string
  ziel: string
  tag: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_abos (
  endpoint TEXT PRIMARY KEY,
  abo      TEXT NOT NULL,
  erstellt INTEGER NOT NULL
);
`

let db: DatabaseSync | null = null
let oeffentlich = ''

/** Schluessel laden oder anlegen und die Abo-Tabelle bereitstellen. Gibt den oeffentlichen Schluessel zurueck. */
export function pushStarten(dbPfad: string): string {
  const datei = join(dirname(dbPfad), 'vapid.json')
  let s: { publicKey: string; privateKey: string }
  if (existsSync(datei)) {
    s = JSON.parse(readFileSync(datei, 'utf-8')) as { publicKey: string; privateKey: string }
  } else {
    s = webpush.generateVAPIDKeys()
    writeFileSync(datei, JSON.stringify(s), { mode: 0o600 })
  }
  // Der Kontakt ist Pflicht im VAPID-Kopf; der Push-Dienst meldet sich dort
  // nur bei Missbrauch. Kein echtes Postfach noetig.
  webpush.setVapidDetails('mailto:cockpit@localhost', s.publicKey, s.privateKey)
  oeffentlich = s.publicKey
  db = new DatabaseSync(dbPfad)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return oeffentlich
}

export const pushSchluessel = (): string => oeffentlich

/** Ist das ein Abo, wie PushSubscription.toJSON() es liefert? Nur https-Endpunkte. */
export function aboGueltig(a: unknown): a is { endpoint: string; keys: { p256dh: string; auth: string } } {
  const o = a as Record<string, unknown> | null
  const k = o?.keys as Record<string, unknown> | undefined
  return typeof o?.endpoint === 'string' && o.endpoint.startsWith('https://') && o.endpoint.length < 2000 &&
    typeof k?.p256dh === 'string' && typeof k?.auth === 'string'
}

export function aboSpeichern(abo: { endpoint: string }): void {
  db?.prepare(
    'INSERT INTO push_abos (endpoint, abo, erstellt) VALUES (?,?,?) ON CONFLICT (endpoint) DO UPDATE SET abo = excluded.abo',
  ).run(abo.endpoint, JSON.stringify(abo), Date.now())
}

export function aboLoeschen(endpoint: string): void {
  db?.prepare('DELETE FROM push_abos WHERE endpoint = ?').run(endpoint)
}

export function aboAnzahl(): number {
  return Number((db?.prepare('SELECT COUNT(*) AS n FROM push_abos').get() as { n: number } | undefined)?.n ?? 0)
}

/** An alle Geraete senden. Fehler einzelner Abos reissen die anderen nicht mit. */
export async function pushSenden(m: Meldung): Promise<void> {
  if (!db) return
  const abos = db.prepare('SELECT endpoint, abo FROM push_abos').all() as { endpoint: string; abo: string }[]
  await Promise.all(abos.map(async ({ endpoint, abo }) => {
    try {
      // Hohe Dringlichkeit: eine Freigabe haelt einen Agenten an. TTL eine
      // Stunde -- wer spaeter aufs Handy schaut, sieht die Meldung noch.
      await webpush.sendNotification(JSON.parse(abo), JSON.stringify(m), { TTL: 3600, urgency: 'high' })
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) aboLoeschen(endpoint)
      else console.warn(`[push] Senden fehlgeschlagen (${code ?? '?'}):`, String((e as Error).message ?? e).slice(0, 200))
    }
  }))
}
