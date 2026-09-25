// Testet die Chat-Fortsetzung gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/chats.test.mjs`.
//
// COCKPIT_SESSIONS (Spiegel) und CLAUDE_CONFIG_DIR (wohin fortgesetzt wird)
// muessen VOR dem dynamischen Import stehen -- chats.js liest sie beim ersten
// Aufruf der Modulfunktionen, nicht bei jedem Aufruf neu.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

const wurzel = mkdtempSync(join(tmpdir(), 'cockpit-chats-test-'))
const spiegel = join(wurzel, 'spiegel')
const claudeConfig = join(wurzel, 'claude-config')
const dbPfad = join(wurzel, 'cockpit.db')

process.env.COCKPIT_SESSIONS = spiegel
process.env.CLAUDE_CONFIG_DIR = claudeConfig

const {
  chatsIndizieren, verlaufLesen, fortsetzungLesen, fortsetzungVorbereiten, fortsetzungAktualisieren, chatFuerSitzung,
} = await import('../dist/chats.js')
const { vaultZugriffErlaubt } = await import('../dist/vaultZugriff.js')

// --- Kuenstliche Sitzung mit Rauschen anlegen -------------------------------
//
// cwd zeigt absichtlich auf einen Pfad, der auf DIESEM Host nicht existiert
// -- genau der Normalfall bei einer vom Desktop gespiegelten Sitzung
// (Fakten-Lage, siehe Auftrag). fortsetzungVorbereiten muss dann auf den
// Ersatz ausweichen, nicht auf diesem Pfad bestehen.
const sessionId = randomUUID()
const desktopCwd = '/home/desktop-user/projekte/nicht-vorhanden-' + randomUUID().slice(0, 8)
const projektOrdner = 'test-projekt'
mkdirSync(join(spiegel, projektOrdner), { recursive: true })
const spiegelDatei = join(spiegel, projektOrdner, `${sessionId}.jsonl`)

const zeit = (offset) => new Date(Date.now() + offset).toISOString()
const zeilen = [
  // Echte erste Frage, mit eingebettetem system-reminder -- der muss weg,
  // die eigentliche Frage muss bleiben.
  JSON.stringify({
    type: 'user', timestamp: zeit(0), cwd: desktopCwd,
    message: { content: '<system-reminder>internes Betriebsrauschen</system-reminder>\nEchte Frage' },
  }),
  // Rauschen der CLI selbst -- muss verworfen werden.
  JSON.stringify({
    type: 'user', timestamp: zeit(1000),
    message: { content: '<task-notification>irrelevant</task-notification>' },
  }),
  // Metazeile -- muss verworfen werden, obwohl sie type 'assistant' traegt.
  JSON.stringify({
    type: 'assistant', timestamp: zeit(1500), isMeta: true,
    message: { content: [{ type: 'text', text: 'sollte nie erscheinen' }] },
  }),
  // Nebenzweig (Subagenten-Kontext) -- muss verworfen werden.
  JSON.stringify({
    type: 'user', timestamp: zeit(1800), isSidechain: true,
    message: { content: 'sollte auch nie erscheinen' },
  }),
  // Zwei aufeinanderfolgende assistant-Zuege -- eine CLI-Fortsetzung ueber die
  // Ausgabegrenze, muss zu EINEM Beitrag zusammengefasst werden.
  JSON.stringify({
    type: 'assistant', timestamp: zeit(2000),
    message: { content: [{ type: 'text', text: 'Teil eins der Antwort.' }] },
  }),
  JSON.stringify({
    type: 'assistant', timestamp: zeit(2200),
    message: { content: [{ type: 'text', text: 'Teil zwei der Antwort.' }] },
  }),
]
const spiegelInhalt = zeilen.join('\n') + '\n'
writeFileSync(spiegelDatei, spiegelInhalt, 'utf-8')

await chatsIndizieren(dbPfad)

// --- fortsetzungVorbereiten: Kopie an richtiger Stelle, Spiegel unveraendert ---
const ersatzCwd = join(wurzel, 'ersatz-cwd')
mkdirSync(ersatzCwd, { recursive: true })
const projektSchluessel = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const zielDatei = join(claudeConfig, 'projects', projektSchluessel(ersatzCwd), `${sessionId}.jsonl`)

let f
{
  f = await fortsetzungVorbereiten(dbPfad, sessionId, ersatzCwd)
  pruefe('fortsetzungVorbereiten liefert ein Ergebnis', f !== null)
  pruefe('cwd der Sitzung existiert hier nicht -> Ersatz-cwd verwendet', f?.cwd === ersatzCwd)
  pruefe('laufId ist der Pseudo-Lauf chat-<sessionId>', f?.laufId === `chat-${sessionId}`)
  pruefe('aktuelleSession ist zunaechst die urspruengliche Session-Id', f?.aktuelleSession === sessionId)
  pruefe('Zieldatei wurde an der erwarteten Stelle angelegt', existsSync(zielDatei))
  pruefe('Zieldatei ist eine Kopie des Spiegels', readFileSync(zielDatei, 'utf-8') === spiegelInhalt)
  pruefe('Spiegeldatei blieb unveraendert', readFileSync(spiegelDatei, 'utf-8') === spiegelInhalt)
}

{
  // Zweiter Aufruf: dieselbe Zeile, keine zweite Kopieraktion (kein Ueberschreiben
  // einer inzwischen fortgeschriebenen Datei mit dem alten Spiegelstand).
  const vorMtime = readFileSync(zielDatei, 'utf-8')
  const f2 = await fortsetzungVorbereiten(dbPfad, sessionId, '/ein/anderer/ersatz/pfad')
  pruefe('zweiter Aufruf liefert dieselbe laufId', f2?.laufId === f.laufId)
  pruefe('zweiter Aufruf liefert dieselbe cwd (nicht den neuen Ersatzpfad)', f2?.cwd === ersatzCwd)
  pruefe('zweiter Aufruf liefert dieselbe aktuelleSession', f2?.aktuelleSession === f.aktuelleSession)
  pruefe('Zieldatei unveraendert durch den zweiten Aufruf', readFileSync(zielDatei, 'utf-8') === vorMtime)
}

// --- verlaufLesen liest danach die Kopie, nicht mehr den Spiegel ------------
{
  const zusatz = JSON.stringify({
    type: 'assistant', timestamp: zeit(3000),
    message: { content: [{ type: 'text', text: 'Nur in der Kopie vorhanden.' }] },
  })
  writeFileSync(zielDatei, spiegelInhalt + zusatz + '\n', 'utf-8')

  const d = await verlaufLesen(dbPfad, sessionId)
  pruefe('verlaufLesen sieht den Zusatz aus der Kopie', JSON.stringify(d?.nachrichten ?? []).includes('Nur in der Kopie vorhanden.'))
  pruefe('Spiegeldatei wurde dabei nicht angefasst', readFileSync(spiegelDatei, 'utf-8') === spiegelInhalt)
}

// --- fortsetzungAktualisieren: neue Session-Id nach einem Zug ---------------
{
  const neueSession = randomUUID()
  fortsetzungAktualisieren(dbPfad, sessionId, neueSession)
  const gelesen = fortsetzungLesen(dbPfad, sessionId)
  pruefe('fortsetzungAktualisieren traegt die neue Session-Id ein', gelesen?.aktuelleSession === neueSession)
  pruefe('laufId und cwd bleiben beim Aktualisieren unveraendert', gelesen?.laufId === f.laufId && gelesen?.cwd === f.cwd)
  // Rueckblick der Nutzung: Sitzungs-Id -> Chat, auch ueber die Fortsetzung.
  pruefe('chatFuerSitzung: direkte Id', chatFuerSitzung(dbPfad, sessionId)?.id === sessionId)
  pruefe('chatFuerSitzung: fortgesetzte Sitzung fuehrt zum Chat', chatFuerSitzung(dbPfad, neueSession)?.id === sessionId)
  pruefe('chatFuerSitzung: unbekannt -> null', chatFuerSitzung(dbPfad, 'gibt-es-nicht') === null)
}

// --- vaultZugriffErlaubt: automatische Freigabe nur fuer Lesezugriffe -----
// tatsaechlich UNTERHALB des Vaults -----------------------------------------
{
  const vaultWurzel = join(wurzel, 'vault')
  mkdirSync(vaultWurzel, { recursive: true })
  const notizPfad = join(vaultWurzel, 'notiz.md')
  writeFileSync(notizPfad, '# Notiz', 'utf-8')
  // Nachbarordner mit gleichem Praefix -- OHNE Trenner wuerde ein reiner
  // startsWith-Vergleich das hier faelschlich als "innerhalb" durchlassen.
  const nachbarWurzel = vaultWurzel + '-anderes-projekt'
  mkdirSync(nachbarWurzel, { recursive: true })
  const nachbarDatei = join(nachbarWurzel, 'geheim.md')
  writeFileSync(nachbarDatei, 'geheim', 'utf-8')

  pruefe(
    'Read innerhalb des Vaults erlaubt',
    vaultZugriffErlaubt('Read', { file_path: notizPfad }, vaultWurzel) === true,
  )
  pruefe(
    'Glob mit path innerhalb des Vaults erlaubt',
    vaultZugriffErlaubt('Glob', { path: vaultWurzel, pattern: '**/*.md' }, vaultWurzel) === true,
  )
  pruefe(
    'Grep mit path innerhalb des Vaults erlaubt',
    vaultZugriffErlaubt('Grep', { path: notizPfad, pattern: 'Notiz' }, vaultWurzel) === true,
  )
  pruefe(
    'Nachbarverzeichnis mit gleichem Namenspraefix NICHT erlaubt',
    vaultZugriffErlaubt('Read', { file_path: nachbarDatei }, vaultWurzel) === false,
  )
  pruefe(
    '..-Ausbruch aus dem Vault NICHT erlaubt',
    vaultZugriffErlaubt('Read', { file_path: join(vaultWurzel, '..', 'vault-anderes-projekt', 'geheim.md') }, vaultWurzel) === false,
  )
  pruefe(
    'Write-Werkzeug NICHT automatisch erlaubt, auch nicht im Vault',
    vaultZugriffErlaubt('Write', { file_path: notizPfad, content: 'x' }, vaultWurzel) === false,
  )
  pruefe(
    'Grep ohne path NICHT automatisch erlaubt',
    vaultZugriffErlaubt('Grep', { pattern: 'Notiz' }, vaultWurzel) === false,
  )
  pruefe(
    'Bash-Werkzeug NICHT automatisch erlaubt',
    vaultZugriffErlaubt('Bash', { command: `cat ${notizPfad}` }, vaultWurzel) === false,
  )
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
