// Grenzen und Regeln hart durchsetzen: ein laufender Zug auf einem Konto an
// seiner Grenze wird unterbrochen, und ohne freies Konto startet gar nichts
// (kein Ausweichen auf die geerbte Anmeldung). Ohne echten CLI-Prozess.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const verzeichnis = mkdtempSync(join(tmpdir(), 'grenze-durchsetzen-'))
const anmelden = (dir) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }))
}
const haupt = join(verzeichnis, 'claude')
anmelden(haupt)
anmelden(join(verzeichnis, 'konten', 'freund'))
process.env.HOME = haupt
process.env.CLAUDE_CONFIG_DIR = haupt
process.env.COCKPIT_KONTEN_DIR = join(verzeichnis, 'konten')

const { CockpitDb } = await import('../dist/db.js')
const { Supervisor } = await import('../dist/supervisor.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

const db = new CockpitDb(join(verzeichnis, 'cockpit.db'))
const sup = new Supervisor(db)

const stand = (f5, w) => {
  const s = Math.floor(Date.now() / 1000)
  return {
    status: 'allowed', rateLimitType: null, resetsAt: null,
    fuenfStundenAnteil: f5, fuenfStundenResetsAt: s + 3600,
    siebenTageAnteil: w, siebenTageResetsAt: s + 4 * 86400, gemessenAm: Date.now(),
  }
}

/** Einen laufenden Versuch so anlegen, wie agentStarten es tut -- ohne CLI. */
function laufAnlegen(runId, konto) {
  db.runAnlegen(runId, 'test', '/tmp')
  const zustand = {
    runId, agentId: 'chat', role: 'chat', fachrolle: null, label: 'test', status: 'thinking', sessionId: null,
    parentAgentId: null, model: null, cwd: '/tmp', startedAt: Date.now(), endedAt: null,
    weightedTokens: 0, rawTokens: 0, costUsd: 0, turns: 0, lastError: null,
  }
  const k = sup.schluessel(runId, 'chat')
  sup.agenten.set(k, zustand)
  db.agentSpeichern(zustand)
  const versuch = { runId, agentId: 'chat', konto, abort: new AbortController(), grenze: null }
  sup.laufende.set(k, { abort: new AbortController(), versuch })
  return versuch
}

// --- laufender Zug wird an der Regel unterbrochen ---------------------------
sup.kontoRegelnSetzen('freund', [{ fenster: 'woche', rest: 0.4, tage: [], von: null, bis: null }])
sup.nutzungMelden('haupt', stand(0.1, 0.1), 'usage_api')
sup.nutzungMelden('freund', stand(0.1, 0.5), 'usage_api')
const aufFreund = laufAnlegen('lauf-freund', 'freund')
const aufHaupt = laufAnlegen('lauf-haupt', 'haupt')
pruefe('begrenztes Konto laeuft', sup.begrenztesKontoLaeuft() === true)
pruefe('unter der Regel: laeuft weiter', !aufFreund.abort.signal.aborted)

sup.nutzungMelden('freund', stand(0.1, 0.61), 'usage_api')
pruefe('ueber der Regel: Versuch abgebrochen', aufFreund.abort.signal.aborted)
pruefe('Grund ist die Regel (Woche)', aufFreund.grenze?.regel === true && aufFreund.grenze?.fenster === 'woche')
pruefe('Hauptkonto ohne Grenze laeuft weiter', !aufHaupt.abort.signal.aborted)
pruefe('Protokoll sagt "Grenze erreicht"',
  db.ereignisseSeit('lauf-freund', 0).some((e) => String(e.summary ?? e.zusammenfassung ?? JSON.stringify(e)).includes('Grenze erreicht')))

// Auch eine Messung aus dem laufenden Strom (rate_limit_event) greift.
sup.nutzungMelden('freund', stand(0.1, 0.1), 'usage_api')
const zweiter = laufAnlegen('lauf-freund-2', 'freund')
sup.nachrichtVerarbeiten('lauf-freund-2', 'chat', {
  type: 'rate_limit_event', session_id: 's1',
  rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.7, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } },
}, 'freund')
pruefe('rate_limit_event ueber der Regel: abgebrochen', zweiter.abort.signal.aborted)
sup.laufende.clear()

// --- kein Konto frei wegen Grenzen: nichts starten --------------------------
sup.kontoGrenzeSetzen('haupt', { fuenf: null, woche: 0.5 })
sup.nutzungMelden('haupt', stand(0.1, 0.55), 'usage_api')
sup.nutzungMelden('freund', stand(0.1, 0.65), 'usage_api')
db.runAnlegen('lauf-neu', 'test', '/tmp')
const vorher = Date.now()
const r = await sup.agentStarten({ runId: 'lauf-neu', agentId: 'chat', role: 'chat', label: 't', prompt: 'x', cwd: '/tmp' })
pruefe('alle an der Grenze: Zug endet sofort mit Fehler', /Grenze/.test(r.fehler ?? '') && Date.now() - vorher < 2000)
pruefe('Status waiting_ratelimit', sup.agentenListe('lauf-neu').find((a) => a.agentId === 'chat')?.status === 'waiting_ratelimit')
pruefe('nichts mehr als laufend vermerkt', sup.laufende.size === 0)

// Ohne Grenzen bleibt es beim alten Weg (kein Abbruch, keine Sperre durch Grenzen).
sup.kontoGrenzeSetzen('haupt', { fuenf: null, woche: null })
sup.kontoRegelnSetzen('freund', [])
pruefe('ohne Grenzen sperrt nichts', sup.konten.grenzeSperrtAlle() === null)
pruefe('ohne Grenzen kein begrenztes Konto', sup.konten.hatGrenzen('freund') === false)

db.db?.close?.()
rmSync(verzeichnis, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
