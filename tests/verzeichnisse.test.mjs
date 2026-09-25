// Ordnerwahl: ordnerAuflisten (src/verzeichnisse.ts) und die zuletzt
// benutzten Arbeitsordner aus dem Chat-Index. Gegen dist/.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const wurzel = mkdtempSync(join(tmpdir(), 'cockpit-verz-test-'))
process.env.COCKPIT_SESSIONS = join(wurzel, 'spiegel')
process.env.CLAUDE_CONFIG_DIR = join(wurzel, 'claude')
const { ordnerAuflisten, OrdnerFehler, ORDNER_HOECHSTENS } = await import('../dist/verzeichnisse.js')
const { chatsSuchen, zuletztBenutzteOrdner } = await import('../dist/chats.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}
const fehlerVon = async (f) => { try { await f(); return null } catch (e) { return e } }

// --- Auflisten ----------------------------------------------------------------
const b = join(wurzel, 'baum')
for (const d of ['beta', 'Alpha', 'gamma/tief', '.git', 'Äpfel']) mkdirSync(join(b, d), { recursive: true })
writeFileSync(join(b, 'datei.txt'), 'x')
symlinkSync(join(b, 'beta'), join(b, 'link-auf-beta'))
symlinkSync(join(b, 'weg'), join(b, 'kaputt'))
symlinkSync(join(b, 'datei.txt'), join(b, 'link-auf-datei'))
{
  const l = await ordnerAuflisten(b + '/')
  pruefe('Pfad ohne Schraegstrich am Ende', l.pfad === b)
  pruefe('Eltern', l.eltern === wurzel)
  pruefe('nur Ordner, sortiert, ohne versteckte, Link auf Ordner dabei',
    JSON.stringify(l.ordner.map((o) => o.name)) === '["Alpha","Äpfel","beta","gamma","link-auf-beta"]')
  pruefe('volle Pfade', l.ordner[0].pfad === join(b, 'Alpha'))
  pruefe('nicht gekuerzt', l.gekuerzt === false)
  const v = await ordnerAuflisten(b, true)
  pruefe('versteckte auf Wunsch', v.ordner.some((o) => o.name === '.git'))
}
pruefe('Wurzel hat keine Eltern', (await ordnerAuflisten('/')).eltern === null)
pruefe('Pfad normalisiert', (await ordnerAuflisten(join(b, 'gamma', '..'))).pfad === b)
{
  const e = await fehlerVon(() => ordnerAuflisten('relativ/pfad'))
  pruefe('relativ -> 400', e instanceof OrdnerFehler && e.status === 400)
  const e2 = await fehlerVon(() => ordnerAuflisten(''))
  pruefe('leer -> 400', e2 instanceof OrdnerFehler && e2.status === 400)
  const e3 = await fehlerVon(() => ordnerAuflisten(join(b, 'gibtsnicht')))
  pruefe('fehlt -> 404', e3 instanceof OrdnerFehler && e3.status === 404)
  const e4 = await fehlerVon(() => ordnerAuflisten(join(b, 'datei.txt')))
  pruefe('Datei -> 400', e4 instanceof OrdnerFehler && e4.status === 400)
  if (process.getuid?.() !== 0) {
    const zu = join(b, 'gamma')
    chmodSync(zu, 0o000)
    const e5 = await fehlerVon(() => ordnerAuflisten(zu))
    chmodSync(zu, 0o755)
    pruefe('keine Rechte -> 403', e5 instanceof OrdnerFehler && e5.status === 403)
  }
}
{
  const viel = join(wurzel, 'viel')
  for (let i = 0; i < ORDNER_HOECHSTENS + 3; i++) mkdirSync(join(viel, `o${i}`), { recursive: true })
  const l = await ordnerAuflisten(viel)
  pruefe('Deckel', l.ordner.length === ORDNER_HOECHSTENS && l.gekuerzt === true)
}

// --- Zuletzt benutzt ----------------------------------------------------------
{
  const dbPfad = join(wurzel, 'cockpit.db')
  chatsSuchen(dbPfad, '') // legt das Schema an
  const h = new DatabaseSync(dbPfad)
  const rein = h.prepare(
    `INSERT INTO chats (session_id, pfad, titel, cwd, started_at, ended_at, entrypoint) VALUES (?,?,?,?,?,?,?)`,
  )
  rein.run('a', '/x/a', 'A', '/p/alt', 1000, 2000, 'cli')
  rein.run('b', '/x/b', 'B', '/p/neu', 5000, 9000, 'claude-desktop')
  rein.run('c', '/x/c', 'C', '/p/alt', 3000, null, 'cli')
  rein.run('d', '/x/d', 'D', '/p/worker', 1, 99999, 'sdk-ts')
  rein.run('e', '/x/e', 'E', null, 1, 50000, 'cli')
  h.close()
  const z = zuletztBenutzteOrdner(dbPfad)
  pruefe('neueste zuerst, ohne Doppelte, ohne Worker, ohne leeren cwd', JSON.stringify(z) === '["/p/neu","/p/alt"]')
  pruefe('Grenze', zuletztBenutzteOrdner(dbPfad, 1).length === 1)
}

rmSync(wurzel, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
