// Testet die Zuordnung Ausnahme -> HTTP-Status fuer den Anfrage-Handler.
// Vorher `npm run build`, danach `node tests/httpFehler.test.mjs`.
import { AnfrageFehler, fehlerStatus, koerperAuswerten } from '../dist/httpFehler.js'
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

// Anfragekoerper: frueher kam alles Unlesbare als null an ("prompt fehlt").
const B = (t) => Buffer.from(t, 'utf-8')
pruefe('leerer Koerper -> null', koerperAuswerten(null, false, 1024) === null)
pruefe('nur Leerraum -> null', koerperAuswerten(B(' \n'), false, 1024) === null)
pruefe('gueltiges JSON wird gelesen', koerperAuswerten(B('{"prompt":"hallo"}'), false, 1024)?.prompt === 'hallo')
const kaputt = await fang(() => koerperAuswerten(B('prompt=hallo'), false, 1024))
pruefe('kein JSON -> AnfrageFehler 400', kaputt instanceof AnfrageFehler && fehlerStatus(kaputt) === 400)
pruefe('Meldung nennt JSON', /JSON/.test(kaputt?.message ?? ''))
const gross = await fang(() => koerperAuswerten(null, true, 1024 * 1024))
pruefe('zu gross -> 413', fehlerStatus(gross) === 413)
pruefe('Meldung nennt Obergrenze', /1024 KB/.test(gross?.message ?? ''))

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
