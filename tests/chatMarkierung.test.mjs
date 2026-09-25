// Chat umbenennen, anheften, aus der Liste nehmen (src/chats.ts,
// chatMarkieren). Nur Cockpit-Eintraege -- die Sitzungsdatei bleibt, und die
// Markierung ueberlebt einen Neubau des Index. Gegen dist/.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const wurzel = mkdtempSync(join(tmpdir(), 'cockpit-markierung-test-'))
process.env.COCKPIT_SESSIONS = join(wurzel, 'spiegel')
process.env.CLAUDE_CONFIG_DIR = join(wurzel, 'claude')
const { chatsSuchen, chatMarkieren, chatKopfLesen, chatFuerSitzung, chatRegistrieren } = await import('../dist/chats.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}
const ids = (l) => l.map((c) => c.sessionId).join(',')

const dbPfad = join(wurzel, 'cockpit.db')
chatsSuchen(dbPfad, '') // legt das Schema an
const h = new DatabaseSync(dbPfad)
const rein = h.prepare(
  `INSERT INTO chats (session_id, pfad, titel, cwd, started_at, ended_at, entrypoint) VALUES (?,?,?,?,?,?,?)`,
)
const fts = h.prepare('INSERT INTO chats_fts (session_id, titel, eingaben) VALUES (?,?,?)')
const jetzt = Date.now()
rein.run('a', '/x/a', 'Alter Chat', '/p', jetzt - 90_000, jetzt - 80_000, 'cli')
rein.run('b', '/x/b', 'Mittlerer Chat', '/p', jetzt - 50_000, jetzt - 40_000, 'cli')
rein.run('c', '/x/c', 'Neuer Chat', '/p', jetzt - 20_000, jetzt - 10_000, 'cli')
fts.run('a', 'Alter Chat', 'erste Frage zu Rezepten')
fts.run('b', 'Mittlerer Chat', 'Frage zum Server')
fts.run('c', 'Neuer Chat', 'noch eine Frage')

pruefe('Ausgangslage: neueste zuerst', ids(chatsSuchen(dbPfad, '')) === 'c,b,a')
pruefe('unbekannte Id -> false', chatMarkieren(dbPfad, 'gibtsnicht', { angeheftet: true }) === false)

// --- Umbenennen -----------------------------------------------------------------
pruefe('umbenennen -> true', chatMarkieren(dbPfad, 'a', { titel: '  Kochbuch  ' }) === true)
pruefe('Liste zeigt neuen Titel (getrimmt)', chatsSuchen(dbPfad, '').find((c) => c.sessionId === 'a')?.titel === 'Kochbuch')
pruefe('Kopf zeigt neuen Titel', chatKopfLesen(dbPfad, 'a')?.titel === 'Kochbuch')
pruefe('Zuordnung (Nutzung/Meldungen) zeigt neuen Titel', chatFuerSitzung(dbPfad, 'a')?.titel === 'Kochbuch')
pruefe('Suche findet eigenen Titel', ids(chatsSuchen(dbPfad, 'kochb')) === 'a')
pruefe('Suche findet weiter die Eingaben', ids(chatsSuchen(dbPfad, 'rezepte')) === 'a')
chatMarkieren(dbPfad, 'a', { titel: 'x'.repeat(500) })
pruefe('Titel gedeckelt', chatKopfLesen(dbPfad, 'a')?.titel.length === 120)
chatMarkieren(dbPfad, 'a', { titel: '' })
pruefe('leerer Titel -> Original zurueck', chatKopfLesen(dbPfad, 'a')?.titel === 'Alter Chat')

// --- Anheften -------------------------------------------------------------------
chatMarkieren(dbPfad, 'a', { angeheftet: true })
{
  const l = chatsSuchen(dbPfad, '')
  pruefe('angeheftet steht oben', ids(l) === 'a,c,b')
  pruefe('Kennzeichen angeheftet', l[0].angeheftet === true && l[1].angeheftet === false)
}
chatMarkieren(dbPfad, 'a', { titel: 'Kochbuch' })
pruefe('Umbenennen laesst Anheften stehen', chatsSuchen(dbPfad, '')[0].sessionId === 'a')
chatMarkieren(dbPfad, 'a', { angeheftet: false })
pruefe('abheften', ids(chatsSuchen(dbPfad, '')) === 'c,b,a')
pruefe('Abheften laesst den Titel stehen', chatKopfLesen(dbPfad, 'a')?.titel === 'Kochbuch')

// --- Aus der Liste nehmen -------------------------------------------------------
chatMarkieren(dbPfad, 'b', { angeheftet: true })
chatMarkieren(dbPfad, 'b', { ausgeblendet: true })
pruefe('ausgeblendet fehlt in der Liste', ids(chatsSuchen(dbPfad, '')) === 'c,a')
pruefe('... und in der Suche', ids(chatsSuchen(dbPfad, 'server')) === '')
pruefe('... ist aber noch lesbar', chatKopfLesen(dbPfad, 'b')?.sessionId === 'b')
pruefe('... und nicht mehr angeheftet', (() => {
  chatMarkieren(dbPfad, 'b', { ausgeblendet: false })
  return ids(chatsSuchen(dbPfad, '')) === 'c,b,a'
})())
chatMarkieren(dbPfad, 'b', { ausgeblendet: true })
// Neue Aktivitaet (am PC weitergeschrieben) holt den Chat zurueck: wer dort
// weiterschreibt, will ihn wiedersehen.
h.prepare('UPDATE chats SET ended_at = ? WHERE session_id = ?').run(Date.now() + 5000, 'b')
pruefe('neue Aktivitaet holt ihn zurueck', ids(chatsSuchen(dbPfad, '')) === 'b,c,a')

// --- Neuer Chat vor dem ersten Indexlauf ---------------------------------------
chatRegistrieren(dbPfad, 'n', 'chat-n', '/p')
pruefe('nur registrierter Chat laesst sich markieren', chatMarkieren(dbPfad, 'n', { titel: 'Frisch' }) === true)

// --- Ueberlebt einen Index-Neubau ----------------------------------------------
h.exec('DELETE FROM chats_meta')
h.exec('INSERT INTO chats_meta (version) VALUES (0)')
h.close()
{
  // Frisch importiert (neuer Handle) -> Version 0 -> Index wird neu gebaut.
  const m = await import(`../dist/chats.js?neu=${Date.now()}`)
  m.chatsSuchen(dbPfad, '')
  const h2 = new DatabaseSync(dbPfad)
  const n = h2.prepare("SELECT COUNT(*) AS n FROM chat_markierung WHERE session_id = 'a' AND titel = 'Kochbuch'").get().n
  h2.close()
  pruefe('Markierung bleibt beim Neubau des Index', n === 1)
}

rmSync(wurzel, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
