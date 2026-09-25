// Testet die Konten-Persistenz in CockpitDb (Sperren, Vorzug) gegen das
// gebaute Modul. Vorher `npm run build`, danach `node tests/db.test.mjs`.
import { CockpitDb } from '../dist/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const verzeichnis = mkdtempSync(join(tmpdir(), 'nachtschicht-db-'))
const dbPfad = join(verzeichnis, 'test.db')

// --- Kontosperren: Neustart darf eine laufende Sperre nicht vergessen ---
{
  const db = new CockpitDb(dbPfad)
  pruefe('frisch: keine Sperren gespeichert', Object.keys(db.kontoSperrenLesen()).length === 0)

  db.kontoSperren('zweit', 1_000_000)
  db.kontoSperren('dritt', 2_000_000)
  let sperren = db.kontoSperrenLesen()
  pruefe('zwei Sperren gespeichert', sperren.zweit === 1_000_000 && sperren.dritt === 2_000_000)

  // Ueberschreiben eines bereits gesperrten Kontos (neuer Fehler waehrend
  // der alten Sperre) muss den Wert ersetzen, nicht einen zweiten Eintrag anlegen.
  db.kontoSperren('zweit', 3_000_000)
  sperren = db.kontoSperrenLesen()
  pruefe('erneutes Sperren ueberschreibt statt zu verdoppeln',
    sperren.zweit === 3_000_000 && Object.keys(sperren).length === 2)
  db.close()
}

// --- Neu geoeffnete DB (simuliert Daemon-Neustart) sieht dieselben Sperren ---
{
  const db = new CockpitDb(dbPfad)
  const sperren = db.kontoSperrenLesen()
  pruefe('nach Neu-Oeffnen: Sperren ueberleben', sperren.zweit === 3_000_000 && sperren.dritt === 2_000_000)
  db.close()
}

// --- Sperrgrund: wird gespeichert, Vorgabe 'limit' ---
{
  const db = new CockpitDb(dbPfad)
  const gruende = db.kontoSperrGruendeLesen()
  pruefe('Sperre ohne Grund gespeichert: gilt als limit', gruende.zweit === 'limit')
  db.kontoSperren('vierte', 4_000_000, 'anmeldung')
  pruefe('Anmeldesperre: Grund gespeichert', db.kontoSperrGruendeLesen().vierte === 'anmeldung')
  db.kontoSperren('vierte', 5_000_000, 'limit')
  pruefe('neue Sperre ueberschreibt den Grund', db.kontoSperrGruendeLesen().vierte === 'limit')
  db.close()
}

// --- Bestandsdatenbank ohne Spalte grund: Migration traegt sie nach ---
{
  const { DatabaseSync } = await import('node:sqlite')
  const altPfad = join(verzeichnis, 'alt.db')
  const roh = new DatabaseSync(altPfad)
  roh.exec(`CREATE TABLE konten_sperren (name TEXT PRIMARY KEY, bis INTEGER NOT NULL);
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (1);
    INSERT INTO konten_sperren (name, bis) VALUES ('zweit', 9000000);`)
  roh.close()
  let db
  try { db = new CockpitDb(altPfad) } catch (e) { console.log('   ', String(e)) }
  pruefe('Migration: alte Datenbank laesst sich oeffnen', Boolean(db))
  if (db) {
    pruefe('Migration: alte Sperre bleibt, Grund limit',
      db.kontoSperrenLesen().zweit === 9_000_000 && db.kontoSperrGruendeLesen().zweit === 'limit')
    db.kontoSperren('zweit', 1, 'anmeldung')
    pruefe('Migration: neue Spalte beschreibbar', db.kontoSperrGruendeLesen().zweit === 'anmeldung')
    db.close()
  }
}

// --- Vorzugskonto: setzen, aendern, aufheben ---
{
  const db = new CockpitDb(dbPfad)
  pruefe('frisch: kein Vorzug gespeichert', db.kontoVorzugLesen() === null)

  db.kontoVorzugSetzen('zweit')
  pruefe('Vorzug gesetzt', db.kontoVorzugLesen() === 'zweit')

  db.kontoVorzugSetzen('dritt')
  pruefe('Vorzug geaendert (kein zweiter Eintrag)', db.kontoVorzugLesen() === 'dritt')

  db.kontoVorzugSetzen(null)
  pruefe('Vorzug aufgehoben', db.kontoVorzugLesen() === null)
  db.close()
}

// --- Auch das Aufheben des Vorzugs ueberlebt einen Neustart ---
{
  const db = new CockpitDb(dbPfad)
  pruefe('nach Neu-Oeffnen: aufgehobener Vorzug bleibt aufgehoben', db.kontoVorzugLesen() === null)
  db.close()
}

// --- Nutzungsstand je Konto: Neustart darf die letzte Messung nicht vergessen ---
{
  const db = new CockpitDb(dbPfad)
  pruefe('frisch: keine Nutzung gespeichert', Object.keys(db.kontoNutzungLesen()).length === 0)

  const stand = {
    status: 'rejected',
    rateLimitType: 'seven_day',
    resetsAt: null,
    fuenfStundenAnteil: 0.4,
    fuenfStundenResetsAt: 1_800_000,
    siebenTageAnteil: 1,
    siebenTageResetsAt: 9_000_000,
    gemessenAm: 500_000,
  }
  db.kontoNutzungSpeichern('zweit', stand, 'usage_api')
  let nutzung = db.kontoNutzungLesen()
  pruefe('Nutzung gespeichert',
    nutzung.zweit?.quelle === 'usage_api' &&
    nutzung.zweit?.stand.siebenTageAnteil === 1 &&
    nutzung.zweit?.stand.siebenTageResetsAt === 9_000_000 &&
    nutzung.zweit?.stand.fuenfStundenAnteil === 0.4 &&
    nutzung.zweit?.stand.gemessenAm === 500_000)

  // Erneutes Melden desselben Kontos ueberschreibt, verdoppelt nicht.
  db.kontoNutzungSpeichern('zweit', { ...stand, siebenTageAnteil: 0.7, gemessenAm: 600_000 }, 'rate_limit_event')
  nutzung = db.kontoNutzungLesen()
  pruefe('erneutes Melden ueberschreibt statt zu verdoppeln',
    nutzung.zweit?.stand.siebenTageAnteil === 0.7 && nutzung.zweit?.quelle === 'rate_limit_event' &&
    Object.keys(nutzung).length === 1)
  db.close()
}

// --- Nutzungsstand ueberlebt einen Neustart (neu geoeffnete DB) ---
{
  const db = new CockpitDb(dbPfad)
  const nutzung = db.kontoNutzungLesen()
  pruefe('nach Neu-Oeffnen: Nutzung bleibt erhalten',
    nutzung.zweit?.stand.siebenTageAnteil === 0.7 && nutzung.zweit?.quelle === 'rate_limit_event')
  db.close()
}

// --- Fremder Schreiber (z. B. sqlite3 in der Shell) haelt kurz die Sperre ---
// Ohne busy_timeout warf jeder Schreibzugriff sofort "database is locked" --
// aus einem Ereignis-Handler des Supervisors heraus beendete das den Daemon.
{
  const db = new CockpitDb(dbPfad)
  db.runAnlegen('gesperrt', 'l', '/tmp')
  const halter = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite')
    const d = new DatabaseSync(${JSON.stringify(dbPfad)})
    d.exec('BEGIN IMMEDIATE')
    d.exec("UPDATE runs SET label = 'fremd' WHERE run_id = 'gesperrt'")
    process.stdout.write('gesperrt\\n')
    setTimeout(() => { d.exec('COMMIT'); process.exit(0) }, 300)
  `], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((fertig) => halter.stdout.once('data', fertig))
  let fehler = null
  try { db.runBeenden('gesperrt', 'done', null) } catch (e) { fehler = String(e) }
  pruefe('Schreiben wartet auf fremde Sperre statt zu werfen', fehler === null)
  await new Promise((fertig) => halter.once('exit', fertig))
  db.close()
}

// --- Aufgaben-Bereich: Agenten und Ereignisse der letzten 24 h ---
{
  const db = new CockpitDb(dbPfad)
  const agent = (runId, agentId, startedAt, endedAt) => db.agentSpeichern({
    agentId, runId, role: 'chat', fachrolle: null, status: endedAt ? 'done' : 'running', sessionId: null,
    label: 'L', parentAgentId: null, model: null, cwd: '/tmp', startedAt, endedAt,
    weightedTokens: 0, rawTokens: 0, costUsd: 0, turns: 0, lastError: null,
  })
  agent('alt', 'a', 100, 200)
  agent('neu', 'a', 5000, 6000)
  agent('lang', 'a', 100, 5500)
  agent('offen', 'a', 100, null)
  const ids = db.agentenSeit(5000).map((r) => r.run_id).sort().join()
  pruefe('agentenSeit: neu begonnen, spaet geendet, noch offen -- nicht alt', ids === 'lang,neu,offen')
  db.runAnlegen('offen', 'Team: Suche bauen', '/tmp')
  const zeilen = db.agentenSeit(5000)
  pruefe('agentenSeit: Titel des Laufs dabei (sonst null)',
    zeilen.find((r) => r.run_id === 'offen')?.lauf_label === 'Team: Suche bauen' && zeilen.find((r) => r.run_id === 'neu')?.lauf_label === null)
  const ev = (seq, ts, kind) => db.ereignisSpeichern({
    seq, ts, runId: 'neu', agentId: 'a', sessionId: null, kind, parentToolUseId: null, summary: kind, payload: { n: seq },
  })
  ev(1, 100, 'tool_use'); ev(2, 5001, 'usage'); ev(3, 5002, 'tool_use'); ev(4, 5003, 'tool_result')
  const e = db.ereignisseArtSeit(5000, ['tool_use', 'tool_result'])
  pruefe('ereignisseArtSeit: nur Arten und Zeitraum, Payload gelesen',
    e.length === 2 && e[0].seq === 3 && e[1].kind === 'tool_result' && e[0].payload.n === 3)
  db.close()
}

rmSync(verzeichnis, { recursive: true, force: true })

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
