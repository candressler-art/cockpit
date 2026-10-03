// Regeln der Chat-Warteschlange (src/warteschlange.ts). Vorher `npm run build`.
import { schlangeEntscheiden, schlangeOptionen } from '../dist/warteschlange.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

const e = (nr, erstellt, gehalten = false, optionen = {}) => ({ nr, text: `t${nr}`, anhaenge: [], optionen, erstellt, gehalten })
const nrs = (l) => l.map((x) => (typeof x === 'number' ? x : x.nr)).join(',')
const lage = (status, extra = {}) => ({ status, angehaltenAm: null, trotzHalt: false, ...extra })

{
  const r = schlangeEntscheiden([e(1, 100), e(2, 200)], lage('done'))
  pruefe('fertig: alles raus, nichts halten', nrs(r.senden) === '1,2' && r.halten.length === 0)
}
{
  const r = schlangeEntscheiden([e(1, 100), e(2, 200, true)], lage('done'))
  pruefe('fertig: Gehaltenes bleibt stehen', nrs(r.senden) === '1' && r.halten.length === 0)
}
{
  const r = schlangeEntscheiden([e(1, 100)], lage('failed'))
  pruefe('fehlgeschlagen: trotzdem raus (Claude sieht den Faden)', nrs(r.senden) === '1')
}
{
  const r = schlangeEntscheiden([e(1, 100), e(2, 200)], lage('waiting_ratelimit'))
  pruefe('kein Konto: alles halten', r.senden.length === 0 && nrs(r.halten) === '1,2')
}
{
  // W1 aus dem Review: "loesch danach den Branch" eingereiht, dann angehalten.
  const r = schlangeEntscheiden([e(1, 100), e(2, 300)], lage('stopped', { angehaltenAm: 200 }))
  pruefe('angehalten: Altes halten, Neues (nach dem Halt) raus', nrs(r.halten) === '1' && nrs(r.senden) === '2')
}
{
  const r = schlangeEntscheiden([e(1, 100), e(2, 300)], lage('stopped'))
  pruefe('angehalten ohne bekannte Zeit: alles halten', r.senden.length === 0 && nrs(r.halten) === '1,2')
}
{
  const r = schlangeEntscheiden([e(1, 100, true), e(2, 200)], lage('stopped', { trotzHalt: true }))
  pruefe('"Jetzt senden": auch Gehaltenes raus', nrs(r.senden) === '1,2' && r.halten.length === 0)
}
{
  const r = schlangeEntscheiden([], lage('done'))
  pruefe('leer: nichts zu tun', r.senden.length === 0 && r.halten.length === 0)
}

// W2 aus dem Review: Plan mit "Selbststaendig" angenommen, waehrend eine
// Nachricht mit 'plan' wartete -- der Modus darf nicht zurueckspringen.
pruefe('Optionen: die der letzten Nachricht', schlangeOptionen([e(1, 100, false, { berechtigung: 'auto' }), e(2, 200, false, { berechtigung: 'plan' })], 150).berechtigung === 'plan')
pruefe('Optionen: am Chat seither umgestellt -> wie gemerkt', Object.keys(schlangeOptionen([e(1, 100, false, { berechtigung: 'plan' })], 150)).length === 0)
pruefe('Optionen: nie gemerkt -> die der Nachricht', schlangeOptionen([e(1, 100, false, { modell: 'auto' })], null).modell === 'auto')
pruefe('Optionen: nichts zu senden -> {}', Object.keys(schlangeOptionen([], null)).length === 0)

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
