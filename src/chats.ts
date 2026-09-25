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
import { verlaufNormalisieren, type Nachricht } from './nachrichten.js'
import { DB_WARTEN_MS } from './db.js'

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
  /** Ob das Arbeitsverzeichnis auf DIESEM Host existiert -- nur dann ist
   *  ein echtes Fortsetzen moeglich. */
  fortsetzbar?: boolean
}

let db: DatabaseSync | null = null

/**
 * Stand des Index-Schemas. Der Index ist abgeleiteter Zustand -- statt
 * Spalten nachzuruesten, wird er bei einem Sprung einfach neu gebaut
 * (chats und chats_fts; chat_fortsetzung ist KEIN abgeleiteter Zustand und
 * bleibt unangetastet).
 */
const INDEX_VERSION = 2

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
    (ersteEingabe ? ersteEingabe.replace(/\s+/g, ' ').slice(0, 70) : `Sitzung ${sessionId.slice(0, 8)}`)

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
    { pfad: SPIEGEL, quelle: 'desktop' },
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
  if (lesbar === 0) console.warn(`[chats] weder ${SPIEGEL} noch ${projekteVerzeichnis()} lesbar -- Index bleibt leer`)
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
    titel: String(r.titel),
    cwd: r.cwd ? String(r.cwd) : null,
    projekt: r.projekt ? String(r.projekt) : null,
    startedAt: r.started_at ? Number(r.started_at) : null,
    endedAt: r.ended_at ? Number(r.ended_at) : null,
    zuege: Number(r.zuege ?? 0),
    gitBranch: r.git_branch ? String(r.git_branch) : null,
    groesse: Number(r.groesse ?? 0),
    quelle: r.quelle === 'server' ? 'server' : 'desktop',
    entrypoint: r.entrypoint ? String(r.entrypoint) : null,
  }
}

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
  const filter = alle ? '1' : SICHTBAR_SQL
  if (!q.trim()) {
    // Sortiert nach letzter Aktivitaet, nicht nach Beginn: ein alter Chat, in
    // dem gestern weitergeschrieben wurde, gehoert nach oben -- so wie in der
    // Claude-App.
    return (h.prepare(
      `SELECT c.* FROM chats c WHERE ${filter}
       ORDER BY COALESCE(c.ended_at, c.started_at) DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[]).map(zeileZuKopf)
  }
  // Praefixsuche je Wort: wer "cockp" tippt, will "Cockpit" finden.
  // Anfuehrungszeichen verdoppeln, damit FTS5 die Eingabe nicht als Syntax
  // liest und bei einem Apostroph mit einem Fehler aussteigt.
  const muster = q.trim().split(/\s+/)
    .map((w) => `"${w.replace(/"/g, '""')}"*`).join(' AND ')
  try {
    return (h.prepare(
      `SELECT c.* FROM chats_fts f JOIN chats c ON c.session_id = f.session_id
       WHERE chats_fts MATCH ? AND ${filter} ORDER BY rank LIMIT ?`,
    ).all(muster, limit) as Record<string, unknown>[]).map(zeileZuKopf)
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
  const r = h.prepare('SELECT * FROM chats WHERE session_id = ?').get(sessionId) as
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
  const r = (h.prepare('SELECT session_id, titel FROM chats WHERE session_id = ?').get(sitzung)
    ?? h.prepare(
      `SELECT c.session_id, c.titel FROM chat_fortsetzung f JOIN chats c ON c.session_id = f.session_id
       WHERE f.aktuelle_session = ?`,
    ).get(sitzung)) as { session_id: string; titel: string } | undefined
  return r ? { id: String(r.session_id), titel: String(r.titel) } : null
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
