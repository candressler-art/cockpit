// Testet die Buchfuehrung laufender Chat-Zuege (409 vs. kurzes Warten).
// Vorher `npm run build`, danach `node tests/chatZuege.test.mjs`.
import { ChatZuege } from '../dist/chatZuege.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

// Ein Zug, dessen Ende der Test selbst ausloest -- wie ein abgebrochener
// Agent, dessen SDK-Subprozess noch auslaeuft.
const offenerZug = () => {
  let ende
  const p = new Promise((r) => { ende = r })
  return { arbeit: () => p, ende }
}

{
  const z = new ChatZuege()
  pruefe('ohne Zug frei', await z.freiWerden('a', undefined, 10))
  const zug = offenerZug()
  z.starten('a', 7, zug.arbeit)
  pruefe('laeuft nach starten', z.laeuft('a') && z.startSeq('a') === 7)
  pruefe('arbeitender Agent -> nicht frei (sofort, ohne Warten)', !(await z.freiWerden('a', 'running', 5000)))
  pruefe('Status unbekannt -> nicht frei', !(await z.freiWerden('a', undefined, 5000)))

  // Der eigentliche Fund: Agent steht schon auf 'stopped', laeuft aber noch
  // aus. Vorher kam hier sofort 409; jetzt wird auf das Auslaufen gewartet.
  const t0 = Date.now()
  setTimeout(zug.ende, 30)
  const frei = await z.freiWerden('a', 'stopped', 5000)
  pruefe('gestoppter Zug laeuft aus -> frei', frei && !z.laeuft('a'))
  pruefe('...und zwar ohne die volle Wartezeit', Date.now() - t0 < 1000)
}

{
  const z = new ChatZuege()
  const zug = offenerZug()
  z.starten('b', 1, zug.arbeit)
  const t0 = Date.now()
  pruefe('haengender gestoppter Zug -> nach Frist nicht frei', !(await z.freiWerden('b', 'stopped', 40)))
  pruefe('...nach etwa der Frist', Date.now() - t0 >= 35)
  zug.ende()
  await new Promise((r) => setTimeout(r, 0))
  pruefe('danach geraeumt', !z.laeuft('b'))
}

{
  const z = new ChatZuege()
  z.starten('c', 1, async () => { throw new Error('kaputt') })
  await new Promise((r) => setTimeout(r, 0))
  pruefe('Ausnahme in arbeit raeumt den Eintrag', !z.laeuft('c'))
  z.starten('d', 1, async () => {})
  await new Promise((r) => setTimeout(r, 0))
  pruefe('sofort fertige arbeit raeumt den Eintrag', !z.laeuft('d'))
}

{
  // Ein neuer Zug nach dem Warten darf nicht vom finally des alten geloescht
  // werden -- sonst liesse er sich nicht mehr als laufend erkennen.
  const z = new ChatZuege()
  const alt = offenerZug()
  z.starten('e', 1, alt.arbeit)
  alt.ende()
  await z.freiWerden('e', 'done', 1000)
  const neu = offenerZug()
  z.starten('e', 2, neu.arbeit)
  await new Promise((r) => setTimeout(r, 0))
  pruefe('neuer Zug bleibt eingetragen', z.laeuft('e') && z.startSeq('e') === 2)
  neu.ende()
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
