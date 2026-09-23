// WAV-Kopf: bauen und lesen.
//
// Bauen brauchte bisher nur stimme.ts (Piper liefert nacktes PCM, ein
// <audio>-Element im Browser spielt das nicht ohne Kopf ab). Lesen kommt mit
// der Spracherkennung dazu: der Browser schickt fertiges WAV an /api/hoeren,
// und hoeren.ts braucht Rate, Breite und Kanaele daraus, bevor es das PCM an
// Whisper weiterreichen kann. Beide Richtungen stehen hier, nicht doppelt in
// stimme.ts und hoeren.ts.

export interface WavDaten {
  pcm: Buffer
  rate: number
  /** Bytes je Probe -- 2 bedeutet 16 bit. */
  breite: number
  kanaele: number
}

/**
 * WAV-Kopf um rohes PCM legen. Immer unkomprimiertes PCM, 44-Byte-Kopf ohne
 * Zusatz-Chunks -- fuer das, was hier erzeugt wird (Piper-Ausgabe, spaeter
 * die Browseraufnahme), reicht das.
 */
export function wavBauen(pcm: Buffer, rate: number, breite: number, kanaele: number): Buffer {
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
 * WAV lesen: liefert das rohe PCM plus Format, oder null bei einer Datei, die
 * kein brauchbares WAV ist.
 *
 * Robust gegen zusaetzliche Chunks (z.B. 'LIST', 'fact') vor 'data' -- ein
 * vom Browser gebautes WAV traegt nur 'fmt ' und 'data', aber sich auf genau
 * 44 Byte Kopf zu verlassen waere gegen jede andere Quelle zerbrechlich.
 * Nur PCM (audioFormat 1) wird verstanden; alles andere (z.B. IEEE-Float)
 * lehnt diese Stelle ab, weil Whisper 16-bit-PCM erwartet.
 */
export function wavLesen(buf: Buffer): WavDaten | null {
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null
  }

  let rate = 0
  let breite = 2
  let kanaele = 1
  let audioFormat = 0
  let pcm: Buffer | null = null

  let pos = 12
  while (pos + 8 <= buf.length) {
    const kennung = buf.toString('ascii', pos, pos + 4)
    const laenge = buf.readUInt32LE(pos + 4)
    const inhaltStart = pos + 8
    if (laenge < 0 || inhaltStart + laenge > buf.length) break // beschaedigt/abgeschnitten

    if (kennung === 'fmt ' && laenge >= 16) {
      audioFormat = buf.readUInt16LE(inhaltStart)
      kanaele = buf.readUInt16LE(inhaltStart + 2)
      rate = buf.readUInt32LE(inhaltStart + 4)
      const bits = buf.readUInt16LE(inhaltStart + 14)
      breite = Math.max(1, Math.round(bits / 8))
    } else if (kennung === 'data') {
      pcm = buf.subarray(inhaltStart, inhaltStart + laenge)
    }
    // Chunks sind wortgerade ausgerichtet -- ein ungerades laenge-Feld hat
    // ein Fuellbyte danach, das nicht zum naechsten Kopf gehoert.
    pos = inhaltStart + laenge + (laenge % 2)
  }

  if (!pcm || !rate || audioFormat !== 1) return null
  return { pcm, rate, breite, kanaele }
}
