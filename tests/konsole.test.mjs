// Verlauf des Terminal-Bereichs (src/konsole.ts).
import assert from 'node:assert/strict'
import { verlaufAufnehmen } from '../dist/konsole.js'

const v = []
verlaufAufnehmen(v, { id: 'a', phase: 'freigabe', befehl: 'ls', cwd: '/tmp' }, 1000)
verlaufAufnehmen(v, { id: 'a', phase: 'laeuft', befehl: 'ls', cwd: '/tmp' }, 2000)
verlaufAufnehmen(v, { id: 'a', phase: 'fertig', code: 0, stdout: 'x'.repeat(40000), stderr: '', dauerMs: 5 }, 3000)
assert.equal(v.length, 1, 'ein Befehl, ein Eintrag')
assert.equal(v[0].phase, 'fertig')
assert.equal(v[0].befehl, 'ls', 'Felder frueherer Phasen bleiben')
assert.equal(v[0].zeit, 1000, 'Zeit der Anfrage, nicht des Endes')
assert.ok(v[0].stdout.length < 34000 && v[0].stdout.endsWith('gekürzt]'), 'lange Ausgabe im Verlauf gekuerzt')

verlaufAufnehmen(v, { phase: 'fertig' })
assert.equal(v.length, 1, 'ohne Id nichts')

for (let i = 0; i < 5; i++) verlaufAufnehmen(v, { id: `b${i}`, phase: 'freigabe', befehl: `echo ${i}` }, 4000 + i, 3)
assert.deepEqual(v.map((e) => e.id), ['b2', 'b3', 'b4'], 'nur die juengsten bleiben')

console.log('konsole: ok')
