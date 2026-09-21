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
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
  mtime      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chats_zeit ON chats (started_at DESC);
-- Durchsucht werden Titel und die EIGENEN Eingaben, nicht die Antworten.
-- Wer eine alte Sitzung sucht, erinnert sich an das, was er getippt hat.
-- Die Antworten mitzuindizieren waere ein Vielfaches an Platz fuer Treffer,
-- die man ohnehin nicht wiedererkennt.
CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
  session_id UNINDEXED, titel, eingaben, tokenize='unicode61'
);
`

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
  /** Ob das Arbeitsverzeichnis auf DIESEM Host existiert -- nur dann ist
   *  ein echtes Fortsetzen moeglich. */
  fortsetzbar?: boolean
}

let db: DatabaseSync | null = null

function handle(pfad: string): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(pfad)
    db.exec('PRAGMA journal_mode = WAL')
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
function auswerten(sessionId: string, pfad: string, roh: string, groesse: number): Gelesen {
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
      startedAt: von, endedAt: bis, zuege, gitBranch, groesse,
    },
    eingaben: eingaben.join('\n'),
  }
}

/** Baut den Index auf. Unveraenderte Dateien werden uebersprungen. */
export async function chatsIndizieren(dbPfad: string): Promise<{ gesamt: number; neu: number }> {
  const h = handle(dbPfad)
  let gesamt = 0
  let neu = 0

  let projekte: string[]
  try {
    projekte = await readdir(SPIEGEL)
  } catch {
    console.warn(`[chats] Spiegel ${SPIEGEL} nicht lesbar -- Index bleibt leer`)
    return { gesamt: 0, neu: 0 }
  }

  const bekannt = new Map<string, { groesse: number; mtime: number }>()
  for (const r of h.prepare('SELECT session_id, groesse, mtime FROM chats').all() as {
    session_id: string; groesse: number; mtime: number
  }[]) {
    bekannt.set(r.session_id, { groesse: r.groesse, mtime: r.mtime })
  }

  const gesehen = new Set<string>()

  const einfuegen = h.prepare(
    `INSERT INTO chats (session_id, pfad, titel, cwd, projekt, started_at, ended_at,
                        zuege, git_branch, groesse, mtime)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (session_id) DO UPDATE SET
       pfad=excluded.pfad, titel=excluded.titel, cwd=excluded.cwd, projekt=excluded.projekt,
       started_at=excluded.started_at, ended_at=excluded.ended_at, zuege=excluded.zuege,
       git_branch=excluded.git_branch, groesse=excluded.groesse, mtime=excluded.mtime`,
  )

  for (const p of projekte) {
    let dateien: string[]
    try {
      dateien = (await readdir(join(SPIEGEL, p))).filter((d) => d.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const d of dateien) {
      const voll = join(SPIEGEL, p, d)
      const sessionId = d.replace(/\.jsonl$/, '')
      gesehen.add(sessionId)
      gesamt++
      let s
      try {
        s = await stat(voll)
      } catch {
        continue
      }
      const alt = bekannt.get(sessionId)
      if (alt && alt.groesse === s.size && alt.mtime === Math.round(s.mtimeMs)) continue

      let roh: string
      try {
        roh = await readFile(voll, 'utf-8')
      } catch {
        continue
      }
      const { kopf, eingaben } = auswerten(sessionId, voll, roh, s.size)
      einfuegen.run(
        kopf.sessionId, voll, kopf.titel, kopf.cwd, kopf.projekt,
        kopf.startedAt, kopf.endedAt, kopf.zuege, kopf.gitBranch,
        s.size, Math.round(s.mtimeMs),
      )
      h.prepare('DELETE FROM chats_fts WHERE session_id = ?').run(sessionId)
      h.prepare('INSERT INTO chats_fts (session_id, titel, eingaben) VALUES (?,?,?)')
        .run(sessionId, kopf.titel, eingaben)
      neu++
    }
  }
  // Verschwundene Sitzungen austragen. Ohne das blieben geloeschte Dateien
  // fuer immer in Liste und Suche stehen und liefen beim Oeffnen in einen
  // Lesefehler -- der Index waere mit der Zeit ein Friedhof.
  let weg = 0
  for (const id of bekannt.keys()) {
    if (gesehen.has(id)) continue
    h.prepare('DELETE FROM chats WHERE session_id = ?').run(id)
    h.prepare('DELETE FROM chats_fts WHERE session_id = ?').run(id)
    weg++
  }
  console.log(`[chats] ${gesamt} Sitzungen, ${neu} neu oder geaendert${weg ? `, ${weg} ausgetragen` : ''}`)
  return { gesamt, neu }
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
  }
}

export function chatsSuchen(dbPfad: string, q: string, limit = 60): ChatKopf[] {
  const h = handle(dbPfad)
  if (!q.trim()) {
    return (h.prepare('SELECT * FROM chats ORDER BY started_at DESC LIMIT ?').all(limit) as
      Record<string, unknown>[]).map(zeileZuKopf)
  }
  // Praefixsuche je Wort: wer "cockp" tippt, will "Cockpit" finden.
  // Anfuehrungszeichen verdoppeln, damit FTS5 die Eingabe nicht als Syntax
  // liest und bei einem Apostroph mit einem Fehler aussteigt.
  const muster = q.trim().split(/\s+/)
    .map((w) => `"${w.replace(/"/g, '""')}"*`).join(' AND ')
  try {
    return (h.prepare(
      `SELECT c.* FROM chats_fts f JOIN chats c ON c.session_id = f.session_id
       WHERE chats_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).all(muster, limit) as Record<string, unknown>[]).map(zeileZuKopf)
  } catch (e) {
    console.warn('[chats] Suche fehlgeschlagen:', String(e))
    return []
  }
}

export function chatKopfLesen(dbPfad: string, sessionId: string): (ChatKopf & { pfad: string }) | null {
  const h = handle(dbPfad)
  const r = h.prepare('SELECT * FROM chats WHERE session_id = ?').get(sessionId) as
    Record<string, unknown> | undefined
  if (!r) return null
  return { ...zeileZuKopf(r), pfad: String(r.pfad) }
}

/** Eine Sitzung als Folge lesbarer Beitraege. */
export async function chatLesen(
  dbPfad: string, sessionId: string, maxBeitraege = 400,
): Promise<{ kopf: ChatKopf; beitraege: { rolle: string; ts: number | null; text: string }[] } | null> {
  const k = chatKopfLesen(dbPfad, sessionId)
  if (!k) return null
  let roh: string
  try {
    roh = await readFile(k.pfad, 'utf-8')
  } catch {
    return { kopf: k, beitraege: [] }
  }
  const beitraege: { rolle: string; ts: number | null; text: string }[] = []
  for (const zeile of roh.split('\n')) {
    if (!zeile) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(zeile) as Record<string, unknown>
    } catch {
      continue
    }
    const typ = String(d.type ?? '')
    if (typ !== 'user' && typ !== 'assistant') continue
    const m = d.message as { content?: unknown } | undefined
    const text = textAus(m?.content).trim()
    if (!text) continue
    const ts = d.timestamp ? Date.parse(String(d.timestamp)) : NaN
    beitraege.push({ rolle: typ, ts: Number.isNaN(ts) ? null : ts, text: text.slice(0, 8000) })
    if (beitraege.length >= maxBeitraege) break
  }
  return { kopf: k, beitraege }
}
