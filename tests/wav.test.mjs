// Testet WAV-Kopf bauen/lesen gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/wav.test.mjs`.
import { wavBauen, wavLesen } from '../dist/wav.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

// --- 1. Rundreise: bauen, dann lesen -- muss dieselben Werte liefern -------
{
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]) // vier 16-bit-Samples
  const wav = wavBauen(pcm, 16000, 2, 1)
  const gelesen = wavLesen(wav)
  pruefe('Rundreise: rate stimmt', gelesen?.rate === 16000)
  pruefe('Rundreise: breite stimmt', gelesen?.breite === 2)
  pruefe('Rundreise: kanaele stimmt', gelesen?.kanaele === 1)
  pruefe('Rundreise: pcm stimmt byteweise', Buffer.compare(gelesen?.pcm ?? Buffer.alloc(0), pcm) === 0)
}

// --- 2. Kopfgroesse und RIFF/WAVE-Kennung -----------------------------------
{
  const pcm = Buffer.alloc(100)
  const wav = wavBauen(pcm, 22050, 2, 1)
  pruefe('Gesamtlaenge = 44 + PCM', wav.length === 144)
  pruefe('RIFF-Kennung am Anfang', wav.toString('ascii', 0, 4) === 'RIFF')
  pruefe('WAVE-Kennung', wav.toString('ascii', 8, 12) === 'WAVE')
  pruefe('data-Chunk-Laenge im Kopf', wav.readUInt32LE(40) === pcm.length)
}

// --- 3. Stereo und andere Breite ueberleben die Rundreise -------------------
{
  const pcm = Buffer.alloc(24) // 6 Stereo-Samples * 2 Byte
  const wav = wavBauen(pcm, 44100, 2, 2)
  const gelesen = wavLesen(wav)
  pruefe('Stereo: kanaele=2 erhalten', gelesen?.kanaele === 2)
  pruefe('Stereo: rate erhalten', gelesen?.rate === 44100)
}

// --- 4. Kein WAV -> null, nicht werfen --------------------------------------
{
  pruefe('leerer Buffer -> null', wavLesen(Buffer.alloc(0)) === null)
  pruefe('zu kurz fuer RIFF -> null', wavLesen(Buffer.from('RIFF')) === null)
  pruefe('falsche Kennung -> null', wavLesen(Buffer.from('dies ist kein WAV, nur Text')) === null)
}

// --- 5. Zusaetzliche Chunks vor 'data' werden ueberlesen --------------------
{
  // Ein WAV von Hand gebaut, mit einem erfundenen 'LIST'-Chunk zwischen 'fmt '
  // und 'data' -- ein 44-Byte-Kopf allein deckt das nicht ab, aber genau so
  // koennte eine WAV-Datei aus einer anderen Quelle als dieser Codebasis
  // aussehen.
  const chunk = (kennung, inhalt) => {
    const laenge = Buffer.alloc(4)
    laenge.writeUInt32LE(inhalt.length, 0)
    return Buffer.concat([Buffer.from(kennung, 'ascii'), laenge, inhalt])
  }
  const fmtInhalt = Buffer.alloc(16)
  fmtInhalt.writeUInt16LE(1, 0)      // PCM
  fmtInhalt.writeUInt16LE(1, 2)      // 1 Kanal
  fmtInhalt.writeUInt32LE(16000, 4)  // Rate
  fmtInhalt.writeUInt32LE(32000, 8)  // byteRate
  fmtInhalt.writeUInt16LE(2, 12)     // blockAlign
  fmtInhalt.writeUInt16LE(16, 14)    // bits/Probe

  const pcm = Buffer.from([9, 9, 8, 8])
  const fmtChunk = chunk('fmt ', fmtInhalt)
  const listChunk = chunk('LIST', Buffer.from('INFO'))
  const dataChunk = chunk('data', pcm)
  const rumpf = Buffer.concat([Buffer.from('WAVE'), fmtChunk, listChunk, dataChunk])
  const riffLaenge = Buffer.alloc(4)
  riffLaenge.writeUInt32LE(rumpf.length, 0)
  const ganz = Buffer.concat([Buffer.from('RIFF'), riffLaenge, rumpf])

  const gelesen = wavLesen(ganz)
  pruefe('Chunk vor data wird ueberlesen', gelesen !== null)
  pruefe('pcm hinter fremdem Chunk korrekt gelesen', Buffer.compare(gelesen?.pcm ?? Buffer.alloc(0), pcm) === 0)
  pruefe('rate trotz Zwischenchunk korrekt', gelesen?.rate === 16000)
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
