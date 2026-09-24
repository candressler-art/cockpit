// Testet die Eingabepruefung fuer /api/lauf, /api/orchestrator und /api/konsole.
// Vorher `npm run build`, danach `node tests/eingaben.test.mjs`.
import { cwdPruefen, zahlLesen } from '../dist/eingaben.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

console.log('cwdPruefen')
pruefe('Verzeichnis ok', cwdPruefen('/tmp') === null)
pruefe('leer -> cwd fehlt', cwdPruefen('') === 'cwd fehlt')
pruefe('relativ abgelehnt', /absoluter Pfad/.test(cwdPruefen('tmp') ?? ''))
pruefe('fehlendes Verzeichnis abgelehnt', /gibt es auf diesem Host nicht/.test(cwdPruefen('/gibt-es-nicht-nachtschicht') ?? ''))
pruefe('Datei statt Verzeichnis abgelehnt', /kein Verzeichnis/.test(cwdPruefen('/etc/hostname') ?? ''))

console.log('zahlLesen')
const r = { min: 1, ganzzahlig: true }
pruefe('fehlt -> Standard', zahlLesen(undefined, 'x', r).zahl === undefined && !zahlLesen(undefined, 'x', r).fehler)
pruefe('null/leer -> Standard', !zahlLesen(null, 'x', r).fehler && !zahlLesen('', 'x', r).fehler)
pruefe('Zahl ok', zahlLesen(6, 'x', r).zahl === 6)
pruefe('Zahl als Text ok', zahlLesen(' 3 ', 'x', r).zahl === 3)
pruefe('Text -> Fehler', zahlLesen('abc', 'maxRunden', r).fehler === 'maxRunden muss eine Zahl sein')
pruefe('Objekt -> Fehler', Boolean(zahlLesen({}, 'x', r).fehler))
pruefe('true -> Fehler (nicht 1)', Boolean(zahlLesen(true, 'x', r).fehler))
pruefe('Unendlich -> Fehler', Boolean(zahlLesen(Infinity, 'x', r).fehler))
pruefe('0 unter min -> Fehler', zahlLesen(0, 'x', r).fehler === 'x muss mindestens 1 sein')
pruefe('Bruch bei ganzzahlig -> Fehler', Boolean(zahlLesen(1.5, 'x', r).fehler))
pruefe('Bruch ohne ganzzahlig ok', zahlLesen(0.5, 'x', { min: 0 }).zahl === 0.5)
pruefe('0 bei min 0 ok (tokenBudget aus)', zahlLesen(0, 'x', { min: 0, ganzzahlig: true }).zahl === 0)

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
