// Nutzungsindex (src/nutzung.ts): Zeilen auswerten, Entdoppelung (mehrere
// Zeilen je Antwort, kopierte Sitzungsdatei, Link-Wurzeln), inkrementelles
// Lesen, Auswertung und Kennzahlen. Gegen dist/.
import {
  zeileAuswerten, tagVon, stundeVon, nutzungIndizieren, nutzungLesen, kennzahlenBerechnen, tagVerschieben, tagSitzungen,
} from '../dist/nutzung.js'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, symlinkSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const antwort = (id, ts, usage, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, requestId: `req_${id}`, sessionId: 's1', cwd: '/home/can/projekt-a',
  message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'x' }] }, ...extra,
})

// --- Tag und Stunde in Berlin -----------------------------------------------
pruefe('23:30 UTC im Sommer ist schon der naechste Tag', tagVon(Date.parse('2026-07-01T22:30:00Z')) === '2026-07-02')
pruefe('Stunde in Berlin (Sommerzeit)', stundeVon(Date.parse('2026-07-01T12:00:00Z')) === 14)
pruefe('Stunde in Berlin (Winterzeit)', stundeVon(Date.parse('2026-01-15T12:00:00Z')) === 13)
pruefe('tagVerschieben ueber Monatsgrenze', tagVerschieben('2026-03-01', -1) === '2026-02-28')
pruefe('tagVerschieben ueber Zeitumstellung', tagVerschieben('2026-03-28', 2) === '2026-03-30')

// --- Zeile auswerten -----------------------------------------------------------
{
  const z = zeileAuswerten(antwort('m1', '2026-09-20T10:00:00Z', { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 }))
  pruefe('Antwort ausgewertet', z && z.ein === 10 && z.aus === 20 && z.cacheSchreiben === 5 && z.cacheLesen === 1000)
  pruefe('Schluessel aus message.id + requestId', z?.schluessel === 'm1:req_m1')
  pruefe('Projekt = letzter Ordnername', z?.projekt === 'projekt-a')
}
pruefe('Nutzerzeile -> null', zeileAuswerten(JSON.stringify({ type: 'user', message: { usage: {} } })) === null)
pruefe('synthetisch -> null', zeileAuswerten(JSON.stringify({ type: 'assistant', timestamp: '2026-09-20T10:00:00Z', message: { id: 'x', model: '<synthetic>', usage: {} } })) === null)
pruefe('ohne Zeit -> null', zeileAuswerten(JSON.stringify({ type: 'assistant', message: { id: 'x', usage: {} } })) === null)
pruefe('kaputtes JSON -> null', zeileAuswerten('{"usage": kaputt') === null)
{
  const z = zeileAuswerten(antwort('m2', '2026-09-20T10:00:00Z', { input_tokens: -3, output_tokens: 'viel' }))
  pruefe('unsinnige Zahlen -> 0', z?.ein === 0 && z.aus === 0)
}

// --- Index -------------------------------------------------------------------
const wurzel = mkdtempSync(join(tmpdir(), 'umbau-nutzung-'))
const dbPfad = join(wurzel, 'test.db')
const spiegel = join(wurzel, 'spiegel', '-home-can-projekt-a')
const server = join(wurzel, 'server', '-home-can-projekt-a')
mkdirSync(join(spiegel, 's1', 'subagents'), { recursive: true })
mkdirSync(server, { recursive: true })
const u = (ein, aus) => ({ input_tokens: ein, output_tokens: aus, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 })

// Antwort m1 mit zwei Inhaltsbloecken = zwei Zeilen mit demselben usage.
writeFileSync(join(spiegel, 's1.jsonl'), [
  JSON.stringify({ type: 'user', timestamp: '2026-09-20T09:59:00Z', message: { content: 'Hallo' } }),
  antwort('m1', '2026-09-20T10:00:00Z', u(100, 10)),
  antwort('m1', '2026-09-20T10:00:01Z', u(100, 30)),
  antwort('m2', '2026-09-21T10:00:00Z', u(200, 20)),
].join('\n') + '\n')
writeFileSync(join(spiegel, 's1', 'subagents', 'agent-1.jsonl'), antwort('sub1', '2026-09-21T11:00:00Z', u(1, 1)) + '\n')

{
  const r = await nutzungIndizieren(dbPfad, [join(wurzel, 'spiegel'), join(wurzel, 'server')])
  pruefe('zwei Dateien (inkl. Subagent) gefunden', r.dateien === 2)
  const b = nutzungLesen(dbPfad, '2026-01-01', Date.parse('2026-09-21T12:00:00Z'))
  const t20 = b.tage.find((t) => t.tag === '2026-09-20')
  pruefe('mehrere Zeilen je Antwort einfach gezaehlt, groesstes usage gewinnt', t20?.antworten === 1 && t20.aus === 30 && t20.tokens === 130)
  pruefe('Cache-Lesen nicht in tokens, aber separat', t20?.cacheLesen === 50)
  pruefe('Subagent mitgezaehlt', b.tage.find((t) => t.tag === '2026-09-21')?.antworten === 2)
  pruefe('heute im Bericht', b.heute === '2026-09-21')
  pruefe('Stundenverteilung nach Berliner Stunde', b.stunden[12] === 350 && b.stunden[13] === 2)
  pruefe('Modell und Projekt ausgewertet', b.modelle[0].modell === 'claude-opus-5-5' && b.projekte[0].projekt === 'projekt-a')
}
{
  // Fortgesetzter Chat = Kopie der Spiegeldatei auf dem Server + neue Antwort.
  copyFileSync(join(spiegel, 's1.jsonl'), join(server, 's1.jsonl'))
  appendFileSync(join(server, 's1.jsonl'), antwort('m3', '2026-09-22T10:00:00Z', u(5, 5)) + '\n')
  // Halbe Zeile am Ende (Datei wird gerade geschrieben) darf nicht verloren gehen.
  const halb = antwort('m4', '2026-09-22T11:00:00Z', u(7, 7))
  appendFileSync(join(server, 's1.jsonl'), halb.slice(0, 40))
  const r = await nutzungIndizieren(dbPfad, [join(wurzel, 'spiegel'), join(wurzel, 'server')])
  pruefe('Kopie: nur die neue Antwort zaehlt', r.neu === 1)
  appendFileSync(join(server, 's1.jsonl'), halb.slice(40) + '\n')
  const r2 = await nutzungIndizieren(dbPfad, [join(wurzel, 'spiegel'), join(wurzel, 'server')])
  pruefe('halbe Zeile nach Vervollstaendigung gelesen', r2.neu === 1)
  const r3 = await nutzungIndizieren(dbPfad, [join(wurzel, 'spiegel'), join(wurzel, 'server')])
  pruefe('unveraendert: nichts neu', r3.neu === 0)
}
{
  // Wurzel ueber einen Link (projects/ eines Zusatzkontos zeigt aufs Hauptkonto).
  symlinkSync(join(wurzel, 'server'), join(wurzel, 'link'))
  const r = await nutzungIndizieren(dbPfad, [join(wurzel, 'spiegel'), join(wurzel, 'server'), join(wurzel, 'link')])
  pruefe('Link-Wurzel nicht doppelt', r.dateien === 3 && r.neu === 0)
}
{
  const [a, b] = await Promise.all([
    nutzungIndizieren(dbPfad, [join(wurzel, 'spiegel')]),
    nutzungIndizieren(dbPfad, [join(wurzel, 'spiegel')]),
  ])
  pruefe('gleichzeitige Aufrufe teilen sich einen Durchgang', a === b)
}
{
  const b = nutzungLesen(dbPfad, '2026-09-21', Date.parse('2026-09-22T12:00:00Z'))
  pruefe('abTag filtert', b.tage.length === 2 && b.tage[0].tag === '2026-09-21')
}
{
  const s = tagSitzungen(dbPfad, '2026-09-21')
  pruefe('Tag: eine Sitzung mit Subagent', s.length === 1 && s[0].sitzung === 's1' && s[0].antworten === 2 && s[0].tokens === 222)
  pruefe('Tag: Projekt und Zeitspanne', s[0].projekt === 'projekt-a' && s[0].von === Date.parse('2026-09-21T10:00:00Z') && s[0].bis === Date.parse('2026-09-21T11:00:00Z'))
  pruefe('Tag ohne Nutzung: leer', tagSitzungen(dbPfad, '2026-01-01').length === 0)
}
rmSync(wurzel, { recursive: true, force: true })

// --- Kennzahlen ----------------------------------------------------------------
{
  const tag = (t, tokens) => ({ tag: t, tokens, ein: 0, aus: 0, cacheSchreiben: 0, cacheLesen: 0, antworten: 1, sitzungen: 1 })
  const tage = [tag('2026-08-01', 500), tag('2026-09-18', 10), tag('2026-09-19', 20), tag('2026-09-20', 30), tag('2026-09-22', 40), tag('2026-09-23', 50)]
  const k = kennzahlenBerechnen(tage, '2026-09-24')
  pruefe('heute ohne Nutzung: 0', k.heute === 0)
  pruefe('Serie laeuft bis gestern weiter', k.serie === 2)
  pruefe('laengste Serie', k.laengsteSerie === 3)
  pruefe('7 Tage (18.-24.)', k.sieben === 150)
  pruefe('30 Tage ohne August', k.dreissig === 150)
  pruefe('aktivster Tag', k.aktivsterTag?.tag === '2026-08-01')
  pruefe('aktive Tage', k.aktiveTage === 6)
  pruefe('Schnitt je aktivem Tag (30 Tage)', k.schnittAktiv30 === 30)
  const k2 = kennzahlenBerechnen([...tage, tag('2026-09-24', 5)], '2026-09-24')
  pruefe('heute aktiv: Serie schliesst heute ein', k2.serie === 3 && k2.heute === 5)
  const leer = kennzahlenBerechnen([], '2026-09-24')
  pruefe('leer: alles 0, kein aktivster Tag', leer.serie === 0 && leer.aktivsterTag === null && leer.schnittAktiv30 === 0)
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
