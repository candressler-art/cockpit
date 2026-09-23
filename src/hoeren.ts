// Spracherkennung ueber Whisper (Wyoming-Protokoll).
//
// Symmetrisch zu stimme.ts: dieselbe Kopfzeile-plus-Rohdaten-Form, nur in
// die andere Richtung -- wir SCHICKEN Audio und bekommen Text zurueck. Der
// Browser liefert fertiges WAV an /api/hoeren; diese Stelle liest es aus,
// resampelt bei Bedarf auf 16 kHz und reicht das PCM an den
// wyoming-whisper-Container weiter (deploy/stacks/whisper.yml).

import { connect } from 'node:net'
import { wavLesen } from './wav.js'
import { pcm16Resampeln } from './audio.js'
import { wyomingSchreiben, WyomingLeser } from './wyoming.js'

const HOST = process.env.WHISPER_HOST ?? '127.0.0.1'
const PORT = Number(process.env.WHISPER_PORT ?? 10300)
const TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS ?? 20_000)

const ZIEL_RATE = 16000
/**
 * PCM-Menge je Wyoming-Rahmen. Klein genug, dass ein einzelner Rahmen nicht
 * unnoetig gross wird, gross genug, dass eine kurze Aeusserung (ein paar
 * Sekunden bei 16 kHz/16 bit) nicht in hunderte Rahmen zerfaellt.
 */
const CHUNK_BYTES = 32 * 1024

export class HoerenFehler extends Error {}

export interface Erkennung {
  text: string
  dauerMs: number
}

/**
 * WAV erkennen lassen. Wirft HoerenFehler, wenn Whisper nicht erreichbar
 * ist, das WAV nicht lesbar war oder kein Transkript kam -- der Aufrufer
 * (daemon.ts) antwortet darauf mit 503, wie bei /api/sprechen: der Browser
 * soll den Ausfall des Erkennungsdiensts von einem echten Serverfehler
 * unterscheiden koennen.
 */
export function erkennen(wav: Buffer, sprache = 'de'): Promise<Erkennung> {
  const start = Date.now()

  const gelesen = wavLesen(wav)
  if (!gelesen) return Promise.reject(new HoerenFehler('WAV nicht lesbar'))
  if (gelesen.breite !== 2) {
    return Promise.reject(
      new HoerenFehler(`nur 16-bit-PCM unterstuetzt (bekam ${gelesen.breite * 8} bit)`),
    )
  }
  if (gelesen.kanaele !== 1) {
    return Promise.reject(
      new HoerenFehler(`nur mono unterstuetzt (bekam ${gelesen.kanaele} Kanäle)`),
    )
  }

  const pcm = pcm16Resampeln(gelesen.pcm, gelesen.rate, ZIEL_RATE)
  if (pcm.length === 0) return Promise.reject(new HoerenFehler('leeres Audio'))

  return new Promise<Erkennung>((loesen, ablehnen) => {
    const sock = connect({ host: HOST, port: PORT })
    const leser = new WyomingLeser()
    let text: string | null = null
    let fertig = false

    const uhr = setTimeout(() => {
      if (fertig) return
      fertig = true
      sock.destroy()
      ablehnen(new HoerenFehler(`Whisper antwortet nicht innerhalb von ${TIMEOUT_MS} ms`))
    }, TIMEOUT_MS)

    const abschliessen = (fehler: Error | null): void => {
      if (fertig) return
      fertig = true
      clearTimeout(uhr)
      sock.destroy()
      if (fehler) return ablehnen(fehler)
      if (text === null) return ablehnen(new HoerenFehler('Whisper lieferte kein Transkript'))
      loesen({ text, dauerMs: Date.now() - start })
    }

    sock.on('error', (e) => abschliessen(new HoerenFehler(`Whisper nicht erreichbar: ${e.message}`)))
    sock.on('close', () =>
      abschliessen(text === null ? new HoerenFehler('Whisper hat die Verbindung geschlossen') : null),
    )

    sock.on('connect', () => {
      sock.write(wyomingSchreiben('transcribe', { language: sprache }))
      sock.write(wyomingSchreiben('audio-start', { rate: ZIEL_RATE, width: 2, channels: 1 }))
      for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
        const stueck = pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.length))
        sock.write(wyomingSchreiben('audio-chunk', { rate: ZIEL_RATE, width: 2, channels: 1 }, stueck))
      }
      sock.write(wyomingSchreiben('audio-stop'))
    })

    sock.on('data', (teil: Buffer) => {
      let ereignisse
      try {
        ereignisse = leser.schieben(teil)
      } catch (e) {
        return abschliessen(new HoerenFehler(`Whisper schickte kein gueltiges Ereignis: ${String(e)}`))
      }
      for (const e of ereignisse) {
        if (e.type === 'transcript') {
          text = String(e.data.text ?? '').trim()
          return abschliessen(null)
        } else if (e.type === 'error') {
          return abschliessen(new HoerenFehler(String(e.data.text ?? 'Whisper meldete einen Fehler')))
        }
      }
    })
  })
}
