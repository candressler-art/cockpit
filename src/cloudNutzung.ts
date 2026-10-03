// Cloud-Guthaben im Verlauf und die Cloud-Auftraege aus dem Cockpit.
//
// Token je Cloud-Sitzung gibt es nicht abzufragen -- verlaesslich messbar ist
// nur der Dollarstand des Guthabens (kontenNutzung.ts, cloudGuthabenAusAntwort).
// Deshalb hier ein eigener Verlauf in Dollar: je Konto eine Zeile, sobald sich
// "verbraucht" aendert. Der Verbrauch eines Tages ist die Summe der Zuwaechse,
// die an diesem Tag gemessen wurden. Tokens (nutzung.ts) und Dollar werden nie
// vermischt.
//
// Daneben die Auftraege: jede per RemoteTrigger angelegte Cloud-Routine, die
// der Daemon im Nachrichtenstrom eines Chats sieht (cloudAuftrag.ts parst sie),
// und je Konto die zuletzt erfolgreich benutzte environment_id.

import { DatabaseSync } from 'node:sqlite'
import { DB_WARTEN_MS } from './db.js'
import { tagVon, tagVerschieben } from './nutzung.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_verlauf (
  konto      TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  verbraucht REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_verlauf ON cloud_verlauf (konto, ts);
CREATE TABLE IF NOT EXISTS cloud_auftraege (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT,
  konto           TEXT,
  trigger_id      TEXT UNIQUE,
  name            TEXT,
  branch          TEXT,
  repo            TEXT,
  link            TEXT,
  erstellt        INTEGER NOT NULL,
  guthaben_vorher REAL,
  status          TEXT NOT NULL,
  fertig_am       INTEGER,
  kosten          REAL
);
CREATE INDEX IF NOT EXISTS idx_cloud_auftraege_chat ON cloud_auftraege (chat_id);
CREATE TABLE IF NOT EXISTS cloud_umgebungen (
  konto          TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  ts             INTEGER NOT NULL
);
`

/** Bekannte Umgebung des Hauptkontos -- bis ein Start die eigene meldet. */
const UMGEBUNG_VORGABE: Record<string, string> = { haupt: 'env_013es3CJDiadm6B3TVoLMfpu' }

let db: DatabaseSync | null = null
let dbPfadOffen: string | null = null

function handle(pfad: string): DatabaseSync {
  if (!db || dbPfadOffen !== pfad) {
    // Gleiche Datei wie CockpitDb -- gleiches Warten auf fremde Sperren.
    db = new DatabaseSync(pfad, { timeout: DB_WARTEN_MS })
    dbPfadOffen = pfad
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SCHEMA)
  }
  return db
}

// --- Verlauf und Tagesrechnung ---------------------------------------------------

export interface CloudMessung {
  konto: string
  ts: number
  verbraucht: number
}

/**
 * Eine Messung merken -- nur, wenn sich der Stand gegenueber der letzten
 * Zeile dieses Kontos geaendert hat (oder es die erste ist). Sonst stuende
 * alle zehn Minuten dieselbe Zahl da. true, wenn eine Zeile dazukam.
 */
export function cloudMessungMerken(dbPfad: string, konto: string, verbraucht: number, ts = Date.now()): boolean {
  if (!Number.isFinite(verbraucht)) return false
  const h = handle(dbPfad)
  const letzte = h.prepare('SELECT verbraucht FROM cloud_verlauf WHERE konto = ? ORDER BY ts DESC LIMIT 1')
    .get(konto) as { verbraucht: number } | undefined
  // Cent-genau vergleichen: Fliesskomma aus JSON soll keine Scheinaenderung erzeugen.
  if (letzte && Math.round(letzte.verbraucht * 100) === Math.round(verbraucht * 100)) return false
  h.prepare('INSERT INTO cloud_verlauf (konto, ts, verbraucht) VALUES (?,?,?)').run(konto, ts, verbraucht)
  return true
}

export function cloudVerlaufLesen(dbPfad: string): CloudMessung[] {
  return (handle(dbPfad).prepare('SELECT konto, ts, verbraucht FROM cloud_verlauf ORDER BY konto, ts')
    .all() as { konto: string; ts: number; verbraucht: number }[])
    .map((r) => ({ konto: String(r.konto), ts: Number(r.ts), verbraucht: Number(r.verbraucht) }))
}

export interface CloudTag {
  tag: string
  dollar: number
}

export interface CloudTage {
  /** Aufsteigend, nur Tage mit Verbrauch. */
  tage: CloudTag[]
  /** Was vor der jeweils ersten Messung eines Kontos schon verbraucht war, ueber alle Konten. */
  vorAufzeichnung: number
}

const cent = (x: number): number => Math.round(x * 100) / 100

/**
 * Verbrauch je Berliner Tag aus den Messungen. Reine Funktion.
 *
 * Je Konto: die Summe der POSITIVEN Zuwaechse zwischen aufeinanderfolgenden
 * Messungen, dem Tag der spaeteren Messung zugerechnet. Ein Rueckgang (neues
 * Guthaben, Korrektur bei Anthropic) zaehlt nicht negativ, der naechste
 * Zuwachs setzt auf dem neuen Stand auf. Der Stand der ersten Messung ist
 * "vor Aufzeichnung" -- wann er entstand, weiss niemand.
 */
export function cloudTageBerechnen(messungen: CloudMessung[]): CloudTage {
  const jeKonto = new Map<string, CloudMessung[]>()
  for (const m of messungen) {
    if (!Number.isFinite(m.verbraucht) || !Number.isFinite(m.ts)) continue
    const l = jeKonto.get(m.konto) ?? []
    l.push(m)
    jeKonto.set(m.konto, l)
  }
  const nachTag = new Map<string, number>()
  let vorAufzeichnung = 0
  for (const liste of jeKonto.values()) {
    liste.sort((a, b) => a.ts - b.ts)
    vorAufzeichnung += Math.max(0, liste[0]!.verbraucht)
    for (let i = 1; i < liste.length; i++) {
      const zuwachs = liste[i]!.verbraucht - liste[i - 1]!.verbraucht
      if (zuwachs <= 0) continue
      const tag = tagVon(liste[i]!.ts)
      nachTag.set(tag, (nachTag.get(tag) ?? 0) + zuwachs)
    }
  }
  return {
    tage: [...nachTag.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, dollar]) => ({ tag, dollar: cent(dollar) })),
    vorAufzeichnung: cent(vorAufzeichnung),
  }
}

export interface CloudKennzahlen {
  heute: number
  sieben: number
  dreissig: number
  /** Alles seit Beginn der Aufzeichnung (ohne "vor Aufzeichnung"). */
  gesamt: number
}

/** Summen fuer die Kennzahlen, wie kennzahlenBerechnen in nutzung.ts. Reine Funktion. */
export function cloudKennzahlen(tage: CloudTag[], heute: string): CloudKennzahlen {
  const summeAb = (ab: string): number => cent(tage.filter((t) => t.tag >= ab && t.tag <= heute).reduce((s, t) => s + t.dollar, 0))
  return {
    heute: summeAb(heute),
    sieben: summeAb(tagVerschieben(heute, -6)),
    dreissig: summeAb(tagVerschieben(heute, -29)),
    gesamt: cent(tage.reduce((s, t) => s + t.dollar, 0)),
  }
}

// --- Auftraege ---------------------------------------------------------------------

export type CloudStatus = 'gestartet' | 'fertig' | 'unklar'

export interface CloudAuftrag {
  id: string
  chatId: string | null
  konto: string | null
  triggerId: string | null
  name: string | null
  branch: string | null
  repo: string | null
  link: string | null
  erstellt: number
  guthabenVorher: number | null
  status: CloudStatus
  fertigAm: number | null
  /** Ungefaehre Kosten (Guthaben nachher minus vorher), erst wenn fertig. */
  kosten: number | null
}

function auftragAusZeile(r: Record<string, unknown>): CloudAuftrag {
  const t = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
  return {
    id: String(r.id),
    chatId: t(r.chat_id),
    konto: t(r.konto),
    triggerId: t(r.trigger_id),
    name: t(r.name),
    branch: t(r.branch),
    repo: t(r.repo),
    link: t(r.link),
    erstellt: Number(r.erstellt),
    guthabenVorher: n(r.guthaben_vorher),
    status: String(r.status) as CloudStatus,
    fertigAm: n(r.fertig_am),
    kosten: n(r.kosten),
  }
}

/** Neu anlegen oder (gleiche id) ergaenzen -- was schon steht, bleibt, wo nichts Neues kommt. */
export function auftragSpeichern(dbPfad: string, a: CloudAuftrag): void {
  handle(dbPfad).prepare(
    `INSERT INTO cloud_auftraege (id, chat_id, konto, trigger_id, name, branch, repo, link, erstellt, guthaben_vorher, status, fertig_am, kosten)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET
       chat_id = COALESCE(excluded.chat_id, chat_id), konto = COALESCE(excluded.konto, konto),
       trigger_id = COALESCE(excluded.trigger_id, trigger_id), name = COALESCE(excluded.name, name),
       branch = COALESCE(excluded.branch, branch), repo = COALESCE(excluded.repo, repo),
       link = COALESCE(excluded.link, link), guthaben_vorher = COALESCE(excluded.guthaben_vorher, guthaben_vorher),
       status = excluded.status, fertig_am = COALESCE(excluded.fertig_am, fertig_am),
       kosten = COALESCE(excluded.kosten, kosten)`,
  ).run(a.id, a.chatId, a.konto, a.triggerId, a.name, a.branch, a.repo, a.link, a.erstellt,
    a.guthabenVorher, a.status, a.fertigAm, a.kosten)
}

export function auftragLesen(dbPfad: string, id: string): CloudAuftrag | null {
  const r = handle(dbPfad).prepare('SELECT * FROM cloud_auftraege WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? auftragAusZeile(r) : null
}

export function auftragZuTrigger(dbPfad: string, triggerId: string): CloudAuftrag | null {
  const r = handle(dbPfad).prepare('SELECT * FROM cloud_auftraege WHERE trigger_id = ?').get(triggerId) as Record<string, unknown> | undefined
  return r ? auftragAusZeile(r) : null
}

/** Neueste zuerst; optional nur die eines Chats. */
export function auftraegeLesen(dbPfad: string, o: { chatId?: string; status?: CloudStatus; grenze?: number } = {}): CloudAuftrag[] {
  const wo: string[] = []
  const werte: string[] = []
  if (o.chatId) { wo.push('chat_id = ?'); werte.push(o.chatId) }
  if (o.status) { wo.push('status = ?'); werte.push(o.status) }
  return (handle(dbPfad).prepare(
    `SELECT * FROM cloud_auftraege ${wo.length ? `WHERE ${wo.join(' AND ')}` : ''} ORDER BY erstellt DESC LIMIT ${Math.max(1, Math.min(o.grenze ?? 200, 1000))}`,
  ).all(...werte) as Record<string, unknown>[]).map(auftragAusZeile)
}

/** Die Auftraege, die an einem Berliner Tag angelegt wurden (Tagesdetail im Bereich Nutzung). */
export function auftraegeAmTag(alle: CloudAuftrag[], tag: string): CloudAuftrag[] {
  return alle.filter((a) => tagVon(a.erstellt) === tag)
}

// --- Umgebungen je Konto -----------------------------------------------------------

export function umgebungMerken(dbPfad: string, konto: string, environmentId: string, ts = Date.now()): void {
  handle(dbPfad).prepare(
    `INSERT INTO cloud_umgebungen (konto, environment_id, ts) VALUES (?,?,?)
     ON CONFLICT (konto) DO UPDATE SET environment_id = excluded.environment_id, ts = excluded.ts`,
  ).run(konto, environmentId, ts)
}

/** Gemerkte environment_id eines Kontos, sonst die Vorgabe, sonst null. */
export function umgebungLesen(dbPfad: string, konto: string): string | null {
  const r = handle(dbPfad).prepare('SELECT environment_id FROM cloud_umgebungen WHERE konto = ?').get(konto) as
    { environment_id: string } | undefined
  return r ? String(r.environment_id) : UMGEBUNG_VORGABE[konto] ?? null
}
