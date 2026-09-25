// Gedaechtnis der Fachrollen (src/gedaechtnis.ts): automatische Freigabe nur
// innerhalb der Wurzel, auch ueber den Symlink eines Zusatzkontos, und der
// Prompt-Abschnitt fuer Orchestrator-Worker. Gegen dist/.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { gedaechtnisZugriffErlaubt, gedaechtnisVorspann, gedaechtnisOrdnerAnlegen } from '../dist/gedaechtnis.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'gedaechtnis-'))
const wurzel = join(tmp, 'haupt', 'agent-memory')
mkdirSync(join(wurzel, 'coder'), { recursive: true })
// Zusatzkonto wie nach deploy/konto-hinzufuegen.sh: agent-memory ist ein Symlink.
mkdirSync(join(tmp, 'zweit'))
symlinkSync(wurzel, join(tmp, 'zweit', 'agent-memory'))
const erlaubt = (tool, input) => gedaechtnisZugriffErlaubt(tool, input, wurzel)

// --- Freigabe -------------------------------------------------------------------
pruefe('Write innerhalb', erlaubt('Write', { file_path: join(wurzel, 'coder', 'notiz.md'), content: 'x' }))
pruefe('Edit innerhalb', erlaubt('Edit', { file_path: join(wurzel, 'coder', 'MEMORY.md') }))
pruefe('Read innerhalb', erlaubt('Read', { file_path: join(wurzel, 'coder', 'MEMORY.md') }))
pruefe('Glob mit Pfad innerhalb', erlaubt('Glob', { pattern: '*.md', path: join(wurzel, 'coder') }))
pruefe('neue Rolle, Verzeichnis gibt es noch nicht', erlaubt('Write', { file_path: join(wurzel, 'gestalter', 'MEMORY.md') }))
pruefe('neue Datei ueber den Symlink des Zusatzkontos',
  erlaubt('Write', { file_path: join(tmp, 'zweit', 'agent-memory', 'coder', 'neu.md') }))
pruefe('Write ausserhalb abgelehnt', !erlaubt('Write', { file_path: join(tmp, 'haupt', 'settings.json') }))
pruefe('Ausbruch mit .. abgelehnt', !erlaubt('Write', { file_path: join(wurzel, 'coder', '..', '..', 'x.md') }))
pruefe('Nachbar mit gleichem Praefix abgelehnt', !erlaubt('Write', { file_path: join(tmp, 'haupt', 'agent-memory-boese', 'x.md') }))
pruefe('Bash nie', !erlaubt('Bash', { command: `echo x > ${join(wurzel, 'coder', 'x.md')}` }))
pruefe('ohne Pfad abgelehnt', !erlaubt('Write', { content: 'x' }) && !erlaubt('Glob', { pattern: '**' }))
// Gedaechtnis des Chats selbst: nur projects/<projekt>/memory/, nicht die Verlaeufe daneben.
const projekte = join(tmp, 'haupt', 'projects')
mkdirSync(join(projekte, '-home-claude'), { recursive: true })
symlinkSync(projekte, join(tmp, 'zweit', 'projects'))
const chat = (tool, input) => gedaechtnisZugriffErlaubt(tool, input, wurzel, projekte)
pruefe('Chat-Gedaechtnis: neue Notiz', chat('Write', { file_path: join(projekte, '-home-claude', 'memory', 'notiz.md') }))
pruefe('Chat-Gedaechtnis: ueber den Symlink des Zusatzkontos',
  chat('Write', { file_path: join(tmp, 'zweit', 'projects', '-home-claude', 'memory', 'MEMORY.md') }))
pruefe('Sitzungsverlauf daneben abgelehnt', !chat('Write', { file_path: join(projekte, '-home-claude', 'abc.jsonl') }))
pruefe('projects/ selbst abgelehnt', !chat('Write', { file_path: join(projekte, 'memory') }) && !chat('Glob', { pattern: '**', path: projekte }))
pruefe('memory tiefer verschachtelt abgelehnt', !chat('Write', { file_path: join(projekte, '-home-claude', 'x', 'memory', 'n.md') }))
pruefe('Ausbruch aus projects/ abgelehnt', !chat('Write', { file_path: join(projekte, '..', 'memory', 'n.md') }))

// Ein Symlink IN der Wurzel, der hinauszeigt, darf nicht als innerhalb gelten.
symlinkSync(tmp, join(wurzel, 'coder', 'raus'))
pruefe('Symlink aus der Wurzel heraus abgelehnt', !erlaubt('Write', { file_path: join(wurzel, 'coder', 'raus', 'x.md') }))

// --- Vorspann fuer Orchestrator-Worker -------------------------------------------
const leer = gedaechtnisVorspann('pruefer', wurzel)
pruefe('ohne MEMORY.md: Pfad und Hinweis', leer.includes(join(wurzel, 'pruefer')) && /noch nicht/.test(leer))
writeFileSync(join(wurzel, 'coder', 'MEMORY.md'), '- [Build](build.md) -- npm run build vor npm test\n')
const voll = gedaechtnisVorspann('coder', wurzel)
pruefe('mit MEMORY.md: Index im Prompt', voll.includes('npm run build vor npm test') && !/noch nicht/.test(voll))
writeFileSync(join(wurzel, 'coder', 'MEMORY.md'), Array.from({ length: 250 }, (_, i) => `zeile ${i + 1}`).join('\n'))
const lang = gedaechtnisVorspann('coder', wurzel)
pruefe('nach 200 Zeilen abgeschnitten', lang.includes('zeile 200') && !lang.includes('zeile 201'))

// --- Ordner beim Start ------------------------------------------------------------
gedaechtnisOrdnerAnlegen(['admin', 'coder'], wurzel)
pruefe('Ordner je Rolle angelegt, vorhandener bleibt', existsSync(join(wurzel, 'admin')) && existsSync(join(wurzel, 'coder', 'MEMORY.md')))

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
