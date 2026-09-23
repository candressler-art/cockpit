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
  chatsIndizieren, chatLesen, fortsetzungLesen, fortsetzungVorbereiten, fortsetzungAktualisieren,
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

// --- chatLesen: Rauschen weg, assistant zusammengefasst ---------------------
{
  const d = await chatLesen(dbPfad, sessionId)
  pruefe('Sitzung gefunden', d !== null)
  pruefe('genau zwei Beitraege (Frage + zusammengefasste Antwort)', d?.beitraege.length === 2)
  pruefe('task-notification nicht im Verlauf', !d?.beitraege.some((b) => b.text.includes('task-notification')))
  pruefe('isMeta-Zeile nicht im Verlauf', !d?.beitraege.some((b) => b.text.includes('sollte nie erscheinen')))
  pruefe(
    'isSidechain-Zeile nicht im Verlauf',
    !d?.beitraege.some((b) => b.text.includes('sollte auch nie erscheinen')),
  )
  const frage = d?.beitraege[0]
  pruefe('erster Beitrag ist die Nutzerfrage', frage?.rolle === 'user')
  pruefe('system-reminder aus der Frage entfernt', !frage?.text.includes('system-reminder'))
  pruefe('system-reminder aus der Frage entfernt', !frage?.text.includes('Betriebsrauschen'))
  pruefe('echter Text der Frage bleibt', frage?.text === 'Echte Frage')
  const antwort = d?.beitraege[1]
  pruefe('zweiter Beitrag ist die Antwort', antwort?.rolle === 'assistant')
  pruefe('beide Teile stehen in der zusammengefassten Antwort', antwort?.text.includes('Teil eins der Antwort.'))
  pruefe('beide Teile stehen in der zusammengefassten Antwort', antwort?.text.includes('Teil zwei der Antwort.'))
  pruefe('nicht gekuerzt bei nur zwei Beitraegen', d?.gekuerzt === false)
}

// --- chatLesen: synthetische "No response requested." nach einem Limit-
// Abbruch weglassen (servertwo-Fund: steht nach jedem Nutzungslimit-Abbruch
// im Verlauf und ist kein echter Beitrag) -------------------------------
{
  const sessionId2 = randomUUID()
  mkdirSync(join(spiegel, projektOrdner), { recursive: true })
  const spiegelDatei2 = join(spiegel, projektOrdner, `${sessionId2}.jsonl`)
  const zeilen2 = [
    JSON.stringify({
      type: 'user', timestamp: zeit(0), cwd: desktopCwd,
      message: { content: 'Frage vor dem Limit' },
    }),
    // Genau diese Zeile traegt die CLI nach einem Limit-Abbruch synthetisch
    // nach -- kein echter Beitrag, muss weg.
    JSON.stringify({
      type: 'assistant', timestamp: zeit(1000),
      message: { content: [{ type: 'text', text: 'No response requested.' }] },
    }),
    // Aehnlicher, aber NICHT identischer Text -- exakter Vergleich, soll bleiben.
    JSON.stringify({
      type: 'assistant', timestamp: zeit(1500),
      message: { content: [{ type: 'text', text: 'No response requested. Aber hier noch mehr.' }] },
    }),
  ]
  writeFileSync(spiegelDatei2, zeilen2.join('\n') + '\n', 'utf-8')
  await chatsIndizieren(dbPfad)

  const d = await chatLesen(dbPfad, sessionId2)
  pruefe('zweite Sitzung gefunden', d !== null)
  pruefe(
    'exakte "No response requested." nicht im Verlauf',
    !d?.beitraege.some((b) => b.text === 'No response requested.'),
  )
  pruefe(
    'aehnlicher, aber nicht identischer Text bleibt (exakter Vergleich)',
    d?.beitraege.some((b) => b.text.includes('No response requested. Aber hier noch mehr.')),
  )
  pruefe('genau zwei Beitraege (Frage + die nicht-synthetische Antwort)', d?.beitraege.length === 2)
}

// --- chatLesen: Nutzungslimit-Meldung ist kein echter Beitrag (Fund aus dem
// Live-Betrieb: "weiter" wurde scheinbar mit der Limitmeldung beantwortet,
// dabei folgte kurz danach per Kontowechsel die echte Antwort) -------------
{
  const sessionId3 = randomUUID()
  mkdirSync(join(spiegel, projektOrdner), { recursive: true })
  const spiegelDatei3 = join(spiegel, projektOrdner, `${sessionId3}.jsonl`)
  const zeilen3 = [
    JSON.stringify({
      type: 'user', timestamp: zeit(0), cwd: desktopCwd,
      message: { content: 'weiter' },
    }),
    // Das Hauptkonto laeuft sofort ins Limit -- steht als ganz normaler
    // Assistant-Textblock in der Sitzung (siehe supervisor.ts), bevor der
    // Kontowechsel greift.
    JSON.stringify({
      type: 'assistant', timestamp: zeit(500),
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 8:10pm" }] },
    }),
    // Nach dem Kontowechsel: die echte Antwort des zweiten Kontos.
    JSON.stringify({
      type: 'assistant', timestamp: zeit(35000),
      message: { content: [{ type: 'text', text: 'Hier ist die richtige Antwort.' }] },
    }),
  ]
  writeFileSync(spiegelDatei3, zeilen3.join('\n') + '\n', 'utf-8')
  await chatsIndizieren(dbPfad)

  const d = await chatLesen(dbPfad, sessionId3)
  pruefe('dritte Sitzung gefunden', d !== null)
  pruefe('genau zwei Beitraege (Frage + echte Antwort, Limitmeldung weg)', d?.beitraege.length === 2)
  pruefe(
    'Limitmeldung nicht im Verlauf, weil nicht der letzte Beitrag',
    !d?.beitraege.some((b) => b.text.includes("You've hit your session limit")),
  )
  pruefe('zweiter Beitrag ist die echte Antwort', d?.beitraege[1]?.text === 'Hier ist die richtige Antwort.')
  pruefe('zweiter Beitrag bleibt rolle assistant, keine Umdeutung', d?.beitraege[1]?.rolle === 'assistant')
}

// --- chatLesen: Limitmeldung AM ENDE der Sitzung bleibt als Hinweis stehen -
{
  const sessionId4 = randomUUID()
  mkdirSync(join(spiegel, projektOrdner), { recursive: true })
  const spiegelDatei4 = join(spiegel, projektOrdner, `${sessionId4}.jsonl`)
  const zeilen4 = [
    JSON.stringify({
      type: 'user', timestamp: zeit(0), cwd: desktopCwd,
      message: { content: 'Noch eine Frage' },
    }),
    // Die Sitzung endet HIER mit dem Limit -- kein Kontowechsel mehr
    // aufgezeichnet (z.B. weil auch das letzte Konto gesperrt war).
    JSON.stringify({
      type: 'assistant', timestamp: zeit(500),
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 9:00pm" }] },
    }),
  ]
  writeFileSync(spiegelDatei4, zeilen4.join('\n') + '\n', 'utf-8')
  await chatsIndizieren(dbPfad)

  const d = await chatLesen(dbPfad, sessionId4)
  pruefe('vierte Sitzung gefunden', d !== null)
  pruefe('genau zwei Beitraege (Frage + Hinweis)', d?.beitraege.length === 2)
  const hinweis = d?.beitraege[1]
  pruefe('letzter Beitrag hat rolle hinweis, keine falsche Antwort', hinweis?.rolle === 'hinweis')
  pruefe('Hinweistext nennt das Limit', hinweis?.text.includes("You've hit your session limit"))
}

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

// --- chatLesen liest danach die Kopie, nicht mehr den Spiegel ---------------
{
  const zusatz = JSON.stringify({
    type: 'assistant', timestamp: zeit(3000),
    message: { content: [{ type: 'text', text: 'Nur in der Kopie vorhanden.' }] },
  })
  writeFileSync(zielDatei, spiegelInhalt + zusatz + '\n', 'utf-8')

  const d = await chatLesen(dbPfad, sessionId)
  pruefe('chatLesen sieht den Zusatz aus der Kopie', d?.beitraege.some((b) => b.text.includes('Nur in der Kopie vorhanden.')))
  pruefe('Spiegeldatei wurde dabei nicht angefasst', readFileSync(spiegelDatei, 'utf-8') === spiegelInhalt)
}

// --- fortsetzungAktualisieren: neue Session-Id nach einem Zug ---------------
{
  const neueSession = randomUUID()
  fortsetzungAktualisieren(dbPfad, sessionId, neueSession)
  const gelesen = fortsetzungLesen(dbPfad, sessionId)
  pruefe('fortsetzungAktualisieren traegt die neue Session-Id ein', gelesen?.aktuelleSession === neueSession)
  pruefe('laufId und cwd bleiben beim Aktualisieren unveraendert', gelesen?.laufId === f.laufId && gelesen?.cwd === f.cwd)
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
