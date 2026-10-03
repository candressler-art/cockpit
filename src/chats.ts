// Verzeichnis der Claude-Code-Sessions.
//
// Die Sessions liegen als NDJSON unter dem Syncthing-Spiegel: je Zeile ein
// Ereignis, je Datei eine Sitzung. Das sind rund 285 Dateien und 185 MB --
// zu viel, um sie bei jeder Anfrage zu lesen. Deshalb ein Index in SQLite,
// der nur beim ersten Mal und bei Aenderungen gebaut wird.
//
// Eigene Verbindung zur selben Datei statt einer Erweiterung von CockpitDb:
// der Index ist abgeleiteter Zustand, der sich jederzeit neu bauen laesst,
// und gehoert damit nicht in dieselbe Klasse wie die Laufdaten, die es nur
// einmal gibt. SQLite im WAL-Modus vertraegt mehrere Verbindungen im selben
// Prozess.

import { DatabaseSync } from 'node:sqlite'
import { readdir, readFile, stat, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import { aufwandGueltig, berechtigungGueltig, modellGueltig } from './einstellungen.js'
import { verlaufNormalisieren, type Nachricht } from './nachrichten.js'
import { DB_WARTEN_MS } from './db.js'
import { ANHANG_KOPF } from './anhaenge.js'
import { VARIANTE } from './variante.js'

const SPIEGEL = process.env.COCKPIT_SESSIONS ?? '/var/lib/cockpit/sessions-desktop'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  session_id TEXT PRIMARY KEY,
  pfad       TEXT NOT NULL,
  titel      TEXT NOT NULL,
  cwd        TEXT,
  projekt    TEXT,
  started_at INTEGER,
  ended_at   INTEGER,
  zuege      INTEGER NOT NULL DEFAULT 0,
  git_branch TEXT,
  groesse    INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL DEFAULT 0,
  -- 'desktop' (Syncthing-Spiegel) oder 'server' (projects/ dieses Hosts)
  quelle     TEXT NOT NULL DEFAULT 'desktop',
  -- Wer die Sitzung angelegt hat: claude-desktop/cli (ein Mensch),
  -- sdk-ts (Cockpit-Agent), sdk-cli (claude -p, z.B. der Nachtschicht-Loop)
  entrypoint TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_zeit ON chats (started_at DESC);
-- Durchsucht werden Titel und die EIGENEN Eingaben, nicht die Antworten.
-- Wer eine alte Sitzung sucht, erinnert sich an das, was er getippt hat.
-- Die Antworten mitzuindizieren waere ein Vielfaches an Platz fuer Treffer,
-- die man ohnehin nicht wiedererkennt.
CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
  session_id UNINDEXED, titel, eingaben, tokenize='unicode61'
);
-- Welche Sitzung wird gerade auf DIESEM Host fortgeschrieben. lauf_id ist
-- der Pseudo-Lauf (wie KONSOLE_LAUF -- keine Zeile in runs),
-- aktuelle_session die jeweils NEUESTE Session-Id nach einem Resume (die SDK
-- vergibt bei jedem Zug eine neue). cwd steht fest, sobald das erste Mal
-- weitergeschrieben wurde, und bleibt es -- ein Wechsel des Zielverzeichnisses
-- mitten in einer fortgesetzten Sitzung waere kein Fortsetzen mehr.
CREATE TABLE IF NOT EXISTS chat_fortsetzung (
  session_id       TEXT PRIMARY KEY,
  lauf_id          TEXT NOT NULL,
  aktuelle_session TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  geaendert        INTEGER NOT NULL
);
-- Nachrichten, die Can schreibt, waehrend Claude noch arbeitet. Sie gehen
-- gesammelt als naechster Zug raus, sobald der laufende fertig ist (daemon.ts,
-- warteschlangeAbarbeiten; Regeln in warteschlange.ts). gehalten: nach
-- "Anhalten", Limit oder Neustart -- dann erst auf Cans "Jetzt senden".
-- Kein abgeleiteter Zustand: ueberlebt Neustart und Neubau des Index.
CREATE TABLE IF NOT EXISTS chat_warteschlange (
  nr         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  text       TEXT NOT NULL,
  anhaenge   TEXT NOT NULL DEFAULT '[]',
  optionen   TEXT NOT NULL DEFAULT '{}',
  erstellt   INTEGER NOT NULL,
  gehalten   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_warteschlange ON chat_warteschlange (session_id, nr);
-- Was man im Cockpit an einem Chat einstellt: eigener Titel, angeheftet,
-- aus der Liste genommen. Kein abgeleiteter Zustand (ueberlebt den Neubau
-- des Index), und nie eine Aenderung an der Sitzungsdatei -- die gehoert
-- dem Desktop bzw. der CLI. ausgeblendet ist ein Zeitpunkt: neuere
-- Aktivitaet im Chat holt ihn wieder in die Liste.
CREATE TABLE IF NOT EXISTS chat_markierung (
  session_id   TEXT PRIMARY KEY,
  titel        TEXT,
  angeheftet   INTEGER NOT NULL DEFAULT 0,
  ausgeblendet INTEGER
);
-- Modell, Denkaufwand und Berechtigungsmodus des letzten Zugs. Die Auswahl
-- im Eingabefeld lebt sonst nur im Browser: nach Neuladen, Daemon-Neustart
-- oder am anderen Geraet fiel ein Chat auf die Vorgabe zurueck, und aus
-- "Alles erlauben" wurde mitten im Chat wieder "Nachfragen".
CREATE TABLE IF NOT EXISTS chat_optionen (
  session_id   TEXT PRIMARY KEY,
  modell       TEXT,
  aufwand      TEXT,
  berechtigung TEXT,
  geaendert    INTEGER NOT NULL
);
`

/**
 * Wo die Claude-Code-CLI auf DIESEM Host ihre Sitzungen ablegt -- derselbe
 * Ort, unter dem ein `claude` im Arbeitsverzeichnis `cwd` seine Session-Datei
 * anlegen wuerde. Ein fortgesetzter Chat schreibt genau dorthin, damit die
 * CLI (falls jemand die Sitzung auch mal per Hand oeffnet) dieselbe Datei
 * sieht wie das Cockpit.
 */
function projekteVerzeichnis(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
}

/** Kodiert einen Pfad wie die CLI: jedes Zeichen ausserhalb [a-zA-Z0-9] wird '-'. */
function projektSchluessel(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface ChatKopf {
  sessionId: string
  titel: string
  cwd: string | null
  projekt: string | null
  startedAt: number | null
  endedAt: number | null
  zuege: number
  gitBranch: string | null
  groesse: number
  /** Wo die Sitzung entstand: am Desktop (Spiegel) oder auf diesem Server. */
  quelle: 'desktop' | 'server'
  /** claude-desktop / cli / sdk-ts / sdk-cli, oder null bei alten Dateien. */
  entrypoint: string | null
  /** Im Cockpit angeheftet: steht oben in der Liste. */
  angeheftet?: boolean
  /** Ob das Arbeitsverzeichnis auf DIESEM Host existiert -- nur dann ist
   *  ein echtes Fortsetzen moeglich. */
  fortsetzbar?: boolean
}

let db: DatabaseSync | null = null

/**
 * Stand des Index-Schemas. Der Index ist abgeleiteter Zustand -- statt
 * Spalten nachzuruesten, wird er bei einem Sprung einfach neu gebaut
 * (chats und chats_fts; chat_fortsetzung ist KEIN abgeleiteter Zustand und
 * bleibt unangetastet). 4: Titel aus Markdown-Ueberschrift (titelAusEingabe).
 */
const INDEX_VERSION = 4

function handle(pfad: string): DatabaseSync {
  if (!db) {
    // Gleiche Datei wie CockpitDb -- gleiches Warten auf fremde Sperren.
    db = new DatabaseSync(pfad, { timeout: DB_WARTEN_MS })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS chats_meta (version INTEGER NOT NULL)')
    const v = (db.prepare('SELECT version FROM chats_meta LIMIT 1').get() as { version: number } | undefined)?.version ?? 0
    if (v < INDEX_VERSION) {
      db.exec('DROP TABLE IF EXISTS chats; DROP TABLE IF EXISTS chats_fts;')
      db.exec('DELETE FROM chats_meta')
      db.prepare('INSERT INTO chats_meta (version) VALUES (?)').run(INDEX_VERSION)
    }
    db.exec(SCHEMA)
  }
  return db
}

function textAus(inhalt: unknown): string {
  if (typeof inhalt === 'string') return inhalt
  if (Array.isArray(inhalt)) {
    return inhalt
      .map((t) => (t && typeof t === 'object' && 'text' in t ? String((t as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

interface Gelesen {
  kopf: ChatKopf
  eingaben: string
}

/**
 * Eine Sitzungsdatei auswerten.
 *
 * Defensiv gegen kaputte Zeilen: eine einzelne unlesbare Zeile darf nicht die
 * ganze Sitzung aus dem Index werfen. Bei 285 Dateien aus verschiedenen
 * CLI-Versionen ist das kein theoretischer Fall.
 */
/**
 * Titel aus der ersten Eingabe, wenn die CLI keinen vergeben hat. Lange
 * Auftraege beginnen oft mit einer Markdown-Ueberschrift -- "# Umbau..."
 * sah in der Chatliste roh aus. Nur Zeichen am ANFANG fallen weg, "#1"
 * mitten im Satz bleibt.
 */
export function titelAusEingabe(eingabe: string): string {
  // Der Anhang-Block (Pfade der angehaengten Dateien) gehoert nicht in den Titel.
  let text = eingabe.split(`\n\n${ANHANG_KOPF}`)[0] ?? ''
  // Beginnt die Eingabe mit einer Markdown-Ueberschrift (ein Auftrag wie
  // "# Umbau-Schicht: ..."), ist die Ueberschrift der Titel -- nicht die
  // ersten 70 Zeichen aus Ueberschrift und erstem Absatz zusammengeklebt.
  const ersteZeile = text.trimStart().split('\n')[0] ?? ''
  if (/^#{1,6}\s+\S/.test(ersteZeile)) text = ersteZeile
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:#{1,6}|>|[-*+]|\d+[.)])(?:\s+|$))+/, '')
    .trim()
    .slice(0, 70)
}

function auswerten(
  sessionId: string, pfad: string, roh: string, groesse: number, quelle: 'desktop' | 'server',
): Gelesen {
  let entrypoint: string | null = null
  let aiTitel: string | null = null
  let eigenerTitel: string | null = null
  let ersteEingabe: string | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null
  let von: number | null = null
  let bis: number | null = null
  let zuege = 0
  const eingaben: string[] = []

  for (const zeile of roh.split('\n')) {
    if (!zeile) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(zeile) as Record<string, unknown>
    } catch {
      continue
    }
    const typ = String(d.type ?? '')

    if (!entrypoint && typeof d.entrypoint === 'string') entrypoint = d.entrypoint
    if (typ === 'ai-title' && d.aiTitle) aiTitel = String(d.aiTitle)
    else if (typ === 'custom-title' && d.customTitle) eigenerTitel = String(d.customTitle)

    if (typ === 'user' || typ === 'assistant') {
      zuege++
      const ts = d.timestamp ? Date.parse(String(d.timestamp)) : NaN
      if (!Number.isNaN(ts)) {
        if (von === null || ts < von) von = ts
        if (bis === null || ts > bis) bis = ts
      }
      if (!cwd && d.cwd) cwd = String(d.cwd)
      if (!gitBranch && d.gitBranch) gitBranch = String(d.gitBranch)
      if (typ === 'user') {
        const m = d.message as { content?: unknown } | undefined
        const t = textAus(m?.content).trim()
        // Befehlsrahmen der CLI wegwerfen -- sie stehen in fast jeder
        // Sitzung und wuerden jede Suche mit Treffern zumuellen.
        if (t && !t.startsWith('<command-')) {
          eingaben.push(t.slice(0, 2000))
          if (!ersteEingabe) ersteEingabe = t
        }
      }
    }
  }

  const titel =
    eigenerTitel ??
    aiTitel ??
    ((ersteEingabe && titelAusEingabe(ersteEingabe)) || `Sitzung ${sessionId.slice(0, 8)}`)

  // Projektname aus dem Verzeichnisnamen: die CLI kodiert den Pfad dort mit
  // Bindestrichen. Besser als nichts, und der volle cwd steht daneben.
  const ordner = pfad.split('/').slice(-2)[0] ?? ''
  const projekt = cwd ? (cwd.split('/').pop() ?? null) : ordner.replace(/^-/, '').split('-').pop() ?? null

  return {
    kopf: {
      sessionId, titel, cwd, projekt,
      startedAt: von, endedAt: bis, zuege, gitBranch, groesse, quelle, entrypoint,
    },
    eingaben: eingaben.join('\n'),
  }
}

/**
 * Wo Sitzungsdateien liegen: der Syncthing-Spiegel des Desktops und das
 * projects/ dieses Hosts (dort landen alle Chats, die im Cockpit selbst
 * entstehen oder fortgesetzt werden). Vorher kannte der Index nur den
 * Spiegel -- ein im Cockpit begonnener Chat tauchte in der Liste nie auf.
 */
function quellen(): { pfad: string; quelle: 'desktop' | 'server' }[] {
  return [
    // Eine Variante (z.B. das Roblox-Cockpit) sieht die Desktop-Sessions nicht.
    ...(VARIANTE.sessionSpiegel ? [{ pfad: SPIEGEL, quelle: 'desktop' as const }] : []),
    { pfad: projekteVerzeichnis(), quelle: 'server' },
  ]
}

interface Kandidat {
  pfad: string
  quelle: 'desktop' | 'server'
  groesse: number
  mtime: number
}

/**
 * Alle Sitzungsdateien, eine je Sitzung. Dieselbe Sitzung kann in beiden
 * Quellen liegen: eine fortgesetzte Desktop-Sitzung ist eine KOPIE im
 * projects/ dieses Hosts. Gewonnen hat die zuletzt geaenderte Datei (sie
 * traegt die neuen Zuege); die Herkunft bleibt 'desktop', wenn der Spiegel
 * sie kennt -- dort ist sie entstanden.
 */
async function kandidatenSammeln(): Promise<Map<string, Kandidat>> {
  const je = new Map<string, Kandidat>()
  let lesbar = 0
  for (const q of quellen()) {
    let projekte: string[]
    try {
      projekte = await readdir(q.pfad)
      lesbar++
    } catch {
      continue
    }
    for (const p of projekte) {
      let dateien: string[]
      try {
        dateien = (await readdir(join(q.pfad, p))).filter((d) => d.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const d of dateien) {
        const voll = join(q.pfad, p, d)
        let st
        try {
          st = await stat(voll)
        } catch {
          continue
        }
        const id = d.replace(/\.jsonl$/, '')
        const k: Kandidat = { pfad: voll, quelle: q.quelle, groesse: st.size, mtime: Math.round(st.mtimeMs) }
        const alt = je.get(id)
        if (!alt) {
          je.set(id, k)
          continue
        }
        const neuer = k.mtime > alt.mtime ? k : alt
        je.set(id, { ...neuer, quelle: alt.quelle === 'desktop' || k.quelle === 'desktop' ? 'desktop' : 'server' })
      }
    }
  }
  if (lesbar === 0) console.warn(`[chats] ${quellen().map((q) => q.pfad).join(' und ')} nicht lesbar -- Index bleibt leer`)
  return je
}

/** Baut den Index auf. Unveraenderte Dateien werden uebersprungen. */
export async function chatsIndizieren(dbPfad: string): Promise<{ gesamt: number; neu: number }> {
  const h = handle(dbPfad)
  let neu = 0

  const bekannt = new Map<string, { pfad: string; groesse: number; mtime: number }>()
  for (const r of h.prepare('SELECT session_id, pfad, groesse, mtime FROM chats').all() as {
    session_id: string; pfad: string; groesse: number; mtime: number
  }[]) {
    bekannt.set(r.session_id, { pfad: r.pfad, groesse: r.groesse, mtime: r.mtime })
  }

  const einfuegen = h.prepare(
    `INSERT INTO chats (session_id, pfad, titel, cwd, projekt, started_at, ended_at,
                        zuege, git_branch, groesse, mtime, quelle, entrypoint)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (session_id) DO UPDATE SET
       pfad=excluded.pfad, titel=excluded.titel, cwd=excluded.cwd, projekt=excluded.projekt,
       started_at=excluded.started_at, ended_at=excluded.ended_at, zuege=excluded.zuege,
       git_branch=excluded.git_branch, groesse=excluded.groesse, mtime=excluded.mtime,
       quelle=excluded.quelle, entrypoint=excluded.entrypoint`,
  )

  const kandidaten = await kandidatenSammeln()
  for (const [sessionId, k] of kandidaten) {
    const alt = bekannt.get(sessionId)
    if (alt && alt.pfad === k.pfad && alt.groesse === k.groesse && alt.mtime === k.mtime) continue

    let roh: string
    try {
      roh = await readFile(k.pfad, 'utf-8')
    } catch {
      continue
    }
    const { kopf, eingaben } = auswerten(sessionId, k.pfad, roh, k.groesse, k.quelle)
    einfuegen.run(
      kopf.sessionId, k.pfad, kopf.titel, kopf.cwd, kopf.projekt,
      kopf.startedAt, kopf.endedAt, kopf.zuege, kopf.gitBranch,
      k.groesse, k.mtime, k.quelle, kopf.entrypoint,
    )
    h.prepare('DELETE FROM chats_fts WHERE session_id = ?').run(sessionId)
    h.prepare('INSERT INTO chats_fts (session_id, titel, eingaben) VALUES (?,?,?)')
      .run(sessionId, kopf.titel, eingaben)
    neu++
  }
  // Verschwundene Sitzungen austragen. Ohne das blieben geloeschte Dateien
  // fuer immer in Liste und Suche stehen und liefen beim Oeffnen in einen
  // Lesefehler -- der Index waere mit der Zeit ein Friedhof.
  let weg = 0
  for (const id of bekannt.keys()) {
    if (kandidaten.has(id)) continue
    h.prepare('DELETE FROM chats WHERE session_id = ?').run(id)
    h.prepare('DELETE FROM chats_fts WHERE session_id = ?').run(id)
    weg++
  }
  console.log(`[chats] ${kandidaten.size} Sitzungen, ${neu} neu oder geaendert${weg ? `, ${weg} ausgetragen` : ''}`)
  return { gesamt: kandidaten.size, neu }
}

function zeileZuKopf(r: Record<string, unknown>): ChatKopf {
  return {
    sessionId: String(r.session_id),
    titel: String(r.eigener_titel ?? r.titel),
    cwd: r.cwd ? String(r.cwd) : null,
    projekt: r.projekt ? String(r.projekt) : null,
    startedAt: r.started_at ? Number(r.started_at) : null,
    endedAt: r.ended_at ? Number(r.ended_at) : null,
    zuege: Number(r.zuege ?? 0),
    gitBranch: r.git_branch ? String(r.git_branch) : null,
    groesse: Number(r.groesse ?? 0),
    quelle: r.quelle === 'server' ? 'server' : 'desktop',
    entrypoint: r.entrypoint ? String(r.entrypoint) : null,
    angeheftet: Boolean(r.angeheftet),
  }
}

/** Spalten und Join fuer die Markierung; zeileZuKopf liest eigener_titel. */
const MIT_MARKIERUNG = `c.*, m.titel AS eigener_titel, COALESCE(m.angeheftet, 0) AS angeheftet
  FROM chats c LEFT JOIN chat_markierung m ON m.session_id = c.session_id`
/** Aus der Liste genommen, solange danach nichts mehr im Chat geschah. */
const NICHT_AUSGEBLENDET = `(m.ausgeblendet IS NULL OR COALESCE(c.ended_at, c.started_at, 0) > m.ausgeblendet)`

/**
 * Welche Sitzungen in die Chatliste gehoeren: was ein Mensch angefangen hat
 * (Claude Desktop, CLI) und was im Cockpit als Chat laeuft (steht in
 * chat_fortsetzung). NICHT: die Worker und Orchestrator-Aufrufe der
 * Team-Auftraege und der Nachtschicht-Loop -- das sind Dutzende kurzer
 * Sitzungen je Lauf, die die Liste unbrauchbar machen wuerden. Alte Dateien
 * ohne entrypoint bleiben sichtbar (lieber eine zu viel als eine verloren).
 */
const SICHTBAR_SQL = `(c.entrypoint IS NULL OR c.entrypoint IN ('claude-desktop', 'cli')
  OR c.session_id IN (SELECT session_id FROM chat_fortsetzung))`

export function chatsSuchen(dbPfad: string, q: string, limit = 60, alle = false): ChatKopf[] {
  const h = handle(dbPfad)
  const filter = `${alle ? '1' : SICHTBAR_SQL} AND ${NICHT_AUSGEBLENDET}`
  if (!q.trim()) {
    // Sortiert nach letzter Aktivitaet, nicht nach Beginn: ein alter Chat, in
    // dem gestern weitergeschrieben wurde, gehoert nach oben -- so wie in der
    // Claude-App.
    return (h.prepare(
      `SELECT ${MIT_MARKIERUNG} WHERE ${filter}
       ORDER BY angeheftet DESC, COALESCE(c.ended_at, c.started_at) DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[]).map(zeileZuKopf)
  }
  // Praefixsuche je Wort: wer "cockp" tippt, will "Cockpit" finden.
  // Anfuehrungszeichen verdoppeln, damit FTS5 die Eingabe nicht als Syntax
  // liest und bei einem Apostroph mit einem Fehler aussteigt.
  const muster = q.trim().split(/\s+/)
    .map((w) => `"${w.replace(/"/g, '""')}"*`).join(' AND ')
  // Den eigenen Titel kennt der FTS-Index nicht (der wird aus den Dateien
  // gebaut) -- er wird per LIKE mitgesucht und steht dann vorn.
  const wie = `%${q.trim().replace(/[\\%_]/g, (z) => `\\${z}`)}%`
  try {
    return (h.prepare(
      `SELECT ${MIT_MARKIERUNG}
       LEFT JOIN (SELECT session_id, rank FROM chats_fts WHERE chats_fts MATCH ?) f ON f.session_id = c.session_id
       WHERE (f.session_id IS NOT NULL OR m.titel LIKE ? ESCAPE '\\') AND ${filter}
       ORDER BY (m.titel LIKE ? ESCAPE '\\') DESC, f.rank LIMIT ?`,
    ).all(muster, wie, wie, limit) as Record<string, unknown>[]).map(zeileZuKopf)
  } catch (e) {
    console.warn('[chats] Suche fehlgeschlagen:', String(e))
    return []
  }
}

/**
 * Arbeitsordner der zuletzt aktiven Chats, neueste zuerst, ohne Doppelte --
 * fuer die Ordnerwahl beim neuen Chat. Nur sichtbare Chats: die Ordner der
 * Team-Worker sind dieselben, aber in Massen.
 */
export function zuletztBenutzteOrdner(dbPfad: string, limit = 8): string[] {
  const h = handle(dbPfad)
  return (h.prepare(
    `SELECT c.cwd AS cwd, MAX(COALESCE(c.ended_at, c.started_at, 0)) AS t FROM chats c
     WHERE c.cwd IS NOT NULL AND c.cwd != '' AND ${SICHTBAR_SQL}
     GROUP BY c.cwd ORDER BY t DESC LIMIT ?`,
  ).all(limit) as { cwd: string }[]).map((r) => String(r.cwd))
}

export function chatKopfLesen(dbPfad: string, sessionId: string): (ChatKopf & { pfad: string }) | null {
  const h = handle(dbPfad)
  const r = h.prepare(`SELECT ${MIT_MARKIERUNG} WHERE c.session_id = ?`).get(sessionId) as
    Record<string, unknown> | undefined
  if (!r) return null
  return { ...zeileZuKopf(r), pfad: String(r.pfad) }
}

/**
 * Zu welchem Chat gehoert eine Sitzungs-Id? Direkt, oder ueber die
 * Fortsetzung (ein weitergeschriebener Chat laeuft unter neuer Id weiter).
 * null: kein Chat -- etwa ein Agent eines Team-Auftrags.
 */
export function chatFuerSitzung(dbPfad: string, sitzung: string): { id: string; titel: string } | null {
  const h = handle(dbPfad)
  const r = (h.prepare(
    `SELECT c.session_id, COALESCE(m.titel, c.titel) AS titel FROM chats c
     LEFT JOIN chat_markierung m ON m.session_id = c.session_id WHERE c.session_id = ?`,
  ).get(sitzung)
    ?? h.prepare(
      `SELECT c.session_id, COALESCE(m.titel, c.titel) AS titel FROM chat_fortsetzung f
       JOIN chats c ON c.session_id = f.session_id
       LEFT JOIN chat_markierung m ON m.session_id = c.session_id
       WHERE f.aktuelle_session = ?`,
    ).get(sitzung)) as { session_id: string; titel: string } | undefined
  return r ? { id: String(r.session_id), titel: String(r.titel) } : null
}

export interface Markierung {
  /** Eigener Titel; leer oder null stellt den Titel aus der Sitzung wieder her. */
  titel?: string | null
  angeheftet?: boolean
  /** true nimmt den Chat aus Liste und Suche (und heftet ihn ab), false holt ihn zurueck. */
  ausgeblendet?: boolean
}

export const TITEL_HOECHSTENS = 120

/**
 * Markierung eines Chats aendern (nur die angegebenen Felder). false, wenn
 * das Cockpit den Chat nicht kennt -- weder im Index noch als eben
 * begonnener Chat ohne Sitzungsdatei.
 */
export function chatMarkieren(dbPfad: string, sessionId: string, m: Markierung): boolean {
  const h = handle(dbPfad)
  const bekannt = h.prepare(
    `SELECT 1 FROM chats WHERE session_id = ? UNION SELECT 1 FROM chat_fortsetzung WHERE session_id = ?`,
  ).get(sessionId, sessionId)
  if (!bekannt) return false
  h.prepare('INSERT OR IGNORE INTO chat_markierung (session_id) VALUES (?)').run(sessionId)
  if (m.titel !== undefined) {
    const t = (m.titel ?? '').replace(/\s+/g, ' ').trim().slice(0, TITEL_HOECHSTENS)
    h.prepare('UPDATE chat_markierung SET titel = ? WHERE session_id = ?').run(t || null, sessionId)
  }
  if (m.angeheftet !== undefined) {
    h.prepare('UPDATE chat_markierung SET angeheftet = ? WHERE session_id = ?').run(m.angeheftet ? 1 : 0, sessionId)
  }
  if (m.ausgeblendet !== undefined) {
    // Ausblenden heftet ab: sonst kaeme er beim Zurueckholen (neue
    // Aktivitaet) unerwartet ganz oben wieder.
    h.prepare(
      `UPDATE chat_markierung SET ausgeblendet = ?, angeheftet = CASE WHEN ? THEN 0 ELSE angeheftet END
       WHERE session_id = ?`,
    ).run(m.ausgeblendet ? Date.now() : null, m.ausgeblendet ? 1 : 0, sessionId)
  }
  return true
}

/** Was ein Chat zuletzt benutzt hat -- gleiche Schluessel wie die Anfrage an /api/chats. */
export interface GemerkteOptionen {
  modell?: string
  aufwand?: string
  berechtigung?: string
}

export function chatOptionenMerken(dbPfad: string, sessionId: string, o: GemerkteOptionen): void {
  handle(dbPfad).prepare(
    `INSERT INTO chat_optionen (session_id, modell, aufwand, berechtigung, geaendert) VALUES (?,?,?,?,?)
     ON CONFLICT (session_id) DO UPDATE SET modell = excluded.modell, aufwand = excluded.aufwand,
       berechtigung = excluded.berechtigung, geaendert = excluded.geaendert`,
  ).run(sessionId, o.modell ?? null, o.aufwand ?? null, o.berechtigung ?? null, Date.now())
}

/** Nach "Plan umsetzen": nur den Modus eines schon gemerkten Chats aendern. */
export function chatBerechtigungSetzen(dbPfad: string, sessionId: string, berechtigung: string): void {
  if (!berechtigungGueltig(berechtigung)) return
  handle(dbPfad).prepare('UPDATE chat_optionen SET berechtigung = ?, geaendert = ? WHERE session_id = ?')
    .run(berechtigung, Date.now(), sessionId)
}

/**
 * Leeres Objekt, wenn der Chat noch nie im Cockpit geschrieben wurde. Was
 * inzwischen ungueltig ist (ein entferntes Modell), faellt weg -- dann gilt
 * die Vorgabe, statt dass der naechste Zug mit 400 scheitert.
 */
export function chatOptionenLesen(dbPfad: string, sessionId: string): GemerkteOptionen {
  const r = handle(dbPfad).prepare('SELECT modell, aufwand, berechtigung FROM chat_optionen WHERE session_id = ?')
    .get(sessionId) as Record<string, unknown> | undefined
  const o: GemerkteOptionen = {}
  if (modellGueltig(r?.modell)) o.modell = r.modell
  if (aufwandGueltig(r?.aufwand)) o.aufwand = r.aufwand
  if (berechtigungGueltig(r?.berechtigung)) o.berechtigung = r.berechtigung
  return o
}

export interface Fortsetzung {
  laufId: string
  aktuelleSession: string
  cwd: string
}

/** Zeile aus chat_fortsetzung, oder null, wenn diese Sitzung noch nie fortgeschrieben wurde. */
export function fortsetzungLesen(dbPfad: string, sessionId: string): Fortsetzung | null {
  const h = handle(dbPfad)
  const r = h.prepare('SELECT * FROM chat_fortsetzung WHERE session_id = ?').get(sessionId) as
    Record<string, unknown> | undefined
  if (!r) return null
  return { laufId: String(r.lauf_id), aktuelleSession: String(r.aktuelle_session), cwd: String(r.cwd) }
}

/**
 * Macht eine Sitzung fortsetzbar: legt (beim ersten Mal) eine Kopie der
 * Spiegeldatei an der Stelle an, an der die Claude-Code-CLI sie fuer `cwd`
 * erwarten wuerde, und traegt die Zuordnung in chat_fortsetzung ein.
 *
 * Kopiert wird NUR beim allerersten Mal -- ab dann gehoert die Zieldatei dem
 * laufenden Chat, und jeder weitere Zug haengt an sie an (die SDK tut das
 * selbst ueber `resume`). In den Spiegel wird nie geschrieben: der gehoert
 * Syncthing und dem Desktop, nicht diesem Host.
 */
export async function fortsetzungVorbereiten(
  dbPfad: string, sessionId: string, ersatzCwd: string,
): Promise<Fortsetzung | null> {
  const vorhanden = fortsetzungLesen(dbPfad, sessionId)
  if (vorhanden) return vorhanden

  const k = chatKopfLesen(dbPfad, sessionId)
  if (!k) return null

  const cwd = k.cwd && existsSync(k.cwd) ? k.cwd : ersatzCwd
  const zielVerzeichnis = join(projekteVerzeichnis(), projektSchluessel(cwd))
  const zielDatei = join(zielVerzeichnis, `${sessionId}.jsonl`)

  if (!existsSync(zielDatei)) {
    await mkdir(zielVerzeichnis, { recursive: true })
    await copyFile(k.pfad, zielDatei)
  }

  const f: Fortsetzung = { laufId: `chat-${sessionId}`, aktuelleSession: sessionId, cwd }
  const h = handle(dbPfad)
  h.prepare(
    `INSERT INTO chat_fortsetzung (session_id, lauf_id, aktuelle_session, cwd, geaendert)
     VALUES (?,?,?,?,?)
     ON CONFLICT (session_id) DO NOTHING`,
  ).run(sessionId, f.laufId, f.aktuelleSession, f.cwd, Date.now())

  return f
}

/** Nach einem Zug: die SDK vergibt bei `resume` eine neue Session-Id. */
export function fortsetzungAktualisieren(dbPfad: string, sessionId: string, neueSession: string): void {
  const h = handle(dbPfad)
  h.prepare(
    `UPDATE chat_fortsetzung SET aktuelle_session = ?, geaendert = ? WHERE session_id = ?`,
  ).run(neueSession, Date.now(), sessionId)
}

/**
 * Nutzungslimit-Meldung als Assistant-Text, keine echte Antwort. Gleiche
 * Erkennung wie im Supervisor (USAGE_LIMIT_ERROR_PREFIXES aus dem SDK,
 * supervisor.ts): laeuft ein Konto waehrend eines Zuges ins Limit, steht die
 * Meldung ganz normal als Assistant-Textblock in der Sitzung, bevor der
 * Kontowechsel greift und die echte Antwort nachliefert.
 */
function istNutzungslimitText(text: string): boolean {
  return USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.includes(p))
}

/**
 * Einen im Cockpit NEU begonnenen Chat eintragen, sobald die SDK seine
 * Session-Id gemeldet hat. Damit gilt er als Cockpit-Chat (SICHTBAR_SQL),
 * obwohl ihn ein SDK-Prozess angelegt hat, und laeuft ueber denselben
 * Pseudo-Lauf weiter wie eine fortgesetzte Desktop-Sitzung.
 */
export function chatRegistrieren(dbPfad: string, sessionId: string, laufId: string, cwd: string): void {
  const h = handle(dbPfad)
  h.prepare(
    `INSERT INTO chat_fortsetzung (session_id, lauf_id, aktuelle_session, cwd, geaendert)
     VALUES (?,?,?,?,?)
     ON CONFLICT (session_id) DO NOTHING`,
  ).run(sessionId, laufId, sessionId, cwd, Date.now())
}

/**
 * Pfad der Datei, die den aktuellen Stand einer Sitzung traegt: die Kopie im
 * projects/ dieses Hosts, wenn schon fortgeschrieben wurde, sonst die Datei
 * aus dem Index. null, wenn keine existiert.
 */
function aktuelleDatei(dbPfad: string, sessionId: string): string | null {
  const f = fortsetzungLesen(dbPfad, sessionId)
  if (f) {
    const kandidat = join(projekteVerzeichnis(), projektSchluessel(f.cwd), `${f.aktuelleSession}.jsonl`)
    if (existsSync(kandidat)) return kandidat
  }
  const k = chatKopfLesen(dbPfad, sessionId)
  return k && existsSync(k.pfad) ? k.pfad : null
}

/**
 * Gibt es schon eine Sitzungsdatei? Ein neuer Chat, dessen erster Zug
 * scheiterte, bevor die CLI etwas schrieb, hat keine -- dann muss der naechste
 * Zug wieder neu anfangen statt ins Leere fortzusetzen.
 */
export function sitzungVorhanden(dbPfad: string, sessionId: string): boolean {
  return aktuelleDatei(dbPfad, sessionId) !== null
}

/**
 * Eine Sitzung im Format der Chat-Ansicht (nachrichten.ts): Text, Denken,
 * Werkzeugaufrufe und -ergebnisse, Hinweise. Fuer einen gerade erst
 * begonnenen Chat, den der Index noch nicht kennt, reicht der Eintrag in
 * chat_fortsetzung -- der Kopf wird dann aus der Datei selbst gelesen.
 */
export async function verlaufLesen(
  dbPfad: string, sessionId: string, max = 400,
): Promise<{ kopf: ChatKopf; nachrichten: Nachricht[]; gekuerzt: boolean } | null> {
  const pfad = aktuelleDatei(dbPfad, sessionId)
  if (!pfad) return null
  let roh: string
  try {
    roh = await readFile(pfad, 'utf-8')
  } catch {
    return null
  }
  const indexiert = chatKopfLesen(dbPfad, sessionId)
  const kopf = indexiert ??
    auswerten(sessionId, pfad, roh, Buffer.byteLength(roh), pfad.startsWith(SPIEGEL) ? 'desktop' : 'server').kopf
  const { nachrichten, gekuerzt } = verlaufNormalisieren(roh, istNutzungslimitText, max)
  return { kopf, nachrichten, gekuerzt }
}

/**
 * Was ueber eine Sitzung bekannt ist -- fuer den Rueckblick, der Chats,
 * Loops und Team-Auftraege unterschiedlich zeigt. `chat` nur, wenn die
 * Sitzung in die Chatliste gehoert (SICHTBAR_SQL) -- ein Worker-Aufruf soll
 * im Rueckblick nicht als oeffenbarer Chat erscheinen.
 */
export function sitzungBeschreiben(
  dbPfad: string, sitzung: string,
): { titel: string; entrypoint: string | null; projekt: string | null; chat: { id: string; titel: string } | null } | null {
  const h = handle(dbPfad)
  const r = h.prepare(
    `SELECT c.titel, c.entrypoint, c.projekt, ${SICHTBAR_SQL} AS sichtbar FROM chats c WHERE c.session_id = ?`,
  ).get(sitzung) as { titel: string; entrypoint: string | null; projekt: string | null; sichtbar: number } | undefined
  const chat = chatFuerSitzung(dbPfad, sitzung)
  if (!r) return chat ? { titel: chat.titel, entrypoint: null, projekt: null, chat } : null
  return {
    titel: String(r.titel),
    entrypoint: r.entrypoint,
    projekt: r.projekt,
    chat: r.sichtbar ? chat : null,
  }
}

// --- Warteschlange ------------------------------------------------------------

export interface WarteEintrag {
  nr: number
  text: string
  /** Schon gepruefte Pfade unter ANHAENGE (anhaengePruefen). */
  anhaenge: string[]
  /** Modell, Aufwand, Modus -- wie in der Anfrage an /weiter. */
  optionen: Record<string, unknown>
  erstellt: number
  /** Geht erst auf Cans "Jetzt senden" raus (warteschlange.ts). */
  gehalten: boolean
}

export function einreihen(
  dbPfad: string, sessionId: string, text: string, anhaenge: string[], optionen: Record<string, unknown>,
): void {
  handle(dbPfad).prepare(
    'INSERT INTO chat_warteschlange (session_id, text, anhaenge, optionen, erstellt) VALUES (?,?,?,?,?)',
  ).run(sessionId, text, JSON.stringify(anhaenge), JSON.stringify(optionen), Date.now())
}

export function warteschlangeLesen(dbPfad: string, sessionId: string): WarteEintrag[] {
  return (handle(dbPfad).prepare(
    'SELECT nr, text, anhaenge, optionen, erstellt, gehalten FROM chat_warteschlange WHERE session_id = ? ORDER BY nr',
  ).all(sessionId) as { nr: number; text: string; anhaenge: string; optionen: string; erstellt: number; gehalten: number }[])
    .map((r) => ({
      nr: r.nr, text: r.text, anhaenge: JSON.parse(r.anhaenge), optionen: JSON.parse(r.optionen),
      erstellt: r.erstellt, gehalten: r.gehalten === 1,
    }))
}

/** Diese Eintraege gehen erst auf Cans "Jetzt senden" raus. */
export function warteschlangeHalten(dbPfad: string, sessionId: string, nrs: readonly number[]): void {
  const st = handle(dbPfad).prepare('UPDATE chat_warteschlange SET gehalten = 1 WHERE session_id = ? AND nr = ?')
  for (const nr of nrs) st.run(sessionId, nr)
}

/**
 * Beim Start des Daemons: was noch wartet, hat seinen Zug verloren (Neustart
 * mitten im Zug) -- nicht ungefragt losschicken, sondern halten. Liefert die
 * betroffenen Chats.
 */
export function alleWartendenHalten(dbPfad: string): string[] {
  const h = handle(dbPfad)
  h.prepare('UPDATE chat_warteschlange SET gehalten = 1').run()
  return (h.prepare('SELECT DISTINCT session_id FROM chat_warteschlange').all() as { session_id: string }[])
    .map((r) => r.session_id)
}

/** Einen Eintrag loeschen. false, wenn es ihn (fuer diesen Chat) nicht gibt. */
export function ausWarteschlange(dbPfad: string, sessionId: string, nr: number): boolean {
  return Number(handle(dbPfad).prepare(
    'DELETE FROM chat_warteschlange WHERE session_id = ? AND nr = ?',
  ).run(sessionId, nr).changes) > 0
}

/**
 * Diese Eintraege (oder alle) herausnehmen -- in einem Schritt, damit nichts
 * doppelt rausgeht. Was inzwischen zurueckgenommen wurde, fehlt im Ergebnis.
 */
export function warteschlangeEntnehmen(dbPfad: string, sessionId: string, nrs?: readonly number[]): WarteEintrag[] {
  const h = handle(dbPfad)
  h.exec('BEGIN IMMEDIATE')
  try {
    const raus = warteschlangeLesen(dbPfad, sessionId).filter((e) => !nrs || nrs.includes(e.nr))
    const st = h.prepare('DELETE FROM chat_warteschlange WHERE session_id = ? AND nr = ?')
    for (const e of raus) st.run(sessionId, e.nr)
    h.exec('COMMIT')
    return raus
  } catch (e) {
    h.exec('ROLLBACK')
    throw e
  }
}

/**
 * Mehrere wartende Nachrichten werden EIN Zug: Claude liest sie zusammen, in
 * der Reihenfolge, in der Can sie geschrieben hat. Welche Optionen gelten,
 * entscheidet warteschlange.ts (schlangeOptionen).
 */
export function zusammenfassen(eintraege: readonly Pick<WarteEintrag, 'text' | 'anhaenge'>[]): {
  text: string; anhaenge: string[]
} {
  return {
    text: eintraege.map((e) => e.text).join('\n\n'),
    anhaenge: [...new Set(eintraege.flatMap((e) => e.anhaenge))],
  }
}

/** Wann Modell/Aufwand/Modus dieses Chats zuletzt gesetzt wurden (Zugstart, Plan angenommen). */
export function chatOptionenGeaendert(dbPfad: string, sessionId: string): number | null {
  const r = handle(dbPfad).prepare('SELECT geaendert FROM chat_optionen WHERE session_id = ?').get(sessionId) as
    { geaendert: number } | undefined
  return r?.geaendert ?? null
}
