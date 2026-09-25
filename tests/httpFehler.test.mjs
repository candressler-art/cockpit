// Testet die Zuordnung Ausnahme -> HTTP-Status fuer den Anfrage-Handler.
// Vorher `npm run build`, danach `node tests/httpFehler.test.mjs`.
import { AnfrageFehler, fehlerStatus, koerperAuswerten, textFeld } from '../dist/httpFehler.js'
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


// Gueltiges JSON, aber kein Objekt: POST /api/konten mit `[1,2]` hob frueher
// still den Kontovorzug auf und meldete ok.
for (const t of ['[1,2]', '"text"', '5', 'true']) {
  const f = await fang(() => koerperAuswerten(B(t), false, 1024))
  pruefe(`${t} als Koerper -> 400`, f instanceof AnfrageFehler && fehlerStatus(f) === 400 && /Objekt/.test(f.message))
}
pruefe('JSON-null zaehlt wie leer', koerperAuswerten(B('null'), false, 1024) === null)

// Textfelder: ein Objekt wurde frueher still zu "[object Object]" (und
// /api/lauf startete damit einen echten Agenten).
pruefe('Text bleibt Text', textFeld({ prompt: 'hallo' }, 'prompt') === 'hallo')
pruefe('fehlendes Feld -> undefined', textFeld({}, 'prompt') === undefined)
pruefe('null-Feld -> undefined', textFeld({ prompt: null }, 'prompt') === undefined)
pruefe('ohne Koerper -> undefined', textFeld(null, 'prompt') === undefined)
pruefe('Zahl wird Text wie bisher', textFeld({ id: 7 }, 'id') === '7')
for (const w of [{ x: 1 }, ['a']]) {
  const f = await fang(() => textFeld({ prompt: w }, 'prompt'))
  pruefe(`${JSON.stringify(w)} als Feld -> 400 mit Feldnamen`,
    f instanceof AnfrageFehler && fehlerStatus(f) === 400 && /prompt/.test(f.message))
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
