// Einstellungen: Pruefung (reine Funktion), Laden mit Vorgaben, Speicher
// ueber CockpitDb (ueberlebt einen Neustart). Gegen dist/.
import {
  einstellungenPruefen, einstellungenLaden, vorgaben, EinstellungsSpeicher, auswahlListen,
} from '../dist/einstellungen.js'
import { CockpitDb } from '../dist/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const basis = vorgaben('/home/test')

// --- Pruefung ---------------------------------------------------------------
{
  const { werte, fehler } = einstellungenPruefen({ modell: 'claude-sonnet-5', aufwand: 'max' }, basis)
  pruefe('gueltige Felder uebernommen', werte.modell === 'claude-sonnet-5' && werte.aufwand === 'max' && fehler.length === 0)
  pruefe('Ausgangsstand nicht veraendert', basis.modell === 'claude-opus-5-5')
}
{
  const { werte, fehler } = einstellungenPruefen({ modell: 'opus', aufwand: 'low' }, basis)
  pruefe('Alias als Modell abgelehnt', werte.modell === basis.modell && fehler.some((f) => f.startsWith('modell')))
  pruefe('gueltiges Nachbarfeld trotzdem uebernommen', werte.aufwand === 'low')
}
{
  const { fehler } = einstellungenPruefen({ modell: 'claude-fable-5-1' }, basis)
  pruefe('Fable ohne Guthaben nicht angeboten', fehler.length === 1)
}
{
  const { werte, fehler } = einstellungenPruefen({ berechtigung: 'bypassPermissions', arbeitsordner: 'relativ/pfad' }, basis)
  pruefe('Berechtigung uebernommen', werte.berechtigung === 'bypassPermissions')
  pruefe('relativer Ordner abgelehnt', werte.arbeitsordner === '/home/test' && fehler.some((f) => f.startsWith('arbeitsordner')))
}
{
  const { werte } = einstellungenPruefen({ favoriten: ['/a', '/b', '/a'], rollenAus: ['planer', 'planer'] }, basis)
  pruefe('Favoriten entdoppelt', werte.favoriten.length === 2)
  pruefe('rollenAus entdoppelt', werte.rollenAus.length === 1)
  const { fehler } = einstellungenPruefen({ rollenAus: ['../boese'] }, basis)
  pruefe('Rollen-ID mit Pfadzeichen abgelehnt', fehler.length === 1)
}
{
  const { werte, fehler } = einstellungenPruefen({ team: { maxRunden: '12', parallel: 9, quatsch: 1 } }, basis)
  pruefe('team.maxRunden aus Text gelesen', werte.team.maxRunden === 12)
  pruefe('team.parallel ausserhalb abgelehnt', werte.team.parallel === 2 && fehler.some((f) => f.startsWith('team.parallel')))
  pruefe('unbekanntes team-Feld gemeldet', fehler.some((f) => f.startsWith('team.quatsch')))
  pruefe('team-Vorgabe nicht veraendert', basis.team.maxRunden === 8)
}
{
  pruefe('kein Objekt -> Fehler', einstellungenPruefen([1], basis).fehler.length === 1)
  pruefe('null -> Fehler', einstellungenPruefen(null, basis).fehler.length === 1)
  pruefe('unbekannter Schluessel gemeldet', einstellungenPruefen({ farbe: 'rot' }, basis).fehler[0].startsWith('farbe'))
  pruefe('Wahrheitswert als Text abgelehnt', einstellungenPruefen({ liveText: 'ja' }, basis).fehler.length === 1)
}

// --- Laden: alter/kaputter Stand faellt auf Vorgaben zurueck ---------------
{
  const w = einstellungenLaden({ modell: 'claude-entferntes-modell', aufwand: 'low' }, '/h')
  pruefe('entferntes Modell -> Vorgabe', w.modell === 'claude-opus-5-5')
  pruefe('restliche Werte bleiben', w.aufwand === 'low' && w.arbeitsordner === '/h')
  pruefe('null -> Vorgaben', einstellungenLaden(null, '/h').aufwand === 'high')
}

// --- Speicher ueber CockpitDb -------------------------------------------------
const verzeichnis = mkdtempSync(join(tmpdir(), 'umbau-einst-'))
const dbPfad = join(verzeichnis, 'test.db')
{
  let db = new CockpitDb(dbPfad)
  pruefe('frische DB: nichts gespeichert', db.einstellungenLesen() === null)
  let sp = new EinstellungsSpeicher(db, '/home/x')
  pruefe('frisch: Vorgaben', sp.lesen().modell === 'claude-opus-5-5' && sp.lesen().arbeitsordner === '/home/x')

  const r = sp.aendern({ modell: 'claude-haiku-4-5-20251001', favoriten: ['/p'] })
  pruefe('Aenderung gemeldet', r.geaendert && r.fehler.length === 0 && r.werte.modell === 'claude-haiku-4-5-20251001')
  const gleich = sp.aendern({ modell: 'claude-haiku-4-5-20251001' })
  pruefe('gleicher Wert: nicht geaendert', !gleich.geaendert)
  const falsch = sp.aendern({ aufwand: 'riesig' })
  pruefe('nur Fehler: nicht geaendert, Fehler gemeldet', !falsch.geaendert && falsch.fehler.length === 1)

  const kopie = sp.lesen()
  kopie.favoriten.push('/manipuliert')
  pruefe('lesen() gibt eine Kopie', sp.lesen().favoriten.length === 1)

  db.close()
  db = new CockpitDb(dbPfad)
  sp = new EinstellungsSpeicher(db, '/home/x')
  pruefe('nach Neustart erhalten', sp.lesen().modell === 'claude-haiku-4-5-20251001' && sp.lesen().favoriten[0] === '/p')
  db.close()
}
{
  const l = auswahlListen()
  pruefe('Auswahllisten vollstaendig', l.modelle.length === 3 && l.aufwaende.length === 5 && l.berechtigungen.length === 4)
}

rmSync(verzeichnis, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
