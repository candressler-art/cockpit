// Persistenz auf SQLite (node:sqlite, in Node >= 22.5 eingebaut -- keine
// externe Abhaengigkeit, kein Build-Schritt fuer native Module).
//
// Grundregel des Daemons: kein Zustand im Speicher, der nicht auch hier steht.
// Cans bisherige Laeufe sind daran gestorben, dass ein Prozesstod den Verlauf
// mitgenommen hat und hinterher niemand sagen konnte, woran der Lauf starb.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentState, CockpitEvent, LimitStand, PermissionRequest } from './typen.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  status      TEXT NOT NULL,
  cwd         TEXT,
  stop_reason TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  role            TEXT NOT NULL,
  fachrolle       TEXT,
  status          TEXT NOT NULL,
  session_id      TEXT,
  label           TEXT NOT NULL,
  parent_agent_id TEXT,
  model           TEXT,
  cwd             TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  weighted_tokens REAL NOT NULL DEFAULT 0,
  raw_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  turns           INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  PRIMARY KEY (run_id, agent_id)
);

CREATE TABLE IF NOT EXISTS events (
  seq                INTEGER NOT NULL,
  run_id             TEXT NOT NULL,
  ts                 INTEGER NOT NULL,
  agent_id           TEXT NOT NULL,
  session_id         TEXT,
  kind               TEXT NOT NULL,
  parent_tool_use_id TEXT,
  summary            TEXT NOT NULL,
  payload            TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_agent   ON events (run_id, agent_id, seq);

CREATE TABLE IF NOT EXISTS permissions (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  input        TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER,
  decision     TEXT,
  decided_by   TEXT,
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_perm_offen ON permissions (run_id, decided_at);

-- Laufzeitzustand von KontenVerwaltung (src/konten.ts): Sperren und Vorzug
-- waren bis hierher reiner In-Memory-Zustand und gingen bei jedem
-- Daemon-Neustart verloren -- ein Konto, das eigentlich noch bis zum
-- Reset gesperrt war, wurde sofort wieder probiert. Verstoesst gegen die
-- Grundregel oben ("kein Zustand im Speicher, der nicht auch hier steht").
CREATE TABLE IF NOT EXISTS konten_sperren (
  name  TEXT PRIMARY KEY,
  bis   INTEGER NOT NULL,
  grund TEXT NOT NULL DEFAULT 'limit'
);

CREATE TABLE IF NOT EXISTS konten_vorzug (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT
);

-- Letzter bekannter Nutzungsstand je Konto (siehe kontenNutzung.ts, konten.ts
-- nutzungMelden). Bisher reiner In-Memory-Zustand: ein Daemon-Neustart liess
-- jedes Konto ohne jede Messung dastehen -- balanciert wie ein nie genutztes
-- Konto (0 %, siehe KontoBalancing), selbst wenn es in Wahrheit mitten im
-- Wochenlimit steckte und der erste Poll nach dem Neustart nur an einem
-- abgelaufenen Token (401) oder einem HTTP 429 des Nutzungs-Endpunkts
-- scheiterte. Beobachtet auf servertwo nach dem Rollout der ersten Nacht.
CREATE TABLE IF NOT EXISTS konten_nutzung (
  name                    TEXT PRIMARY KEY,
  status                  TEXT NOT NULL,
  rate_limit_type         TEXT,
  resets_at               INTEGER,
  fuenf_stunden_anteil    REAL,
  fuenf_stunden_resets_at INTEGER,
  sieben_tage_anteil      REAL,
  sieben_tage_resets_at   INTEGER,
  gemessen_am             INTEGER NOT NULL,
  quelle                  TEXT NOT NULL
);
`

export class CockpitDb {
  private db: DatabaseSync

  constructor(pfad: string) {
    mkdirSync(dirname(pfad), { recursive: true })
    this.db = new DatabaseSync(pfad)
    // WAL: der Daemon schreibt laufend, das Frontend liest gleichzeitig.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.migrieren()
  }

  /**
   * Schemastand fortschreiben.
   *
   * Vorher gab es nur CREATE TABLE IF NOT EXISTS und kein Versionsfeld: eine
   * bestehende Datenbank bekam neue Spalten schlicht nicht, und es fiel erst
   * beim ersten INSERT auf. Jede Stufe hier ist additiv und darf zweimal
   * laufen, damit ein halb durchgelaufener Start nichts kaputtmacht.
   */
  private migrieren(): void {
    const zeile = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined
    let stand = zeile?.version ?? 0
    if (zeile === undefined) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()

    if (stand < 1) {
      // Bestandsdatenbanken: die Spalte fehlt, CREATE TABLE hat sie nicht
      // nachgetragen. Doppeltes ALTER wirft -- das ist hier der Normalfall
      // bei einer frisch angelegten Datei und kein Fehler.
      try {
        this.db.exec('ALTER TABLE agents ADD COLUMN fachrolle TEXT')
      } catch {
        /* Spalte war schon da (neu angelegte Datenbank) */
      }
      stand = 1
    }

    if (stand < 2) {
      // Sperrgrund (siehe SperrGrund in konten.ts). Bestandszeilen bekommen
      // 'limit' -- die vorsichtige Lesart, die nie vorzeitig aufgehoben wird.
      try {
        this.db.exec("ALTER TABLE konten_sperren ADD COLUMN grund TEXT NOT NULL DEFAULT 'limit'")
      } catch {
        /* Spalte war schon da (neu angelegte Datenbank) */
      }
      stand = 2
    }

    this.db.prepare('UPDATE schema_version SET version = ?').run(stand)
  }

  runAnlegen(runId: string, label: string, cwd: string | null): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, label, started_at, status, cwd)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(runId, label, Date.now(), cwd)
  }

  runBeenden(runId: string, status: string, stopReason: string | null): void {
    this.db
      .prepare(`UPDATE runs SET ended_at = ?, status = ?, stop_reason = ? WHERE run_id = ?`)
      .run(Date.now(), status, stopReason, runId)
  }

  agentSpeichern(a: AgentState): void {
    this.db
      .prepare(
        `INSERT INTO agents (agent_id, run_id, role, fachrolle, status, session_id, label,
           parent_agent_id, model, cwd, started_at, ended_at, weighted_tokens,
           raw_tokens, cost_usd, turns, last_error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (run_id, agent_id) DO UPDATE SET
           status = excluded.status,
           fachrolle = excluded.fachrolle,
           session_id = excluded.session_id,
           model = excluded.model,
           cwd = excluded.cwd,
           ended_at = excluded.ended_at,
           weighted_tokens = excluded.weighted_tokens,
           raw_tokens = excluded.raw_tokens,
           cost_usd = excluded.cost_usd,
           turns = excluded.turns,
           last_error = excluded.last_error`,
      )
      .run(
        a.agentId, a.runId, a.role, a.fachrolle, a.status, a.sessionId, a.label,
        a.parentAgentId, a.model, a.cwd, a.startedAt, a.endedAt,
        a.weightedTokens, a.rawTokens, a.costUsd, a.turns, a.lastError,
      )
  }

  ereignisSpeichern(e: CockpitEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (seq, run_id, ts, agent_id, session_id, kind,
           parent_tool_use_id, summary, payload)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.seq, e.runId, e.ts, e.agentId, e.sessionId, e.kind,
        e.parentToolUseId, e.summary, JSON.stringify(e.payload ?? null),
      )
  }

  /** Hoechste vergebene seq eines Laufs -- damit der Zaehler nach Neustart weiterlaeuft. */
  letzteSeq(runId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS s FROM events WHERE run_id = ?`)
      .get(runId) as { s: number | null } | undefined
    return row?.s ?? 0
  }

  /** Backfill nach Reconnect: alles, was der Client noch nicht hat. */
  ereignisseSeit(runId: string, seit: number, limit = 5000): CockpitEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, run_id, ts, agent_id, session_id, kind, parent_tool_use_id,
                summary, payload
           FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(runId, seit, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      seq: r.seq as number,
      runId: r.run_id as string,
      ts: r.ts as number,
      agentId: r.agent_id as string,
      sessionId: (r.session_id as string | null) ?? null,
      kind: r.kind as CockpitEvent['kind'],
      parentToolUseId: (r.parent_tool_use_id as string | null) ?? null,
      summary: r.summary as string,
      payload: JSON.parse((r.payload as string) || 'null'),
    }))
  }

  agentenLesen(runId: string): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT * FROM agents WHERE run_id = ? ORDER BY started_at`)
      .all(runId) as Record<string, unknown>[]
  }

  laeufeLesen(limit = 50): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[]
  }

  freigabeAnlegen(p: PermissionRequest): void {
    this.db
      .prepare(
        `INSERT INTO permissions (id, run_id, agent_id, tool_name, input, requested_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(p.id, p.runId, p.agentId, p.toolName, JSON.stringify(p.input ?? null), p.requestedAt)
  }

  freigabeEntscheiden(id: string, decision: 'allow' | 'deny', by: string, reason: string | null): void {
    this.db
      .prepare(
        `UPDATE permissions SET decided_at = ?, decision = ?, decided_by = ?, reason = ?
           WHERE id = ? AND decided_at IS NULL`,
      )
      .run(Date.now(), decision, by, reason, id)
  }

  offeneFreigaben(runId: string): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT * FROM permissions WHERE run_id = ? AND decided_at IS NULL
         ORDER BY requested_at`,
      )
      .all(runId) as Record<string, unknown>[]
  }

  /**
   * Laufende Laeufe nach einem Prozesstod als abgebrochen markieren. Ein Lauf,
   * der beim Start noch auf "running" steht, kann nicht mehr laufen -- der
   * Prozess, der ihn trieb, ist weg.
   */
  verwaisteLaeufeAufraeumen(): number {
    const jetzt = Date.now()
    const r = this.db
      .prepare(
        `UPDATE runs SET status = 'orphaned', ended_at = ?,
           stop_reason = 'Daemon-Neustart: Lauf war beim Start noch als laufend markiert'
         WHERE status = 'running'`,
      )
      .run(jetzt)

    // Auch die Agenten. Ein Agent, der auf 'waiting_permission' stehenbleibt,
    // obwohl sein Prozess laengst weg ist, sieht aus wie einer, der auf eine
    // Entscheidung wartet -- man wuerde eine Freigabe erteilen, die niemand
    // mehr entgegennimmt. Dasselbe gilt fuer jeden anderen laufenden Zustand.
    this.db
      .prepare(
        `UPDATE agents SET status = 'stopped', ended_at = COALESCE(ended_at, ?),
           last_error = COALESCE(last_error, 'Daemon-Neustart: Prozess war weg')
         WHERE ended_at IS NULL
           AND status NOT IN ('done', 'failed', 'stopped')`,
      )
      .run(jetzt)

    // Offene Freigaben desselben Laufs sind gegenstandslos: der Agent, der sie
    // angefragt hat, existiert nicht mehr.
    this.db
      .prepare(
        `UPDATE permissions SET decided_at = ?, decision = 'deny', decided_by = 'daemon',
           reason = 'Daemon-Neustart: anfragender Agent existiert nicht mehr'
         WHERE decided_at IS NULL`,
      )
      .run(jetzt)

    return Number(r.changes ?? 0)
  }

  /** Alle gespeicherten Kontosperren, Name -> Sperrzeitpunkt (ms). */
  kontoSperrenLesen(): Record<string, number> {
    const rows = this.db.prepare(`SELECT name, bis FROM konten_sperren`).all() as {
      name: string
      bis: number
    }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.name] = r.bis
    return out
  }

  /** Merkt eine Kontosperre dauerhaft, ueberlebt einen Daemon-Neustart. */
  kontoSperren(name: string, bis: number, grund: 'limit' | 'anmeldung' = 'limit'): void {
    this.db
      .prepare(
        `INSERT INTO konten_sperren (name, bis, grund) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET bis = excluded.bis, grund = excluded.grund`,
      )
      .run(name, bis, grund)
  }

  /** Sperrgrund je Konto (siehe SperrGrund in konten.ts). */
  kontoSperrGruendeLesen(): Record<string, 'limit' | 'anmeldung'> {
    const rows = this.db.prepare(`SELECT name, grund FROM konten_sperren`).all() as {
      name: string
      grund: string
    }[]
    const out: Record<string, 'limit' | 'anmeldung'> = {}
    for (const r of rows) out[r.name] = r.grund === 'anmeldung' ? 'anmeldung' : 'limit'
    return out
  }

  /** Manuell gesetztes Vorzugskonto, oder null ohne Vorzug. */
  kontoVorzugLesen(): string | null {
    const row = this.db.prepare(`SELECT name FROM konten_vorzug WHERE id = 1`).get() as
      | { name: string | null }
      | undefined
    return row?.name ?? null
  }

  /** Setzt oder loescht (null) das Vorzugskonto, dauerhaft. */
  kontoVorzugSetzen(name: string | null): void {
    this.db
      .prepare(
        `INSERT INTO konten_vorzug (id, name) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
      )
      .run(name)
  }

  /** Letzter bekannter Nutzungsstand je Konto, Name -> (Stand, Quelle). */
  kontoNutzungLesen(): Record<string, { stand: LimitStand; quelle: 'usage_api' | 'rate_limit_event' }> {
    const rows = this.db.prepare(`SELECT * FROM konten_nutzung`).all() as {
      name: string
      status: string
      rate_limit_type: string | null
      resets_at: number | null
      fuenf_stunden_anteil: number | null
      fuenf_stunden_resets_at: number | null
      sieben_tage_anteil: number | null
      sieben_tage_resets_at: number | null
      gemessen_am: number
      quelle: string
    }[]
    const out: Record<string, { stand: LimitStand; quelle: 'usage_api' | 'rate_limit_event' }> = {}
    for (const r of rows) {
      out[r.name] = {
        stand: {
          status: r.status,
          rateLimitType: r.rate_limit_type,
          resetsAt: r.resets_at,
          fuenfStundenAnteil: r.fuenf_stunden_anteil,
          fuenfStundenResetsAt: r.fuenf_stunden_resets_at,
          siebenTageAnteil: r.sieben_tage_anteil,
          siebenTageResetsAt: r.sieben_tage_resets_at,
          gemessenAm: r.gemessen_am,
        },
        quelle: r.quelle === 'rate_limit_event' ? 'rate_limit_event' : 'usage_api',
      }
    }
    return out
  }

  /** Merkt den Nutzungsstand eines Kontos dauerhaft, ueberlebt einen Daemon-Neustart. */
  kontoNutzungSpeichern(name: string, stand: LimitStand, quelle: 'usage_api' | 'rate_limit_event'): void {
    this.db
      .prepare(
        `INSERT INTO konten_nutzung (
           name, status, rate_limit_type, resets_at,
           fuenf_stunden_anteil, fuenf_stunden_resets_at,
           sieben_tage_anteil, sieben_tage_resets_at,
           gemessen_am, quelle
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           status = excluded.status,
           rate_limit_type = excluded.rate_limit_type,
           resets_at = excluded.resets_at,
           fuenf_stunden_anteil = excluded.fuenf_stunden_anteil,
           fuenf_stunden_resets_at = excluded.fuenf_stunden_resets_at,
           sieben_tage_anteil = excluded.sieben_tage_anteil,
           sieben_tage_resets_at = excluded.sieben_tage_resets_at,
           gemessen_am = excluded.gemessen_am,
           quelle = excluded.quelle`,
      )
      .run(
        name, stand.status, stand.rateLimitType, stand.resetsAt,
        stand.fuenfStundenAnteil, stand.fuenfStundenResetsAt,
        stand.siebenTageAnteil, stand.siebenTageResetsAt,
        stand.gemessenAm, quelle,
      )
  }

  close(): void {
    this.db.close()
  }
}
