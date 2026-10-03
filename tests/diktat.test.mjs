// Reine Hilfen des Diktats (web/diktat.js) und das Herunterrechnen auf 16 kHz
// (web/hoeren.js) direkt in Node. bus.js liest beim Import location.host,
// deshalb vorher ein Stub.
globalThis.location = { host: 'localhost:8796', protocol: 'http:' }

const { regionBauen, trennerFuer, eingabeEinarbeiten, ankerNachEingabe, naechsterStapel, whisperGlaubhaft, PLATZHALTER } = await import('../web/diktat.js')
const { abtaster, pcmZuWav, RATE } = await import('../web/hoeren.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

// --- Text zusammensetzen --------------------------------------------------------
const satz = (vor, text, geprueft = false) => ({ art: 'satz', vor, text, von: 0, bis: 0, geprueft })
const fest = (text) => ({ art: 'fest', vor: '', text })
pruefe('Trenner: nach Text ein Leerzeichen, nach Leerraum keins',
  trennerFuer('Hallo') === ' ' && trennerFuer('Hallo\n') === '' && trennerFuer('') === '')
{
  const r = regionBauen([satz(' ', 'hallo tom'), satz(' ', 'wie gehts')], { vor: ' ', text: 'bis mor' })
  pruefe('Region woertlich hintereinander', r.text === ' hallo tom wie gehts bis mor')
  pruefe('Spannen samt Leerzeichen davor', JSON.stringify(r.spannen) === '[[0,10],[10,20]]' && JSON.stringify(r.vorschauSpanne) === '[20,28]')
}
pruefe('Satz ohne Text steht als Platzhalter', regionBauen([satz('', '')], null).text === PLATZHALTER)
pruefe('Leere Vorschau zaehlt nicht', regionBauen([], { vor: ' ', text: '' }).vorschauSpanne === null)

// --- Tippen waehrend des Diktats -------------------------------------------------------
// Region: " eins zwei drei" aus drei Saetzen, dazu die Vorschau " vier".
const drei = () => [satz(' ', 'eins'), satz(' ', 'zwei'), satz(' ', 'drei')]
const vorschau = { vor: ' ', text: 'vier' }
const altR = ' eins zwei drei vier'
{
  // "zwei" -> "2": nur der mittlere Satz wird fest.
  const e = eingabeEinarbeiten(drei(), vorschau, altR, ' eins 2 drei vier')
  pruefe('Nur der beruehrte Satz wird fest', e.teile.map((t) => t.art).join() === 'satz,fest,satz' && e.teile[1].text === ' 2')
  pruefe('Vorschau unberuehrt: laeuft weiter', !e.vorschauBeruehrt)
  pruefe('Region stimmt danach mit dem Feld', regionBauen(e.teile, vorschau).text === ' eins 2 drei vier')
}
{
  // Letztes Wort der Vorschau geloescht: sie wird fest, die Aeusserung beginnt neu.
  const e = eingabeEinarbeiten(drei(), vorschau, altR, ' eins zwei drei ')
  pruefe('Vorschau beruehrt', e.vorschauBeruehrt)
  pruefe('Region ohne Vorschau stimmt', regionBauen(e.teile, null).text === ' eins zwei drei ')
  pruefe('Saetze davor bleiben fuer Whisper', e.teile.filter((t) => t.art === 'satz').length === 3)
}
{
  // Punkt an "eins" angehaengt: der Satz ist beruehrt (Rand), "zwei" nicht.
  const e = eingabeEinarbeiten(drei(), vorschau, altR, ' eins. zwei drei vier')
  pruefe('Angehaengter Punkt: nur dieser Satz fest', e.teile.map((t) => t.art).join() === 'fest,satz,satz' && e.teile[0].text === ' eins.')
}
{
  // Nach den Saetzen mit Leerzeichen weitertippen: eigenes Wort, die Saetze bleiben.
  const e = eingabeEinarbeiten(drei(), null, ' eins zwei drei', ' eins zwei drei und zwar')
  pruefe('Mit Leerzeichen weitertippen: Saetze bleiben Saetze', e.teile.map((t) => t.art).join() === 'satz,satz,satz,fest' && regionBauen(e.teile, null).text === ' eins zwei drei und zwar')
}
{
  // Ohne Saetze einfach am Ende tippen.
  const e = eingabeEinarbeiten([], null, '', 'Hallo')
  pruefe('Getipptes ohne Diktat wird ein fester Teil', e.teile.length === 1 && e.teile[0].text === 'Hallo')
}
{
  // Alles markiert und geloescht.
  const e = eingabeEinarbeiten(drei(), vorschau, altR, '')
  pruefe('Alles geloescht: keine Teile mehr', e.teile.length === 0 && e.vorschauBeruehrt)
}

{
  // " zwei" durch "X" ersetzt: "eins" behaelt seine Buchstaben und bleibt Satz.
  const e = eingabeEinarbeiten(drei(), vorschau, altR, ' einsX drei vier')
  pruefe('Ersetzen bis an den Rand: der Nachbar bleibt Satz', e.teile.map((t) => t.art).join() === 'satz,fest,satz' && regionBauen(e.teile, vorschau).text === ' einsX drei vier')
  // Ueber zwei Saetze hinweg markiert und ersetzt: beide werden ein fester Teil.
  const g = eingabeEinarbeiten(drei(), vorschau, altR, ' eiY drei vier')
  pruefe('Ueber zwei Saetze: beide fest, der dritte bleibt', g.teile.map((t) => t.art).join() === 'fest,satz' && regionBauen(g.teile, vorschau).text === ' eiY drei vier')
  // Am Ende tippen, waehrend die Vorschau laeuft: die Vorschau wird fest.
  const f = eingabeEinarbeiten(drei(), vorschau, altR, altR + '!')
  pruefe('Am Ende tippen beruehrt die Vorschau', f.vorschauBeruehrt && regionBauen(f.teile, null).text === altR + '!')
}
{
  // Zufallsprobe: nach JEDER Eingabe muss das Modell genau den Feldtext
  // ergeben -- sonst ueberschriebe der naechste Satz Cans Aenderung.
  let fehler = 0
  let zufall = 42
  const rnd = (n) => { zufall = (zufall * 1103515245 + 12345) % 2147483648; return zufall % n }
  for (let lauf = 0; lauf < 3000; lauf++) {
    const teile = drei()
    const v = rnd(2) ? { vor: ' ', text: 'vier fuenf' } : null
    const altT = regionBauen(teile, v).text
    const a = rnd(altT.length + 1)
    const b = Math.min(altT.length, a + rnd(6))
    const einfuegen = ['', 'x', ' ', '.', 'neu ', '\n'][rnd(6)]
    const neuT = altT.slice(0, a) + einfuegen + altT.slice(b)
    if (neuT === altT) continue
    const e = eingabeEinarbeiten(teile, v, altT, neuT)
    if (regionBauen(e.teile, e.vorschauBeruehrt ? null : v).text !== neuT) fehler++
  }
  pruefe('Zufallsprobe: Modell = Feld nach 3000 Eingaben', fehler === 0)
}

// --- Wo die graue Region nach einer Eingabe beginnt ------------------------------------
const alt = 'Vorher: diktiert'
pruefe('Tippen in der Region laesst den Anker stehen', ankerNachEingabe(alt, 'Vorher: diktiertx', 8) === 8)
pruefe('Tippen davor verschiebt den Anker', ankerNachEingabe(alt, 'Ganz vorher: diktiert', 8) === 13)
pruefe('Loeschen davor verschiebt den Anker', ankerNachEingabe(alt, 'Vor: diktiert', 8) === 5)
pruefe('Aenderung ueber die Grenze zieht den Anker an ihren Anfang', ankerNachEingabe(alt, 'Vorhtiert', 8) === 4)

// --- Stapel fuer Whisper ----------------------------------------------------------------------
const s = (von, bis, geprueft = false) => ({ art: 'satz', vor: ' ', text: 'x', von, bis, geprueft })
pruefe('Stapel: nichts offen -> null', naechsterStapel([s(0, 10, true), fest('x')], 100) === null)
pruefe('Stapel: aufeinanderfolgende offene zusammen',
  JSON.stringify(naechsterStapel([s(0, 10, true), s(10, 20), s(20, 30), s(30, 40)], 100)) === '[1,4]')
pruefe('Stapel: Obergrenze trennt', JSON.stringify(naechsterStapel([s(0, 60), s(60, 120), s(120, 130)], 100)) === '[0,1]')
pruefe('Stapel: ein ueberlanger Satz geht allein', JSON.stringify(naechsterStapel([s(0, 500), s(500, 510)], 100)) === '[0,1]')
pruefe('Stapel: fester Teil trennt', JSON.stringify(naechsterStapel([s(0, 10), fest(' y'), s(20, 30)], 100)) === '[0,1]')

// --- Whisper-Erfindungen ----------------------------------------------------------------------
pruefe('Whisper normal glaubhaft', whisperGlaubhaft('Hallo Tom, wie geht es?', 'hallo tom wie gehts'))
pruefe('Whisper leer nicht glaubhaft', !whisperGlaubhaft('  ', 'hallo'))
pruefe('Abspanntext bei Rauschen verworfen', !whisperGlaubhaft('Untertitel im Auftrag des ZDF, 2021', ''))
pruefe('Untertitel, wenn wirklich gesagt, bleibt', whisperGlaubhaft('Die Untertitel fehlen.', 'die untertitel fehlen'))
pruefe('Whisper mit verschlucktem Anfang verworfen', !whisperGlaubhaft('Ich sage.', 'zeigen was ich sage'))
pruefe('Kurze Vorschau: Whisper darf anders zaehlen', whisperGlaubhaft('Okay.', 'ok gut'))

// --- 16 kHz -------------------------------------------------------------------------------
const aus48 = abtaster(48000)
const eins = aus48(new Float32Array(4800).fill(0.5))
pruefe('48 kHz -> 16 kHz: ein Drittel der Samples', eins.length === 1600)
pruefe('Pegel bleibt erhalten', Math.abs(eins[10] / 0x7fff - 0.5) < 0.001)
// 44,1 kHz in krummen Bloecken: in Summe ~16000 je Sekunde, nichts geht an den Blockgrenzen verloren.
const krumm = abtaster(44100)
let summe = 0
for (let i = 0; i < 441; i++) summe += krumm(new Float32Array(100)).length
pruefe('44,1 kHz in 100er-Bloecken: 16000 je Sekunde (+-1)', Math.abs(summe - RATE) <= 1)
const wav = pcmZuWav(new Int16Array(1600))
pruefe('WAV: Kopf + Daten', wav.size === 44 + 3200 && wav.type === 'audio/wav')

console.log(`\ndiktat: ${ok}/${gesamt}`)
if (ok !== gesamt) process.exit(1)
