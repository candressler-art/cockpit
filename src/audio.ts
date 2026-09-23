// PCM 16-bit mono resampeln (lineare Interpolation).
//
// Faster-Whisper erwartet 16 kHz. Der Browser liefert, was der AudioContext
// hergibt -- meist 48000 Hz, manchmal 44100, und das haengt vom Geraet ab,
// nicht von unserem Code. Lieber hier einmal sauber umrechnen, serverseitig
// und getestet, als sich auf jedes Geraet zu verlassen oder das Resampling
// dem Browser zu ueberlassen, wo es sich nicht pruefen laesst.

/**
 * Resampelt 16-bit-LE-Mono-PCM von `vonRate` auf `zielRate`. Lineare
 * Interpolation reicht fuer Sprache an Whisper -- kein Anti-Aliasing-Filter,
 * weil hier praktisch immer nach UNTEN resampelt wird (48/44.1kHz -> 16kHz)
 * und der Qualitaetsverlust dabei fuer Spracherkennung nicht ins Gewicht
 * faellt, gemessen an der Alternative, gar nicht erst zu resampeln.
 */
export function pcm16Resampeln(pcm: Buffer, vonRate: number, zielRate: number): Buffer {
  const anzahlEin = Math.floor(pcm.length / 2)
  if (vonRate === zielRate || anzahlEin === 0 || vonRate <= 0 || zielRate <= 0) return pcm

  const verhaeltnis = vonRate / zielRate
  const anzahlAus = Math.max(0, Math.round(anzahlEin / verhaeltnis))
  const aus = Buffer.alloc(anzahlAus * 2)

  for (let i = 0; i < anzahlAus; i++) {
    const pos = i * verhaeltnis
    const idx = Math.min(Math.floor(pos), anzahlEin - 1)
    const frac = pos - idx
    const a = pcm.readInt16LE(idx * 2)
    const bIdx = Math.min(idx + 1, anzahlEin - 1)
    const b = pcm.readInt16LE(bIdx * 2)
    const wert = Math.round(a + (b - a) * frac)
    aus.writeInt16LE(Math.max(-32768, Math.min(32767, wert)), i * 2)
  }

  return aus
}
