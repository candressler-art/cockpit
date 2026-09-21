// Sprachausgabe ueber Piper (Wyoming-Protokoll).
//
// Wyoming ist zeilenweises JSON ueber TCP: eine Kopfzeile je Ereignis,
// danach optional Rohdaten, deren Laenge im Kopf steht. Fuer die
// Sprachausgabe sind drei Ereignisse relevant -- audio-start nennt Rate und
// Breite, audio-chunk traegt die Rohdaten, audio-stop schliesst ab.
//
// Der Daemon liefert daraus fertiges WAV aus. Der Browser bekommt Piper also
// nie zu sehen; der Container haengt auf 127.0.0.1 und braucht keinen eigenen
// Weg nach aussen.

import { connect } from 'node:net'

const HOST = process.env.PIPER_HOST ?? '127.0.0.1'
const PORT = Number(process.env.PIPER_PORT ?? 10200)
const TIMEOUT_MS = Number(process.env.PIPER_TIMEOUT_MS ?? 20_000)

/** Laengster Text, den wir sprechen. Alles darueber wird abgeschnitten. */
const MAX_ZEICHEN = 1200

export class StimmeFehler extends Error {}

interface WyomingKopf {
  type: string
  data?: Record<string, unknown>
  data_length?: number | null
  payload_length?: number | null
}

/**
 * WAV-Kopf um rohes PCM legen.
 *
 * Piper liefert nacktes PCM; ein <audio>-Element im Browser spielt das nicht.
 * 44 Byte Kopf davor, und es ist eine abspielbare Datei.
 */
function wavBauen(pcm: Buffer, rate: number, breite: number, kanaele: number): Buffer {
  const kopf = Buffer.alloc(44)
  const bitsProProbe = breite * 8
  const byteRate = rate * kanaele * breite
  kopf.write('RIFF', 0)
  kopf.writeUInt32LE(36 + pcm.length, 4)
  kopf.write('WAVE', 8)
  kopf.write('fmt ', 12)
  kopf.writeUInt32LE(16, 16)
  kopf.writeUInt16LE(1, 20) // PCM, unkomprimiert
  kopf.writeUInt16LE(kanaele, 22)
  kopf.writeUInt32LE(rate, 24)
  kopf.writeUInt32LE(byteRate, 28)
  kopf.writeUInt16LE(kanaele * breite, 32)
  kopf.writeUInt16LE(bitsProProbe, 34)
  kopf.write('data', 36)
  kopf.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([kopf, pcm])
}

/**
 * Einen Satz sprechen lassen. Gibt fertiges WAV zurueck.
 *
 * Wirft StimmeFehler, wenn Piper nicht erreichbar ist oder nichts liefert --
 * der Aufrufer antwortet darauf mit 503, damit der Browser auf seine eigene
 * Stimme umschalten kann, statt stumm zu bleiben.
 */
export function sprechen(text: string): Promise<Buffer> {
  const sauber = text.trim().slice(0, MAX_ZEICHEN)
  if (!sauber) return Promise.reject(new StimmeFehler('leerer Text'))

  return new Promise<Buffer>((loesen, ablehnen) => {
    const sock = connect({ host: HOST, port: PORT })
    let puffer = Buffer.alloc(0)
    const stuecke: Buffer[] = []
    let rate = 22050
    let breite = 2
    let kanaele = 1
    let fertig = false

    const uhr = setTimeout(() => {
      if (fertig) return
      fertig = true
      sock.destroy()
      ablehnen(new StimmeFehler(`Piper antwortet nicht innerhalb von ${TIMEOUT_MS} ms`))
    }, TIMEOUT_MS)

    const abschliessen = (fehler: Error | null) => {
      if (fertig) return
      fertig = true
      clearTimeout(uhr)
      sock.destroy()
      if (fehler) return ablehnen(fehler)
      const pcm = Buffer.concat(stuecke)
      if (pcm.length === 0) return ablehnen(new StimmeFehler('Piper lieferte kein Audio'))
      loesen(wavBauen(pcm, rate, breite, kanaele))
    }

    sock.on('error', (e) => abschliessen(new StimmeFehler(`Piper nicht erreichbar: ${e.message}`)))
    sock.on('close', () => abschliessen(new StimmeFehler('Piper hat die Verbindung geschlossen')))

    sock.on('connect', () => {
      sock.write(JSON.stringify({ type: 'synthesize', data: { text: sauber } }) + '\n')
    })

    sock.on('data', (teil: Buffer) => {
      puffer = Buffer.concat([puffer, teil])

      // Solange ein vollstaendiges Ereignis im Puffer liegt, eines abarbeiten.
      // Ein Ereignis ist erst vollstaendig, wenn auch seine angekuendigten
      // Rohdaten da sind -- sonst wartet die Schleife auf mehr Bytes.
      for (;;) {
        const nl = puffer.indexOf(0x0a)
        if (nl < 0) return

        let kopf: WyomingKopf
        try {
          kopf = JSON.parse(puffer.subarray(0, nl).toString('utf-8')) as WyomingKopf
        } catch {
          return abschliessen(new StimmeFehler('Piper schickte kein gueltiges JSON'))
        }

        const dLen = kopf.data_length ?? 0
        const pLen = kopf.payload_length ?? 0
        const gesamt = nl + 1 + dLen + pLen
        if (puffer.length < gesamt) return // noch nicht alles da

        let daten = kopf.data ?? {}
        if (dLen > 0) {
          try {
            daten = JSON.parse(puffer.subarray(nl + 1, nl + 1 + dLen).toString('utf-8'))
          } catch {
            return abschliessen(new StimmeFehler('Piper schickte kein gueltiges Datenfeld'))
          }
        }
        const nutzlast = pLen > 0 ? puffer.subarray(nl + 1 + dLen, gesamt) : null
        puffer = puffer.subarray(gesamt)

        if (kopf.type === 'audio-start') {
          rate = Number(daten.rate ?? rate)
          breite = Number(daten.width ?? breite)
          kanaele = Number(daten.channels ?? kanaele)
        } else if (kopf.type === 'audio-chunk') {
          if (nutzlast) stuecke.push(Buffer.from(nutzlast))
        } else if (kopf.type === 'audio-stop') {
          return abschliessen(null)
        } else if (kopf.type === 'error') {
          return abschliessen(new StimmeFehler(String(daten.text ?? 'Piper meldete einen Fehler')))
        }
      }
    })
  })
}

/**
 * Kleiner Zwischenspeicher fuer wiederkehrende Saetze.
 *
 * "Der Lauf ist fertig." und "Eine Freigabe wartet." kommen staendig; sie
 * jedes Mal neu zu rechnen kostet auf vier Kernen unnoetig Zeit, die den
 * Agenten fehlt. Klein gehalten, weil WAV schnell gross wird.
 */
const cache = new Map<string, Buffer>()
const CACHE_MAX = 24

export async function sprechenGecacht(text: string): Promise<Buffer> {
  const schluessel = text.trim().slice(0, MAX_ZEICHEN)
  const da = cache.get(schluessel)
  if (da) {
    // Neu einsortieren, damit Haeufiges nicht verdraengt wird.
    cache.delete(schluessel)
    cache.set(schluessel, da)
    return da
  }
  const wav = await sprechen(schluessel)
  cache.set(schluessel, wav)
  if (cache.size > CACHE_MAX) {
    const aeltester = cache.keys().next().value
    if (aeltester !== undefined) cache.delete(aeltester)
  }
  return wav
}
