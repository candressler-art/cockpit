// Cloud-Nutzung und Cloud-Auftraege (src/cloudNutzung.ts, src/cloudAuftrag.ts):
// Verbrauch je Tag aus dem Guthabenverlauf, Kennzahlen, Speichern nur bei
// Aenderung, Parsen eines RemoteTrigger-create, Verpacken des Auftrags. Gegen dist/.
import {
  cloudTageBerechnen, cloudKennzahlen, cloudMessungMerken, cloudVerlaufLesen, auftragSpeichern, auftragLesen,
  auftragZuTrigger, auftraegeLesen, auftraegeAmTag, umgebungMerken, umgebungLesen,
} from '../dist/cloudNutzung.js'
import {
  auftragsId, slugVon, branchFuer, routinenName, githubUrl, auftragVerpacken, remoteTriggerBloecke, istCreate,
  createErgebnisParsen, pruefNachricht, CLOUD_MODELL,
} from '../dist/cloudAuftrag.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}
const ms = (iso) => Date.parse(iso)

// --- Tagesrechnung ------------------------------------------------------------------
{
  const r = cloudTageBerechnen([
    { konto: 'haupt', ts: ms('2026-10-01T08:00:00Z'), verbraucht: 18.45 },
    { konto: 'haupt', ts: ms('2026-10-01T12:00:00Z'), verbraucht: 20.45 },
    { konto: 'haupt', ts: ms('2026-10-02T09:00:00Z'), verbraucht: 23.65 },
  ])
  pruefe('Erste Messung zaehlt als vor Aufzeichnung', r.vorAufzeichnung === 18.45)
  pruefe('Zuwachs dem Tag der spaeteren Messung zugerechnet', r.tage.length === 2 && r.tage[0].tag === '2026-10-01' && r.tage[0].dollar === 2)
  pruefe('Zweiter Tag mit 3,20 $', r.tage[1].tag === '2026-10-02' && r.tage[1].dollar === 3.2)
}
{
  // Sprung nach unten (neues Guthaben/Korrektur): nichts Negatives, danach vom neuen Stand weiter.
  const r = cloudTageBerechnen([
    { konto: 'zweit', ts: ms('2026-10-01T08:00:00Z'), verbraucht: 5 },
    { konto: 'zweit', ts: ms('2026-10-01T09:00:00Z'), verbraucht: 0.5 },
    { konto: 'zweit', ts: ms('2026-10-01T10:00:00Z'), verbraucht: 1.5 },
  ])
  pruefe('Sprung nach unten zaehlt nicht negativ', r.tage.length === 1 && r.tage[0].dollar === 1)
}
{
  // Konto ohne Vorwert: nur eine Messung -> alles vor Aufzeichnung, kein Tag.
  const r = cloudTageBerechnen([
    { konto: 'haupt', ts: ms('2026-10-01T08:00:00Z'), verbraucht: 18 },
    { konto: 'haupt', ts: ms('2026-10-01T09:00:00Z'), verbraucht: 19 },
    { konto: 'zweit', ts: ms('2026-10-01T10:00:00Z'), verbraucht: 0.64 },
  ])
  pruefe('Konto ohne Vorwert: nur vor Aufzeichnung', r.vorAufzeichnung === 18.64 && r.tage.length === 1 && r.tage[0].dollar === 1)
}
{
  // Ueber Mitternacht in Berlin: 21:30 UTC im Oktober ist 23:30 Berlin, 22:30 UTC schon der naechste Tag.
  const r = cloudTageBerechnen([
    { konto: 'haupt', ts: ms('2026-10-02T21:30:00Z'), verbraucht: 10 },
    { konto: 'haupt', ts: ms('2026-10-02T22:30:00Z'), verbraucht: 12.5 },
  ])
  pruefe('Messung nach Berliner Mitternacht zaehlt zum neuen Tag', r.tage.length === 1 && r.tage[0].tag === '2026-10-03' && r.tage[0].dollar === 2.5)
}
{
  const r = cloudTageBerechnen([
    { konto: 'zweit', ts: ms('2026-10-01T10:00:00Z'), verbraucht: 1 },
    { konto: 'haupt', ts: ms('2026-10-01T09:00:00Z'), verbraucht: 1 },
    { konto: 'haupt', ts: ms('2026-10-01T08:00:00Z'), verbraucht: 0 },
    { konto: 'zweit', ts: ms('2026-10-01T09:00:00Z'), verbraucht: 0.1 },
  ])
  pruefe('Unsortiert und mehrere Konten: Summe je Tag', r.tage[0].dollar === 1.9 && r.vorAufzeichnung === 0.1)
}
pruefe('Leer -> nichts', cloudTageBerechnen([]).tage.length === 0 && cloudTageBerechnen([]).vorAufzeichnung === 0)
{
  const tage = [{ tag: '2026-08-01', dollar: 9 }, { tag: '2026-09-20', dollar: 1.5 }, { tag: '2026-09-28', dollar: 2 }, { tag: '2026-10-03', dollar: 0.25 }]
  const k = cloudKennzahlen(tage, '2026-10-03')
  pruefe('Kennzahlen heute/7/30/gesamt', k.heute === 0.25 && k.sieben === 2.25 && k.dreissig === 3.75 && k.gesamt === 12.75)
}

// --- Datenbank -----------------------------------------------------------------------
const wurzel = mkdtempSync(join(tmpdir(), 'cloud-test-'))
const db = join(wurzel, 'test.db')
{
  pruefe('Erste Messung wird gemerkt', cloudMessungMerken(db, 'haupt', 18.45, 1000) === true)
  pruefe('Gleicher Stand wird nicht gemerkt', cloudMessungMerken(db, 'haupt', 18.450000001, 2000) === false)
  pruefe('Geaenderter Stand wird gemerkt', cloudMessungMerken(db, 'haupt', 19, 3000) === true)
  pruefe('Anderes Konto: eigene erste Zeile', cloudMessungMerken(db, 'zweit', 0.64, 3000) === true)
  pruefe('Verlauf hat drei Zeilen', cloudVerlaufLesen(db).length === 3)

  const a = {
    id: 'abc234', chatId: 'chat1', konto: 'haupt', triggerId: 'trig_01X', name: '☁ Test [abc234]', branch: 'cloud/test-abc234',
    repo: 'https://github.com/candressler-art/cockpit', link: 'https://claude.ai/code/routines/trig_01X', erstellt: ms('2026-10-03T08:00:00Z'),
    guthabenVorher: 18.45, status: 'gestartet', fertigAm: null, kosten: null,
  }
  auftragSpeichern(db, a)
  pruefe('Auftrag lesen', auftragLesen(db, 'abc234')?.branch === 'cloud/test-abc234')
  pruefe('Auftrag zum Trigger', auftragZuTrigger(db, 'trig_01X')?.id === 'abc234')
  auftragSpeichern(db, { ...a, status: 'fertig', fertigAm: 5, kosten: 3.2, link: null })
  const f = auftragLesen(db, 'abc234')
  pruefe('Fertig: Status und Kosten, Link bleibt', f.status === 'fertig' && f.kosten === 3.2 && f.link === a.link)
  pruefe('Auftraege je Chat', auftraegeLesen(db, { chatId: 'chat1' }).length === 1 && auftraegeLesen(db, { chatId: 'x' }).length === 0)
  pruefe('Auftraege je Status', auftraegeLesen(db, { status: 'gestartet' }).length === 0)
  pruefe('Auftraege am Berliner Tag', auftraegeAmTag(auftraegeLesen(db), '2026-10-03').length === 1 && auftraegeAmTag(auftraegeLesen(db), '2026-10-02').length === 0)

  pruefe('Umgebung haupt vorbelegt', umgebungLesen(db, 'haupt') === 'env_013es3CJDiadm6B3TVoLMfpu')
  pruefe('Umgebung zweit unbekannt', umgebungLesen(db, 'zweit') === null)
  umgebungMerken(db, 'zweit', 'env_ZWEIT123456')
  pruefe('Umgebung gemerkt', umgebungLesen(db, 'zweit') === 'env_ZWEIT123456')
}
rmSync(wurzel, { recursive: true, force: true })

// --- Namen ---------------------------------------------------------------------------
pruefe('Auftrags-Id: 6 Zeichen a-z0-9', /^[a-z0-9]{6}$/.test(auftragsId()))
pruefe('Slug mit Umlauten', slugVon('Größe ändern: Übersicht!') === 'groesse-aendern-uebersicht')
pruefe('Slug hoechstens 30 Zeichen, ohne Strich am Ende', slugVon('a '.repeat(40)).length <= 30 && !slugVon('a '.repeat(40)).endsWith('-'))
pruefe('Slug leer -> auftrag', slugVon('!!!') === 'auftrag')
pruefe('Branch', branchFuer('test', 'abc234') === 'cloud/test-abc234')
pruefe('Name mit Wolke und Id', routinenName('  Nutzung  zaehlen ', 'abc234') === '☁ Nutzung zaehlen [abc234]')
pruefe('GitHub-URL aus ssh', githubUrl('git@github.com:candressler-art/cockpit.git') === 'https://github.com/candressler-art/cockpit')
pruefe('GitHub-URL aus https mit Token-Teil', githubUrl('https://x@github.com/a/b.git') === 'https://github.com/a/b')
pruefe('Keine GitHub-URL', githubUrl('https://gitlab.com/a/b') === null)

// --- Ergebnis eines create parsen ---------------------------------------------------------
const routine = {
  id: 'trig_01AbCdEfGh', name: '☁ Nutzung zaehlen [abc234]', run_once_at: '2026-10-03T10:02:00Z',
  job_config: { ccr: {
    environment_id: 'env_013es3CJDiadm6B3TVoLMfpu',
    session_context: { allowed_tools: ['Bash'], model: CLOUD_MODELL, sources: [{ git_repository: { url: 'https://github.com/candressler-art/cockpit' } }] },
    events: [{ data: { type: 'user', message: { role: 'user', content: 'Arbeite auf cloud/nutzung-zaehlen-abc234, nie auf main. Kein "Zitat" kaputt {x}' } } }],
  } },
}
const ergebnis = `HTTP 200\n${JSON.stringify(routine, null, 2)}\nRoutine created; first run at 2026-10-03 12:02 (Europe/Berlin): https://claude.ai/code/routines/trig_01AbCdEfGh`
{
  const p = createErgebnisParsen(ergebnis)
  pruefe('create: trigger_id', p?.triggerId === 'trig_01AbCdEfGh')
  pruefe('create: Name und Auftrags-Id', p?.name === routine.name && p.auftragsId === 'abc234')
  pruefe('create: run_once_at', p?.runOnceAt === '2026-10-03T10:02:00Z')
  pruefe('create: environment_id', p?.environmentId === 'env_013es3CJDiadm6B3TVoLMfpu')
  pruefe('create: Link', p?.link === 'https://claude.ai/code/routines/trig_01AbCdEfGh')
  pruefe('create: Repo', p?.repo === 'https://github.com/candressler-art/cockpit')
  pruefe('create: Branch aus dem Prompt', p?.branch === 'cloud/nutzung-zaehlen-abc234')
}
{
  // Ohne gueltiges JSON (abgeschnitten): Regex reicht.
  const p = createErgebnisParsen('HTTP 200\n{"id": "trig_02Zz", "name": "☁ X [qwe234]", "environment_id": "env_ABCDEFGH12"')
  pruefe('create ohne gueltiges JSON: per Regex', p?.triggerId === 'trig_02Zz' && p.auftragsId === 'qwe234' && p.environmentId === 'env_ABCDEFGH12')
}
pruefe('HTTP 400 -> null', createErgebnisParsen('HTTP 400\n{"error": "bad", "id": "trig_x1"}') === null)
pruefe('ohne trig_ -> null', createErgebnisParsen('HTTP 200\n{"ok": true}') === null)
pruefe('leer -> null', createErgebnisParsen('') === null)

// --- Bloecke aus dem Nachrichtenstrom -------------------------------------------------------
{
  const aufruf = remoteTriggerBloecke({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Ich starte die Routine.' },
    { type: 'tool_use', id: 'tu_1', name: 'RemoteTrigger', input: { action: 'create', body: routine } },
  ] } })
  pruefe('tool_use RemoteTrigger erkannt', aufruf.length === 1 && aufruf[0].art === 'aufruf' && istCreate(aufruf[0].eingabe))
  const liste = remoteTriggerBloecke({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'RemoteTrigger', input: { action: 'list' } }] } })
  pruefe('list ist kein create', !istCreate(liste[0].eingabe))
  const andere = remoteTriggerBloecke({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_3', name: 'Bash', input: {} }] } })
  pruefe('anderes Werkzeug ignoriert', andere.length === 0)
  const erg = remoteTriggerBloecke({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: ergebnis }] }] } })
  pruefe('tool_result als Textliste gelesen', erg[0]?.art === 'ergebnis' && erg[0].toolUseId === 'tu_1' && erg[0].text.includes('trig_01AbCdEfGh'))
  const fehler = remoteTriggerBloecke({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'nein', is_error: true }] } })
  pruefe('tool_result mit Fehler markiert', fehler[0]?.istFehler === true && fehler[0].text === 'nein')
  pruefe('Kaputte Nachricht -> leer', remoteTriggerBloecke(null).length === 0 && remoteTriggerBloecke({ message: {} }).length === 0)
}

// --- Verpacken ---------------------------------------------------------------------------
{
  const rahmen = {
    id: 'abc234', text: 'Nutzung zählen und Knopf bauen', chatTitel: 'Cockpit', konto: 'haupt',
    environmentId: 'env_013es3CJDiadm6B3TVoLMfpu', cwd: '/home/can/cockpit', repo: 'https://github.com/candressler-art/cockpit',
    remote: 'github', basisBranch: 'live-diktat', gedaechtnisPfad: '/home/can/.claude/agent-memory',
  }
  const t = auftragVerpacken(rahmen)
  pruefe('Verpackt: Cans Text woertlich', t.includes('Nutzung zählen und Knopf bauen'))
  pruefe('Verpackt: Branch fest', t.includes('cloud/nutzung-zaehlen-und-knopf-baue-abc234'))
  pruefe('Verpackt: Name mit Wolke', t.includes('☁ Nutzung zählen und Knopf bauen [abc234]'))
  pruefe('Verpackt: Konto und environment_id', t.includes('Konto: haupt') && t.includes('env_013es3CJDiadm6B3TVoLMfpu'))
  pruefe('Verpackt: Modell und Werkzeuge', t.includes(CLOUD_MODELL) && t.includes('"WebSearch"') && t.includes('keine MCP'))
  pruefe('Verpackt: Kontext a-e', ['(a)', '(b)', '(c)', '(d)', '(e)'].every((x) => t.includes(x)) && t.includes('Boss') && t.includes('WOERTLICH'))
  pruefe('Verpackt: Basis-Branch und Remote', t.includes('origin/live-diktat') && t.includes("Remote 'github'"))
  pruefe('Verpackt: nie main/live-diktat', /nie auf main, master, live-diktat/.test(t))
  pruefe('Verpackt: private Inhalte nur in den Prompt', t.includes('NIE in Dateien im Repo'))
  pruefe('Verpackt: deutsche Zusammenfassung im letzten Commit', t.includes('LETZTE Commit-Nachricht'))

  const leer = auftragVerpacken({ ...rahmen, text: '', chatTitel: 'Designs bauen' })
  pruefe('Leeres Feld: bisherige Aufgabe', leer.includes('BISHERIGE AUFGABE') && leer.includes('cloud/designs-bauen-abc234'))
  const ohneRepo = auftragVerpacken({ ...rahmen, repo: null, remote: null })
  pruefe('Ohne GitHub-Repo: ehrlich sagen, nichts starten', ohneRepo.includes('KEIN GitHub-Repo') && ohneRepo.includes('starte NICHTS'))
  const ohneEnv = auftragVerpacken({ ...rahmen, konto: 'zweit', environmentId: null })
  pruefe('Ohne environment_id: ermitteln statt raten', ohneEnv.includes('noch unbekannt') && ohneEnv.includes('action "list"'))
}
{
  const n = pruefNachricht({ id: 'abc234', name: '☁ X [abc234]', branch: 'cloud/x-abc234', repo: 'https://github.com/a/b' })
  pruefe('Pruefnachricht: holen, testen, nicht ausrollen', n.includes('cloud/x-abc234') && n.includes('testen') && n.includes('bevor ich OK sage'))
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
