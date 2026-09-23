// Prueft die Leseanfragen-Ausfuehrung (DATEI/GREP) des Orchestrators, vor
// allem den Groessendeckel gegen ein blockierendes readFileSync auf grossen
// Dateien -- ohne API-Kosten, reine Dateisystem-Funktion.
//
// Vorher `npm run build`, dann `node tests/orchestrator.test.mjs`.

import { leseZeileAusfuehren } from '../dist/orchestrator.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

const cwd = mkdtempSync(join(tmpdir(), 'nachtschicht-orch-'))
writeFileSync(join(cwd, 'klein.txt'), 'zeile eins\nzeile zwei\nzeile drei\n')
// Ueber dem 2-MB-Deckel in orchestrator.ts.
writeFileSync(join(cwd, 'gross.txt'), 'x'.repeat(3 * 1024 * 1024))

// --- DATEI: normale Datei wird gelesen -------------------------------------
{
  const r = leseZeileAusfuehren('DATEI klein.txt 1-2', cwd)
  pruefe('DATEI liest den angefragten Bereich', r.includes('1: zeile eins') && r.includes('2: zeile zwei'))
  pruefe('DATEI liefert nicht die dritte Zeile (Bereich endet bei 2)', !r.includes('zeile drei'))
}

// --- DATEI: zu grosse Datei wird abgelehnt, nicht komplett eingelesen -----
{
  const r = leseZeileAusfuehren('DATEI gross.txt 1-5', cwd)
  pruefe('DATEI lehnt eine zu grosse Datei ab', r.startsWith('abgelehnt') && r.includes('MB'))
}

// --- GREP: normale Datei wird durchsucht -----------------------------------
{
  const r = leseZeileAusfuehren('GREP zwei klein.txt', cwd)
  pruefe('GREP findet die passende Zeile', r.includes('2: zeile zwei'))
}

// --- GREP: zu grosse Datei wird abgelehnt, nicht komplett eingelesen ------
{
  const r = leseZeileAusfuehren('GREP x gross.txt', cwd)
  pruefe('GREP lehnt eine zu grosse Datei ab', r.startsWith('abgelehnt') && r.includes('MB'))
}

// --- Pfad-Ausbruch bleibt weiterhin verboten -------------------------------
{
  const r = leseZeileAusfuehren('DATEI ../ausserhalb.txt 1-5', cwd)
  pruefe('Pfad ausserhalb des Arbeitsverzeichnisses bleibt verboten', r.includes('ausserhalb des Arbeitsverzeichnisses'))
}

rmSync(cwd, { recursive: true, force: true })

console.log(`\n${ok}/${gesamt} bestanden`)
process.exit(ok === gesamt ? 0 : 1)
