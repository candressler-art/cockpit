// Testet die Konten-Persistenz in CockpitDb (Sperren, Vorzug) gegen das
// gebaute Modul. Vorher `npm run build`, danach `node tests/db.test.mjs`.
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

const verzeichnis = mkdtempSync(join(tmpdir(), 'nachtschicht-db-'))
const dbPfad = join(verzeichnis, 'test.db')

// --- Kontosperren: Neustart darf eine laufende Sperre nicht vergessen ---
{
  const db = new CockpitDb(dbPfad)
  pruefe('frisch: keine Sperren gespeichert', Object.keys(db.kontoSperrenLesen()).length === 0)

  db.kontoSperren('zweit', 1_000_000)
  db.kontoSperren('dritt', 2_000_000)
  let sperren = db.kontoSperrenLesen()
  pruefe('zwei Sperren gespeichert', sperren.zweit === 1_000_000 && sperren.dritt === 2_000_000)

  // Ueberschreiben eines bereits gesperrten Kontos (neuer Fehler waehrend
  // der alten Sperre) muss den Wert ersetzen, nicht einen zweiten Eintrag anlegen.
  db.kontoSperren('zweit', 3_000_000)
  sperren = db.kontoSperrenLesen()
  pruefe('erneutes Sperren ueberschreibt statt zu verdoppeln',
    sperren.zweit === 3_000_000 && Object.keys(sperren).length === 2)
  db.close()
}

// --- Neu geoeffnete DB (simuliert Daemon-Neustart) sieht dieselben Sperren ---
{
  const db = new CockpitDb(dbPfad)
  const sperren = db.kontoSperrenLesen()
  pruefe('nach Neu-Oeffnen: Sperren ueberleben', sperren.zweit === 3_000_000 && sperren.dritt === 2_000_000)
  db.close()
}

// --- Vorzugskonto: setzen, aendern, aufheben ---
{
  const db = new CockpitDb(dbPfad)
  pruefe('frisch: kein Vorzug gespeichert', db.kontoVorzugLesen() === null)

  db.kontoVorzugSetzen('zweit')
  pruefe('Vorzug gesetzt', db.kontoVorzugLesen() === 'zweit')

  db.kontoVorzugSetzen('dritt')
  pruefe('Vorzug geaendert (kein zweiter Eintrag)', db.kontoVorzugLesen() === 'dritt')

  db.kontoVorzugSetzen(null)
  pruefe('Vorzug aufgehoben', db.kontoVorzugLesen() === null)
  db.close()
}

// --- Auch das Aufheben des Vorzugs ueberlebt einen Neustart ---
{
  const db = new CockpitDb(dbPfad)
  pruefe('nach Neu-Oeffnen: aufgehobener Vorzug bleibt aufgehoben', db.kontoVorzugLesen() === null)
  db.close()
}

rmSync(verzeichnis, { recursive: true, force: true })

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
