// Beszel-Abbildung und Mischen des eigenen Hosts (src/system.ts).
import assert from 'node:assert/strict'
import { beszelAbbilden, eigenenHostMischen, tempAusSensoren } from '../dist/system.js'

const jetzt = Date.parse('2026-09-24T19:27:30Z')

// Echte Form aus Beszel 0.9.1 (Zahlen aus dem Hub, Namen gekuerzt).
const systeme = [
  { id: 'a1', name: 'serverone', status: 'up', info: { h: 'serverone', c: 4, t: 8, m: 'Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz', u: 956723, cpu: 0.72, mp: 35.4, dp: 1.57, b: 0, v: '0.9.1' } },
  { id: 'b2', name: 'servertwo', status: 'up', info: { h: 'servertwo', c: 4, t: 4, m: 'Intel(R) Core(TM) i3-8100 CPU @ 3.60GHz', u: 435848, cpu: 2.22, mp: 32.6, dp: 7.34 } },
  { id: 'c3', name: 'weg', status: 'down', info: { t: 2 } },
]
const sysStats = [
  { system: 'b2', created: '2026-09-24 19:26:52.712Z', stats: { cpu: 2.22, m: 7.51, d: 220.63, t: { coretemp_core_0: 28, pch_cannonlake: 31, nvme_composite: 23.85 } } },
  { system: 'a1', created: '2026-09-24 19:26:22.680Z', stats: { cpu: 0.72, m: 31.22, d: 905.52, t: { acpitz: 27.8, acpitz_1: 29.8, coretemp_core_0: 20 } } },
  // aelterer Datensatz desselben Systems: darf den neuesten nicht ersetzen
  { system: 'a1', created: '2026-09-24 19:25:22.680Z', stats: { m: 1, d: 1, t: { x: 99 } } },
  // viel zu alt: Agent von c3 meldet seit Stunden nichts
  { system: 'c3', created: '2026-09-24 10:00:00.000Z', stats: { m: 2, t: { x: 40 } } },
]
const contStats = [
  { system: 'b2', created: '2026-09-24 19:26:52.000Z', stats: [{ n: 'pihole' }, { n: 'beszel-agent' }, { n: 'whisper' }] },
]

const [eins, zwei, weg] = beszelAbbilden(systeme, sysStats, contStats, jetzt)

// Der gemeldete Fehler: info.t ist die Thread-Zahl, keine Temperatur.
assert.notEqual(eins.tempC, 8, 'Thread-Zahl darf nicht als Temperatur erscheinen')
assert.equal(eins.tempC, 29.8, 'waermster Sensor aus system_stats')
assert.equal(zwei.tempC, 31)
assert.equal(eins.ramGesamtMb, Math.round(31.22 * 1024))
assert.equal(eins.plattenGesamtGb, 906)
assert.equal(eins.cpuProzent, 0.72)
assert.equal(eins.ramProzent, 35.4)
assert.equal(eins.plattenProzent, 1.57)
assert.equal(eins.uptimeSek, 956723)
assert.equal(eins.container, null, 'keine Container-Stats -> unbekannt, nicht 0')
assert.equal(zwei.container, 3)
assert.equal(weg.status, 'unbekannt')
assert.equal(weg.tempC, null, 'veraltete Stats zaehlen nicht, info.t schon gar nicht')
assert.equal(weg.ramGesamtMb, null)
assert.equal(weg.cpuProzent, null)

// Ohne Stats (fehlende Rechte o. ae.) bleiben nur die Prozentwerte.
const [nurInfo] = beszelAbbilden([systeme[0]], [], [], jetzt)
assert.equal(nurInfo.tempC, null)
assert.equal(nurInfo.ramGesamtMb, null)
assert.equal(nurInfo.cpuProzent, 0.72)

assert.equal(tempAusSensoren({ a: 0, b: -5, c: 200, d: '42.5' }), 42.5)
assert.equal(tempAusSensoren(null), null)
assert.equal(tempAusSensoren({}), null)

// Eigener Host: lokale Werte gewinnen, fehlende kommen aus Beszel.
const lokal = {
  name: 'servertwo', quelle: 'lokal', status: 'ok', cpuProzent: null, ramProzent: 36.4,
  ramGesamtMb: 7693, plattenProzent: 12.1, plattenGesamtGb: 221, tempC: null,
  uptimeSek: 435814, container: null, gemessenAm: jetzt + 1,
}
const m = eigenenHostMischen(zwei, lokal)
assert.equal(m.cpuProzent, 2.22, 'erste lokale CPU-Messung (null) ueberschreibt Beszel nicht')
assert.equal(m.tempC, 31)
assert.equal(m.ramProzent, 36.4, 'lokaler Wert gewinnt')
assert.equal(m.container, 3)
assert.equal(m.quelle, 'lokal')
assert.equal(m.gemessenAm, jetzt + 1)
const m2 = eigenenHostMischen(zwei, { ...lokal, cpuProzent: 0 })
assert.equal(m2.cpuProzent, 0, '0 % ist ein Messwert, kein fehlender')

console.log('system: ok')
