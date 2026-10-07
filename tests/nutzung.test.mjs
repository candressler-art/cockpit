// Nutzungsindex (src/nutzung.ts): Zeilen auswerten, Entdoppelung (mehrere
// Zeilen je Antwort, kopierte Sitzungsdatei, Link-Wurzeln), inkrementelles
// Lesen, Auswertung und Kennzahlen. Gegen dist/.
import {
  zeileAuswerten, tagVon, stundeVon, nutzungIndizieren, nutzungLesen, kennzahlenBerechnen, tagVerschieben, tagSitzungen,
  rueckblickGruppieren, nutzungGesamt, aufteilungLesen, zeilenExportieren, zeilenUebernehmen, loopSitzungenMarkieren,
  fremdStand,
} from '../dist/nutzung.js'
import { fremdeCockpitsLesen, quelleUmdeuten, fremdHolen, loopIdsLesen } from '../dist/nutzungFremd.js'
import { DatabaseSync } from 'node:sqlite'
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

// --- Rueckblick gruppieren --------------------------------------------------
{
  const s = (sitzung, projekt, von, tokens) => ({ sitzung, projekt, tokens, antworten: 2, von, bis: von + 60_000 })
  const arten = {
    c1: { art: 'chat', chatId: 'c1', titel: 'Chat eins' },
    c1f: { art: 'chat', chatId: 'c1', titel: 'Chat eins' }, // Fortsetzung desselben Chats
    l1: { art: 'loop', titel: 'Umbau-Schicht' }, l2: { art: 'loop', titel: 'Umbau-Schicht' }, l3: { art: 'loop', titel: 'Umbau-Schicht' },
    w1: { art: 'team', runId: 'r1', titel: 'Auftrag A' }, w2: { art: 'team', runId: 'r1', titel: 'Auftrag A' },
    x1: { art: 'sonst' },
  }
  const e = rueckblickGruppieren([
    s('l1', 'cockpit-umbau', 1000, 10), s('c1', 'cockpit', 500, 5), s('l2', 'cockpit-umbau', 2000, 20),
    s('w1', 'homelab', 3000, 7), s('l3', 'cockpit-umbau', 4000, 30), s('w2', 'homelab', 3500, 3),
    s('c1f', 'cockpit', 5000, 1), s('x1', null, 6000, 2),
  ], (id) => arten[id])
  pruefe('Rueckblick: 4 Eintraege statt 8 Sitzungen', e.length === 4)
  const loop = e.find((x) => x.art === 'loop')
  pruefe('Rueckblick: Loop fasst 3 Durchgaenge zusammen', loop?.sitzungen === 3 && loop.tokens === 60)
  pruefe('Rueckblick: Loop-Zeitraum von erstem bis letztem', loop?.von === 1000 && loop.bis === 64_000)
  const team = e.find((x) => x.art === 'team')
  pruefe('Rueckblick: Team-Auftrag ein Eintrag mit runId', team?.sitzungen === 2 && team.runId === 'r1' && team.titel === 'Auftrag A')
  const chat = e.find((x) => x.art === 'chat')
  pruefe('Rueckblick: Fortsetzung zaehlt zum selben Chat', chat?.sitzungen === 2 && chat.chat === 'c1' && chat.tokens === 6)
  pruefe('Rueckblick: nach Beginn sortiert', e.map((x) => x.art).join(',') === 'chat,loop,team,sonst')
  pruefe('Rueckblick: Sonstiges heisst "Andere Sitzungen"', e[3].titel === 'Andere Sitzungen' && e[3].chat === null)

  // Ein Loop, dessen Agent per cd in Unterordner wechselt: je Antwort ein
  // anderes Projekt, aber EIN Startordner laut Index -> EIN Eintrag.
  const wandernd = rueckblickGruppieren([
    s('a', 'cockpit-umbau', 1, 1), s('b', 'highlight.js', 2, 1), s('c', 'web', 3, 1),
  ], () => ({ art: 'loop', titel: 'Umbau-Schicht', projekt: 'cockpit-umbau' }))
  pruefe('Rueckblick: Ordnerwechsel im Loop teilt ihn nicht', wandernd.length === 1 && wandernd[0].sitzungen === 3 && wandernd[0].projekt === 'cockpit-umbau')
}

// --- Gesamtsumme ueber alles ------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'nutzung-gesamt-'))
  const db = join(dir, 'n.db')
  mkdirSync(join(dir, 'p'))
  const zeile = (id, ts, u) => JSON.stringify({ type: 'assistant', timestamp: ts, sessionId: 's-' + id.slice(-1), cwd: '/x/proj',
    message: { id, model: 'claude-opus-5-5', usage: u } })
  writeFileSync(join(dir, 'p', 'a.jsonl'), [
    zeile('m1', '2026-01-02T10:00:00Z', { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }),
    zeile('m2', '2026-03-04T10:00:00Z', { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }),
  ].join('\n') + '\n')
  const leer = nutzungGesamt(db)
  pruefe('Gesamt: leerer Index -> 0 und seit null', leer.tokens === 0 && leer.seit === null)
  await nutzungIndizieren(db, [dir])
  const g = nutzungGesamt(db)
  pruefe('Gesamt: Tokens ohne Cache-Lesen ueber alle Tage', g.tokens === 121)
  pruefe('Gesamt: Cache-Lesen getrennt', g.cacheLesen === 1004)
  pruefe('Gesamt: seit erstem Tag', g.seit === '2026-01-02')
  pruefe('Gesamt: Antworten und Sitzungen', g.antworten === 2 && g.sitzungen === 2)
  rmSync(dir, { recursive: true, force: true })
}

// --- Quellen, Austausch zwischen Cockpits, Loops ------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'nutzung-quellen-'))
  const db = join(dir, 'n.db')
  const z = (id, sitzung, modell, u, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-06T10:00:00Z',
    requestId: 'r' + id, sessionId: sitzung, cwd: '/x/p', message: { id, model: modell, usage: u }, ...extra })
  const u = (ein, aus, cs, cl) => ({ input_tokens: ein, output_tokens: aus, cache_creation_input_tokens: cs, cache_read_input_tokens: cl })
  mkdirSync(join(dir, 'haupt', '-home-claude'), { recursive: true })
  mkdirSync(join(dir, 'pc', '-home-x-projekte-autopilot'), { recursive: true })
  mkdirSync(join(dir, 'pc', '-home-x-spiel'), { recursive: true })
  writeFileSync(join(dir, 'haupt', '-home-claude', 'a.jsonl'), [
    z('h1', 'sa', 'claude-opus-5-5', u(1, 10, 100, 1000)),
    z('h2', 'sb', 'claude-sonnet-5-5', u(2, 20, 200, 2000), { entrypoint: 'sdk-cli' }),
  ].join('\n') + '\n')
  writeFileSync(join(dir, 'pc', '-home-x-projekte-autopilot', 'b.jsonl'), z('p1', 'sc', 'claude-opus-5-5', u(3, 30, 300, 3000)) + '\n')
  writeFileSync(join(dir, 'pc', '-home-x-spiel', 'c.jsonl'), z('p2', 'sd', 'claude-opus-5-5', u(4, 40, 400, 4000)) + '\n')
  await nutzungIndizieren(db, [{ pfad: join(dir, 'pc'), quelle: 'pc' }, { pfad: join(dir, 'haupt'), quelle: 'haupt' }])
  const a = aufteilungLesen(db, null)
  const q = Object.fromEntries(a.quellen.map((x) => [x.quelle, x]))
  pruefe('Quelle: haupt', q.haupt?.antworten === 1 && q.haupt.aus === 10)
  pruefe('Quelle: sdk-cli und Autopilot-Ordner sind Loops', q.loop?.antworten === 2 && q.loop.aus === 50)
  pruefe('Quelle: PC', q.pc?.antworten === 1 && q.pc.aus === 40)
  const opus = a.modelle.find((m) => m.modell === 'claude-opus-5-5')
  pruefe('Modell: Eingabe, Cache und Ausgabe getrennt', opus?.ein === 8 && opus.cacheSchreiben === 800 && opus.cacheLesen === 8000 && opus.aus === 80)
  pruefe('Modell: Quellen dabei', opus?.quellen.sort().join(',') === 'haupt,loop,pc')
  pruefe('Aufteilung ab Tag filtert', aufteilungLesen(db, '2026-10-07').quellen.length === 0)

  // Altbestand ohne Spalte quelle: wird nachgeruestet und beim naechsten Lesen gefuellt.
  const alt = join(dir, 'alt.db')
  const h = new DatabaseSync(alt)
  h.exec(`CREATE TABLE nutzung_dateien (pfad TEXT PRIMARY KEY, versatz INTEGER NOT NULL, mtime INTEGER NOT NULL);
    CREATE TABLE nutzung (schluessel TEXT PRIMARY KEY, tag TEXT NOT NULL, ts INTEGER NOT NULL, stunde INTEGER NOT NULL,
      modell TEXT, projekt TEXT, sitzung TEXT, ein INTEGER NOT NULL, aus INTEGER NOT NULL, cache_schreiben INTEGER NOT NULL, cache_lesen INTEGER NOT NULL);
    INSERT INTO nutzung VALUES ('h1:rh1','2026-10-06',1,12,'claude-opus-5-5','p','sa',1,10,100,1000);
    INSERT INTO nutzung VALUES ('weg:x','2026-10-05',1,12,'claude-opus-5-5','p','sz',1,1,1,1);
    INSERT INTO nutzung_dateien VALUES ('${join(dir, 'haupt', '-home-claude', 'a.jsonl')}', 999999, 1);`)
  h.close()
  await nutzungIndizieren(alt, [{ pfad: join(dir, 'pc'), quelle: 'pc' }, { pfad: join(dir, 'haupt'), quelle: 'haupt' }])
  const qa = Object.fromEntries(aufteilungLesen(alt, null).quellen.map((x) => [x.quelle, x.antworten]))
  pruefe('Nachruesten: alte Zeilen bekommen ihre Quelle, ohne Datei zaehlt haupt', qa.haupt === 2 && qa.loop === 2 && qa.pc === 1)
  pruefe('Nachruesten: Summen unveraendert (keine Doppelten)', nutzungGesamt(alt).antworten === 5)

  // Export -> Import: "haupt" dort ist "roblox" hier, Loops bleiben Loops.
  const exp = zeilenExportieren(db, 0, '', 2)
  pruefe('Export: seitenweise mit mehr', exp.zeilen.length === 2 && exp.mehr === true)
  const rest = zeilenExportieren(db, exp.zeilen[1].ts, exp.zeilen[1].schluessel, 10)
  pruefe('Export: zweite Seite ohne Doppelte', rest.zeilen.length === 2 && rest.mehr === false &&
    new Set([...exp.zeilen, ...rest.zeilen].map((x) => x.schluessel)).size === 4)
  const ziel = join(dir, 'ziel.db')
  const n = zeilenUebernehmen(ziel, [...exp.zeilen, ...rest.zeilen, { kaputt: true }, { schluessel: 'x', ts: 'nein' }], quelleUmdeuten)
  const qz = Object.fromEntries(aufteilungLesen(ziel, null).quellen.map((x) => [x.quelle, x.antworten]))
  pruefe('Import: 4 uebernommen, Ungueltiges verworfen', n === 4)
  pruefe('Import: haupt -> roblox, loop bleibt, pc bleibt', qz.roblox === 1 && qz.loop === 2 && qz.pc === 1)
  pruefe('Import: zweimal = nichts neu', zeilenUebernehmen(ziel, exp.zeilen, quelleUmdeuten) === 0)

  // Loop-Chats nachtraeglich markieren (Roblox-Sitzung sa wird Loop).
  pruefe('Loop markieren', loopSitzungenMarkieren(ziel, ['sa', 'unbekannt']) === 1 &&
    !aufteilungLesen(ziel, null).quellen.some((x) => x.quelle === 'roblox'))

  // Abholen ueber HTTP (fetch untergeschoben), Stand wird gemerkt.
  const ziel2 = join(dir, 'ziel2.db')
  const anfragen = []
  const abruf = async (url) => {
    anfragen.push(url)
    const p = new URL(url).searchParams
    const d = zeilenExportieren(db, Number(p.get('seit')), p.get('nach') ?? '', Number(p.get('grenze')) > 3 ? 3 : Number(p.get('grenze')))
    return { ok: true, status: 200, json: async () => d }
  }
  const neu = await fremdHolen(ziel2, { name: 'roblox', url: 'http://x' }, abruf)
  pruefe('Abholen: alle Seiten, alles da', neu === 4 && anfragen.length === 2)
  pruefe('Abholen: Stand gemerkt', fremdStand(ziel2, 'roblox') === Date.parse('2026-10-06T10:00:00Z'))
  let fehler = null
  try { await fremdHolen(ziel2, { name: 'roblox', url: 'http://x' }, async () => ({ ok: false, status: 404 })) } catch (e) { fehler = e.message }
  pruefe('Abholen: altes Cockpit -> verstaendlicher Fehler', /Neustart/.test(fehler ?? ''))

  pruefe('Fremde Cockpits: Vorgabe Roblox', fremdeCockpitsLesen(undefined)[0]?.url === 'http://127.0.0.1:8766')
  pruefe('Fremde Cockpits: leer = keins, Unsinn verworfen', fremdeCockpitsLesen('').length === 0 && fremdeCockpitsLesen('a=ftp://x,B C=http://y').length === 0)

  mkdirSync(join(dir, 'loop'))
  writeFileSync(join(dir, 'loop', 'abend.json'), JSON.stringify({ chat: '4d1266e9-f300-4675-887c-80865b06464b', erklaert: ['35cd66e5-06f6-4d61-be7c-8b5f72dca039'] }))
  writeFileSync(join(dir, 'loop', 'chats.txt'), 'aa2d8506-4899-4be3-bd8b-f7979aef8bc1\n')
  writeFileSync(join(dir, 'loop', 'abend.log'), 'e305b706-f134-4f26-ad50-c8dd2673afb0')
  const ids = await loopIdsLesen(join(dir, 'loop'))
  pruefe('Loop-Ids aus json und chats.txt, nicht aus Logs', ids.length === 3 && !ids.includes('e305b706-f134-4f26-ad50-c8dd2673afb0'))
  pruefe('Loop-Ids: fehlender Ordner -> leer', (await loopIdsLesen(join(dir, 'gibtsnicht'))).length === 0)
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
