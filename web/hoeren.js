/**
 * Sprachaufnahme im Browser -- kein MediaRecorder, keine Web-Speech-API.
 *
 * Beide fehlen im WebKitGTK der Tauri-Huelle bzw. laufen bei der
 * Web-Speech-API ueber Googles Server, was hier niemand will. Stattdessen
 * wird das Mikrofon ueber denselben AudioContext angezapft, den
 * sprachpegel.js schon fuer die Pegelanzeige offen haelt: ein AudioWorklet
 * liest die rohen Samples ab, dieses Modul baut daraus 16-bit-PCM und ein
 * WAV, das an /api/hoeren geht. Auf 16 kHz resampelt wird serverseitig
 * (src/audio.ts) -- hier bleibt nur das Abgreifen und Verpacken.
 *
 * Automatisches Ende: 1,2 s unter der Pegelschwelle, NACHDEM schon einmal
 * Sprache erkannt wurde -- sonst wuerde eine Aufnahme, die mit einer
 * Kunstpause vor dem ersten Wort beginnt, sofort wieder abbrechen. Dazu eine
 * Obergrenze von 60 s und aufnahmeBeenden() fuer den Knopfdruck.
 */
import * as sp from './sprachpegel.js'

const SCHWELLE = 0.055
const STILLE_MS = 1200
const MAX_MS = 60_000
const PRUEF_MS = 100

let aktiv = false
let modulGeladen = false
let knoten = null
let stueckeF32 = []
let contextRate = 48000
let beendenFn = null
let ueberwachung = null

export const aufnahmeLaeuft = () => aktiv

function zusammenfuehren(stuecke) {
  let laenge = 0
  for (const s of stuecke) laenge += s.length
  const ganz = new Float32Array(laenge)
  let off = 0
  for (const s of stuecke) { ganz.set(s, off); off += s.length }
  return ganz
}

/** Float32-Samples (-1..1) zu einem abspiel-/hochladbaren WAV-Blob, 16-bit mono. */
function f32ZuWav(f32, rate) {
  const i16 = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const datenLaenge = i16.length * 2
  const puffer = new ArrayBuffer(44 + datenLaenge)
  const view = new DataView(puffer)
  const schreibString = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  schreibString(0, 'RIFF'); view.setUint32(4, 36 + datenLaenge, true); schreibString(8, 'WAVE')
  schreibString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  schreibString(36, 'data'); view.setUint32(40, datenLaenge, true)
  new Int16Array(puffer, 44).set(i16)
  return new Blob([puffer], { type: 'audio/wav' })
}

/**
 * Aufnahme starten. Loest mit einem WAV-Blob auf, sobald sie endet (Stille,
 * Obergrenze oder aufnahmeBeenden()) -- oder mit null, wenn kein Mikrofon
 * freigegeben wurde oder nichts aufgenommen werden konnte.
 */
export async function aufnahmeStarten() {
  if (aktiv) return null
  const ok = await sp.mikroAn()
  if (!ok) return null
  const ctx = sp.kontextLesen()
  const quelle = sp.mikroKnoten()
  if (!ctx || !quelle) return null

  contextRate = ctx.sampleRate
  stueckeF32 = []
  aktiv = true

  try {
    if (!modulGeladen) {
      await ctx.audioWorklet.addModule('./hoerer-prozessor.js')
      modulGeladen = true
    }
    const w = new AudioWorkletNode(ctx, 'hoerer-prozessor', { numberOfInputs: 1, numberOfOutputs: 0 })
    w.port.onmessage = (ev) => { if (aktiv) stueckeF32.push(ev.data) }
    quelle.connect(w)
    knoten = { node: w }
  } catch (e) {
    // Aeltere Engines kennen AudioWorklet moeglicherweise nicht;
    // ScriptProcessorNode ist veraltet, aber ueberall vorhanden. Ein
    // ScriptProcessor feuert nur, wenn er bis zu einem Ziel verbunden ist --
    // eine stumme Senke reicht, echte Ausgabe soll das nicht werden.
    console.warn('[hoeren] AudioWorklet nicht verfuegbar, nehme ScriptProcessor:', String(e))
    const proz = ctx.createScriptProcessor(4096, 1, 1)
    const senke = ctx.createGain()
    senke.gain.value = 0
    proz.onaudioprocess = (ev) => {
      if (aktiv) stueckeF32.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
    }
    quelle.connect(proz)
    proz.connect(senke)
    senke.connect(ctx.destination)
    knoten = { node: proz, senke }
  }

  return new Promise((loesen) => {
    let letzteSprache = null
    const start = performance.now()

    const beenden = () => {
      if (!aktiv) return
      aktiv = false
      clearInterval(ueberwachung)
      ueberwachung = null
      try {
        knoten.node.disconnect()
        knoten.senke?.disconnect()
      } catch { /* schon getrennt */ }
      knoten = null
      const roh = zusammenfuehren(stueckeF32)
      stueckeF32 = []
      beendenFn = null
      loesen(roh.length ? f32ZuWav(roh, contextRate) : null)
    }
    beendenFn = beenden

    ueberwachung = setInterval(() => {
      const jetzt = performance.now()
      const pegel = sp.standLesen().pegel
      if (pegel > SCHWELLE) letzteSprache = jetzt
      const seitStart = jetzt - start
      const seitSprache = letzteSprache === null ? 0 : jetzt - letzteSprache
      if (letzteSprache !== null && seitSprache > STILLE_MS) return beenden()
      if (seitStart > MAX_MS) return beenden()
    }, PRUEF_MS)
  })
}

/** Aufnahme sofort beenden -- der Knopfdruck waehrend "hört zu". */
export function aufnahmeBeenden() { beendenFn?.() }
