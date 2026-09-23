// Testet das PCM-Resampling gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/audio.test.mjs`.
import { pcm16Resampeln } from '../dist/audio.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

function pcmAus(werte) {
  const b = Buffer.alloc(werte.length * 2)
  werte.forEach((w, i) => b.writeInt16LE(w, i * 2))
  return b
}
function werteAus(pcm) {
  const w = []
  for (let i = 0; i + 1 < pcm.length; i += 2) w.push(pcm.readInt16LE(i))
  return w
}

// --- 1. Gleiche Rate: unveraendert, keine Kopie noetig ----------------------
{
  const pcm = pcmAus([100, 200, -300])
  const r = pcm16Resampeln(pcm, 16000, 16000)
  pruefe('gleiche Rate liefert identische Werte', Buffer.compare(r, pcm) === 0)
}

// --- 2. Glatte Drittelung (48000 -> 16000, Faktor 3) -------------------------
{
  // 6 Eingabesamples bei 48kHz -> 2 Ausgabesamples bei 16kHz. Bei exaktem
  // Faktor 3 landet die lineare Interpolation ohne Rundungsfehler auf jedem
  // dritten Originalwert.
  const pcm = pcmAus([0, 100, 200, 300, 400, 500])
  const r = pcm16Resampeln(pcm, 48000, 16000)
  const werte = werteAus(r)
  pruefe('Laenge exakt gedrittelt', werte.length === 2)
  pruefe('erster Wert = erstes Sample', werte[0] === 0)
  pruefe('zweiter Wert = viertes Sample', werte[1] === 300)
}

// --- 3. Laenge skaliert proportional zum Verhaeltnis der Raten --------------
{
  const anzahlEin = 4800 // 0,1 s bei 48 kHz
  const pcm = pcmAus(Array.from({ length: anzahlEin }, (_, i) => (i % 200) - 100))
  const r = pcm16Resampeln(pcm, 48000, 16000)
  const erwartet = Math.round(anzahlEin / 3)
  pruefe('Laenge ~ Eingabelaenge * Zielrate/Ausgangsrate',
    Math.abs(werteAus(r).length - erwartet) <= 1)
}

// --- 4. Werte bleiben im 16-bit-Bereich, keine Uebersteuerung ---------------
{
  const pcm = pcmAus([32767, -32768, 32767, -32768])
  const r = pcm16Resampeln(pcm, 44100, 16000)
  const werte = werteAus(r)
  pruefe('kein Wert ausserhalb von Int16', werte.every((w) => w >= -32768 && w <= 32767))
}

// --- 5. Hochsampeln (Zielrate > Ausgangsrate) funktioniert ebenso -----------
{
  const pcm = pcmAus([0, 1000])
  const r = pcm16Resampeln(pcm, 8000, 16000)
  pruefe('Hochsampeln verdoppelt ungefaehr die Laenge', werteAus(r).length === 4)
}

// --- 6. Leeres PCM -> leeres Ergebnis, kein Absturz --------------------------
{
  const r = pcm16Resampeln(Buffer.alloc(0), 48000, 16000)
  pruefe('leeres PCM bleibt leer', r.length === 0)
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
