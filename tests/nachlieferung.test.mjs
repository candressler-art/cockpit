// Testet die Nachlieferung nach `folgen`: seitenweise, mit Warten auf den
// Puffer statt Trennen, Live-Nachrichten erst hinterher.
// Vorher `npm run build`, danach `node tests/nachlieferung.test.mjs`.
import { nachliefern, senden, MAX_RUECKSTAU } from '../dist/nachlieferung.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

/** Socket-Attrappe: `bufferedAmount` waechst je Nachricht, abfliessen() leert ihn. */
function attrappe({ bytesJeNachricht = 0 } = {}) {
  const s = {
    readyState: 1, bufferedAmount: 0, hoechst: 0, gesendet: [], getrennt: false,
    send(t) {
      this.gesendet.push(JSON.parse(t)); this.bufferedAmount += bytesJeNachricht
      this.hoechst = Math.max(this.hoechst, this.bufferedAmount)
    },
    terminate() { this.getrennt = true; this.readyState = 3 },
    abfliessen() { this.bufferedAmount = 0 },
  }
  return s
}
const ereignisse = (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, runId: 'r', kind: 'text' }))
const quelle = (alle) => ({
  seite: (runId, ab, anzahl) => alle.filter((e) => e.seq > ab).slice(0, anzahl),
  abschluss: (runId) => [['agenten', []], ['bereit', { runId }]],
})
const seqs = (s) => s.gesendet.filter((m) => m.typ === 'ereignis').map((m) => m.daten.seq)

console.log('Nachlieferung')

// 1) Mehr als eine Seite: frueher war bei 5000 Schluss.
{
  const s = attrappe(), k = { sock: s, runId: null }
  await nachliefern(k, 'r', 0, quelle(ereignisse(12_000)), () => {}, { seitenGroesse: 500 })
  const q = seqs(s)
  pruefe('alle 12000 Ereignisse nachgeliefert', q.length === 12_000 && q[11_999] === 12_000)
  pruefe('Abschluss danach', s.gesendet.at(-1).typ === 'bereit' && s.gesendet.at(-2).typ === 'agenten')
  pruefe('ab seit, nicht ab 0', (await (async () => {
    const s2 = attrappe(), k2 = { sock: s2, runId: null }
    await nachliefern(k2, 'r', 10, quelle(ereignisse(20)), () => {})
    return seqs(s2)[0] === 11 && seqs(s2).length === 10
  })()))
  pruefe('Schlange danach aufgeloest', k.wartend === null)
}

// 2) Langsamer Klient: Puffer ueber der Grenze -> warten, nicht trennen.
{
  const s = attrappe({ bytesJeNachricht: 64 * 1024 }), k = { sock: s, runId: null }
  const zeitgeber = setInterval(() => s.abfliessen(), 20)
  let entfernt = false
  await nachliefern(k, 'r', 0, quelle(ereignisse(300)), () => { entfernt = true },
    { seitenGroesse: 100, pruefAbstandMs: 5 })
  clearInterval(zeitgeber)
  pruefe('langsamer Klient nicht getrennt', !s.getrennt && !entfernt)
  pruefe('langsamer Klient bekommt alles', seqs(s).length === 300)
  pruefe('Puffer nie ueber der Grenze', s.hoechst > 0 && s.hoechst <= MAX_RUECKSTAU)
}

// 3) Klient nimmt gar nichts mehr ab -> nach maxWartenMs trennen.
{
  const s = attrappe({ bytesJeNachricht: 64 * 1024 }), k = { sock: s, runId: null }
  let entfernt = false
  await nachliefern(k, 'r', 0, quelle(ereignisse(300)), () => { entfernt = true },
    { seitenGroesse: 100, maxWartenMs: 50, pruefAbstandMs: 5 })
  pruefe('haengender Klient getrennt', s.getrennt && entfernt)
  pruefe('kein Abschluss an getrennten Klienten', !s.gesendet.some((m) => m.typ === 'bereit'))
}

// 4) Live-Nachrichten waehrend der Nachlieferung kommen erst hinterher.
{
  const s = attrappe({ bytesJeNachricht: 64 * 1024 }), k = { sock: s, runId: null }
  const zeitgeber = setInterval(() => s.abfliessen(), 20)
  const lauf = nachliefern(k, 'r', 0, quelle(ereignisse(300)), () => {},
    { seitenGroesse: 100, pruefAbstandMs: 5 })
  senden(k, 'ereignis', { seq: 301, runId: 'r' }, () => {})
  senden(k, 'agent', { runId: 'r' }, () => {})
  await lauf
  clearInterval(zeitgeber)
  const q = seqs(s)
  pruefe('Live-Ereignis nach dem Rueckstand', q.length === 301 && q.at(-1) === 301)
  pruefe('Reihenfolge aufsteigend', q.every((x, i) => i === 0 || x > q[i - 1]))
  pruefe('Live danach direkt', (() => { senden(k, 'agent', {}, () => {}); return s.gesendet.at(-1).typ === 'agent' })())
}

// 5) Neues `folgen` mitten in einer Nachlieferung: die alte hoert auf.
{
  const s = attrappe({ bytesJeNachricht: 64 * 1024 }), k = { sock: s, runId: null }
  const zeitgeber = setInterval(() => s.abfliessen(), 20)
  const alt = nachliefern(k, 'r', 0, quelle(ereignisse(300)), () => {},
    { seitenGroesse: 100, pruefAbstandMs: 5 })
  await new Promise((r) => setTimeout(r, 10))
  const andere = [{ seq: 1, runId: 'x', kind: 'text' }]
  const neu = nachliefern(k, 'x', 0, { seite: (r, ab) => andere.filter((e) => e.seq > ab), abschluss: (runId) => [['bereit', { runId }]] }, () => {})
  await Promise.all([alt, neu])
  clearInterval(zeitgeber)
  const bereit = s.gesendet.filter((m) => m.typ === 'bereit')
  pruefe('nur ein Abschluss (vom neuen folgen)', bereit.length === 1 && bereit[0].daten.runId === 'x')
  pruefe('runId umgestellt', k.runId === 'x' && k.wartend === null)
}

// 6) Ohne Lauf: kein Ereignis, nur Abschluss.
{
  const s = attrappe(), k = { sock: s, runId: 'alt' }
  await nachliefern(k, null, 0, quelle(ereignisse(5)), () => {})
  pruefe('ohne Lauf nur Abschluss', seqs(s).length === 0 && s.gesendet.at(-1).daten.runId === null)
}

// 7) Wirft die Quelle, bleibt der Klient bedienbar.
{
  const s = attrappe(), k = { sock: s, runId: null }
  const alt = console.error; console.error = () => {}
  await nachliefern(k, 'r', 0, { seite: () => { throw new Error('db weg') }, abschluss: () => [] }, () => {})
  console.error = alt
  senden(k, 'agent', {}, () => {})
  pruefe('nach Quellfehler wieder live', k.wartend === null && s.gesendet.at(-1)?.typ === 'agent')
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
