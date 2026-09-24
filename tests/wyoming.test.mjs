// Testet den Wyoming-Rahmen (schreiben + zerlegen) gegen das gebaute Modul,
// ohne Socket -- genau der Zweck der Trennung in wyoming.ts.
// Vorher `npm run build`, danach `node tests/wyoming.test.mjs`.
import { wyomingSchreiben, WyomingLeser } from '../dist/wyoming.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

// --- 1. Ereignis ohne Rohdaten -----------------------------------------------
{
  const bytes = wyomingSchreiben('audio-stop')
  pruefe('endet mit Zeilenumbruch', bytes[bytes.length - 1] === 0x0a)
  const leser = new WyomingLeser()
  const [e] = leser.schieben(bytes)
  pruefe('type korrekt', e?.type === 'audio-stop')
  pruefe('data leer', Object.keys(e?.data ?? { x: 1 }).length === 0)
  pruefe('kein payload', e?.payload === null)
}

// --- 2. Ereignis mit Rohdaten -------------------------------------------------
{
  const nutzlast = Buffer.from([1, 2, 3, 4, 5])
  const bytes = wyomingSchreiben('audio-chunk', { rate: 16000, width: 2, channels: 1 }, nutzlast)
  const leser = new WyomingLeser()
  const [e] = leser.schieben(bytes)
  pruefe('type korrekt', e?.type === 'audio-chunk')
  pruefe('data.rate korrekt', e?.data?.rate === 16000)
  pruefe('payload byteweise korrekt', Buffer.compare(e?.payload ?? Buffer.alloc(0), nutzlast) === 0)
}

// --- 3. Mehrere Ereignisse in einem Rutsch ------------------------------------
{
  const bytes = Buffer.concat([
    wyomingSchreiben('transcribe', { language: 'de' }),
    wyomingSchreiben('audio-start', { rate: 16000, width: 2, channels: 1 }),
    wyomingSchreiben('audio-stop'),
  ])
  const leser = new WyomingLeser()
  const ereignisse = leser.schieben(bytes)
  pruefe('drei Ereignisse auf einmal', ereignisse.length === 3)
  pruefe('Reihenfolge erhalten', ereignisse.map((e) => e.type).join(',') ===
    'transcribe,audio-start,audio-stop')
}

// --- 4. In beliebig kleine Stuecke zerschnitten -- wie ein echter Socket ----
{
  const ganz = Buffer.concat([
    wyomingSchreiben('audio-chunk', { rate: 16000 }, Buffer.from('hallowelt')),
    wyomingSchreiben('audio-stop'),
  ])
  const leser = new WyomingLeser()
  let gesammelt = []
  for (let i = 0; i < ganz.length; i += 3) {
    gesammelt = gesammelt.concat(leser.schieben(ganz.subarray(i, Math.min(i + 3, ganz.length))))
  }
  pruefe('trotz 3-Byte-Haeppchen beide Ereignisse da', gesammelt.length === 2)
  pruefe('payload trotzdem vollstaendig', gesammelt[0]?.payload?.toString('utf-8') === 'hallowelt')
  pruefe('zweites Ereignis korrekt', gesammelt[1]?.type === 'audio-stop')
}

// --- 5. Ein Ereignis kommt erst vollstaendig durch, wenn alles da ist -------
{
  const bytes = wyomingSchreiben('audio-chunk', {}, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  const leser = new WyomingLeser()
  const kopfEnde = bytes.indexOf(0x0a) + 1
  // Nur die Kopfzeile plus 2 von 8 Payload-Bytes -- das Ereignis darf noch
  // NICHT auftauchen.
  const teil1 = leser.schieben(bytes.subarray(0, kopfEnde + 2))
  pruefe('unvollstaendige Payload: noch kein Ereignis', teil1.length === 0)
  const teil2 = leser.schieben(bytes.subarray(kopfEnde + 2))
  pruefe('nach dem Rest: Ereignis vollstaendig da', teil2.length === 1)
}

// --- 6. Transcript-Ereignis, wie es Whisper tatsaechlich schickt -----------
{
  const bytes = Buffer.from(JSON.stringify({ type: 'transcript', data: { text: 'Hallo Welt' } }) + '\n')
  const leser = new WyomingLeser()
  const [e] = leser.schieben(bytes)
  pruefe('transcript-Text lesbar', e?.data?.text === 'Hallo Welt')
}

// --- 7. Kaputte Gegenstelle: sauberer Fehler statt Absturz oder Endlosschleife
// Kopfzeile `null` warf vorher einen TypeError im Socket-Handler (in stimme.ts
// ungefangen -> ganzer Daemon weg), eine nicht-numerische data_length liess
// die Schleife ohne Fortschritt ewig laufen (Daemon haengt).
{
  const faelle = [
    ['Kopfzeile null', 'null\n'],
    ['Kopfzeile Zahl', '42\n'],
    ['Kopfzeile ohne type', '{"data":{}}\n'],
    ['data_length kein Zahlwert', '{"type":"x","data_length":"abc"}\n'],
    ['data_length negativ', '{"type":"x","data_length":-5}\nabcdefgh\n'],
    ['payload_length gebrochen', '{"type":"x","payload_length":1.5}\nab'],
    ['Datenfeld null', '{"type":"x","data_length":4}\nnull'],
    ['data inline Liste', '{"type":"x","data":[1]}\n'],
  ]
  for (const [name, roh] of faelle) {
    let fehler = null
    try {
      new WyomingLeser().schieben(Buffer.from(roh))
    } catch (e) {
      fehler = e
    }
    pruefe(`${name}: wirft sauberen Fehler`, fehler instanceof Error && !(fehler instanceof TypeError))
  }
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
