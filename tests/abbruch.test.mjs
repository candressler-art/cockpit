// Abbruch eines Agenten: 'stopped' muss der Endzustand bleiben.
//
// Anlass (Durchgang 17): Ein ueber /api/abbrechen gestoppter Einzellauf
// stand hinterher als 'failed' ("Operation aborted") in der Datenbank. Der
// abgebrochene Nachrichtenstrom lieferte noch eine gepufferte Textnachricht,
// nachrichtVerarbeiten setzte daraufhin 'writing' ueber 'stopped', und der
// Schutz in endzustandSetzen griff danach nicht mehr.
//
// Konten-Verzeichnisse auf leere Temp-Ordner, bevor supervisor.js geladen
// wird -- sonst liest der Test die echten Konten dieses Rechners.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const verzeichnis = mkdtempSync(join(tmpdir(), 'nachtschicht-abbruch-'))
process.env.COCKPIT_KONTEN_DIR = join(verzeichnis, 'konten')
process.env.CLAUDE_CONFIG_DIR = join(verzeichnis, 'claude')

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

/** Einen "laufenden" Agenten so anlegen, wie agentStarten es tut -- ohne echten CLI-Prozess. */
function agentAnlegen(runId, agentId) {
  db.runAnlegen(runId, 'test', '/tmp')
  const zustand = {
    runId, agentId, role: 'chat', fachrolle: null, label: 'test', status: 'thinking', sessionId: null,
    parentAgentId: null, model: null, cwd: '/tmp', startedAt: Date.now(), endedAt: null,
    weightedTokens: 0, rawTokens: 0, costUsd: 0, turns: 0, lastError: null,
  }
  const k = sup.schluessel(runId, agentId)
  sup.agenten.set(k, zustand)
  db.agentSpeichern(zustand)
  const abort = new AbortController()
  sup.laufende.set(k, { abort })
  return { k, abort }
}

const textNachricht = {
  type: 'assistant', session_id: 's1',
  message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
}

// --- Nachricht nach dem Abbruch ueberschreibt 'stopped' nicht ---------------
{
  const { k } = agentAnlegen('lauf-1', 'chat')
  pruefe('agentAbbrechen meldet Erfolg', sup.agentAbbrechen('lauf-1', 'chat') === true)
  sup.nachrichtVerarbeiten('lauf-1', 'chat', textNachricht)
  pruefe('spaete Textnachricht laesst Status auf stopped', sup.agenten.get(k).status === 'stopped')
  // Danach der Fehlerpfad aus einzelnerVersuch (catch -> endzustandSetzen).
  sup.endzustandSetzen('lauf-1', 'chat', { status: 'failed', endedAt: Date.now(), lastError: 'Operation aborted' })
  pruefe('Endzustand bleibt stopped', sup.agenten.get(k).status === 'stopped')
  const inDb = db.agentenLesen('lauf-1').find((a) => a.agent_id === 'chat')
  pruefe('auch in der Datenbank stopped', inDb?.status === 'stopped')
  pruefe('Ereignis selbst wird trotzdem protokolliert', db.ereignisseSeit('lauf-1', 0).some((e) => e.kind === 'text'))
}

// --- ohne Abbruch aendert die Nachricht den Status wie bisher ---------------
{
  const { k } = agentAnlegen('lauf-2', 'chat')
  sup.nachrichtVerarbeiten('lauf-2', 'chat', textNachricht)
  pruefe('ohne Abbruch: Textnachricht setzt writing', sup.agenten.get(k).status === 'writing')
}

db.db?.close?.()
rmSync(verzeichnis, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
