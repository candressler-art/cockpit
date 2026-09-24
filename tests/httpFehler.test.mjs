// Testet die Zuordnung Ausnahme -> HTTP-Status fuer den Anfrage-Handler.
// Vorher `npm run build`, danach `node tests/httpFehler.test.mjs`.
import { fehlerStatus } from '../dist/httpFehler.js'
import { readFile } from 'node:fs/promises'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

const fang = async (f) => { try { await f() } catch (e) { return e } }

// Echte Ausnahmen, wie sie im Handler entstehen -- nicht nachgebaut, damit ein
// geaenderter Fehlercode in Node hier auffaellt.
pruefe('kaputte Prozent-Kodierung -> 400', fehlerStatus(await fang(() => decodeURIComponent('%E0'))) === 400)
pruefe('fehlende Datei -> 404', fehlerStatus(await fang(() => readFile('/tmp/gibt-es-nicht-nachtschicht'))) === 404)
pruefe('Verzeichnis statt Datei -> 404', fehlerStatus(await fang(() => readFile('/tmp'))) === 404)
pruefe('Datei als Verzeichnis -> 404', fehlerStatus(await fang(() => readFile('/etc/hostname/x'))) === 404)
pruefe('sonstiger Fehler -> 500', fehlerStatus(new Error('kaputt')) === 500)
pruefe('Rechtefehler -> 500', fehlerStatus(Object.assign(new Error('x'), { code: 'EACCES' })) === 500)
pruefe('null -> 500', fehlerStatus(null) === 500)

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
