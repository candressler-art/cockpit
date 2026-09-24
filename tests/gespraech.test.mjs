// Testet, dass sich zwei Runden des Sprachgespraechs nicht ueberlappen.
// Vorher `npm run build`, danach `node tests/gespraech.test.mjs`.
import { gespraechAntworten, GespraechBelegt } from '../dist/gespraech.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

// Supervisor-Attrappe: agentStarten endet erst, wenn der Test es will.
// Zaehlt, wie viele Agenten gleichzeitig unter demselben Schluessel laufen
// -- genau das darf nie mehr als einer sein (supervisor.laufende haelt je
// Schluessel nur einen AbortController, der zweite ueberschriebe den ersten).
const attrappe = () => {
  const offen = []
  let gleichzeitig = 0, hoechstens = 0
  return {
    offen,
    get hoechstens() { return hoechstens },
    agentStarten(o) {
      gleichzeitig++
      hoechstens = Math.max(hoechstens, gleichzeitig)
      return new Promise((r) => offen.push((fehler = null) => {
        gleichzeitig--
        r({ ergebnis: null, volltext: `Antwort auf ${o.prompt}`, fehler })
      }))
    },
    agentenListe() { return [{ agentId: 'gespraech', sessionId: 's1' }] },
  }
}

{
  const s = attrappe()
  const erste = gespraechAntworten(s, 'eins', undefined)
  // Zweite Runde, waehrend die erste noch denkt (App und Handy zugleich,
  // oder Seite neu geladen, waehrend die alte Anfrage noch lief).
  let zweiteFehler = null
  await gespraechAntworten(s, 'zwei', 's1').catch((e) => { zweiteFehler = e })
  pruefe('zweite Runde waehrend der ersten -> GespraechBelegt', zweiteFehler instanceof GespraechBelegt)
  pruefe('nie zwei Agenten zugleich', s.hoechstens === 1)
  s.offen[0]()
  const a = await erste
  pruefe('erste Runde liefert ihre Antwort', a.text === 'Antwort auf eins' && a.sessionId === 's1')

  // Danach wieder frei.
  const dritte = gespraechAntworten(s, 'drei', 's1')
  s.offen[1]()
  pruefe('nach Ende der ersten wieder frei', (await dritte).text === 'Antwort auf drei')
}

{
  // Auch ein Fehlschlag gibt die Sperre wieder frei.
  const s = attrappe()
  const p = gespraechAntworten(s, 'eins', undefined)
  s.offen[0]('Not logged in')
  let fehler = null
  await p.catch((e) => { fehler = e })
  pruefe('Fehler der Runde wird weitergereicht', fehler instanceof Error && !(fehler instanceof GespraechBelegt))
  const q = gespraechAntworten(s, 'zwei', undefined)
  s.offen[1]()
  pruefe('nach Fehlschlag wieder frei', (await q).text === 'Antwort auf zwei')
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
