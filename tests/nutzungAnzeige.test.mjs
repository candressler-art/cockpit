// Reine Anzeigefunktionen des Bereichs Nutzung (web/ui/nutzung.js) direkt in
// Node. bus.js liest beim Import location.host, deshalb vorher ein Stub.
//
// Ersetzt tests/server.test.mjs der alten Oberflaeche und haelt dasselbe fest:
// "keine Messung" (Token abgelaufen, nie gemessen) ist nicht 0 %.
globalThis.location = { host: 'localhost:8796', protocol: 'http:' }

const { anteilProzent, messungText, stufenGrenzen, stufe } = await import('../web/ui/nutzung.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

pruefe('anteilProzent(null) ist keine Messung', anteilProzent(null) === null)
pruefe('anteilProzent(undefined) ist keine Messung', anteilProzent(undefined) === null)
pruefe('anteilProzent(0) ist wirklich 0', anteilProzent(0) === 0)
pruefe('anteilProzent rundet', anteilProzent(0.426) === 43)

pruefe('nie gemessen: eigener Text', messungText({ gemessenAm: null }) === 'noch nicht gemessen')
const t = new Date('2026-09-24T10:00:00Z').getTime()
pruefe('gemessen: nennt Zeit', messungText({ gemessenAm: t, quelle: 'usage_api' }).startsWith('gemessen '))
pruefe('aus einem Chat: sagt das', messungText({ gemessenAm: t, quelle: 'rate_limit_event' }).endsWith('(aus einem Chat)'))

pruefe('Tag ohne Tokens ist Stufe 0', stufe(0, stufenGrenzen([])) === 0 && stufe(0, stufenGrenzen([5])) === 0)
const g = stufenGrenzen([1, 2, 3, 4, 1000])
pruefe('Rekordtag macht andere nicht dunkel', stufe(3, g) >= 3 && stufe(1000, g) === 4)
pruefe('kleinster aktiver Tag ist Stufe >= 1', stufe(1, g) >= 1)

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
