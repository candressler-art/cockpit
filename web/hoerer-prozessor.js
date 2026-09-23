/**
 * AudioWorklet-Prozessor fuer die Sprachaufnahme.
 *
 * Laeuft im Audio-Rendering-Thread, nicht im Hauptthread -- deshalb ein
 * eigenes Modul statt einer Funktion in hoeren.js. Er tut nur eines: die
 * Rohsamples des einzigen Eingangskanals in kleinen Bloecken (typischerweise
 * 128 Samples) an den Hauptthread weiterreichen. Resampling und WAV-Bau
 * passieren dort, nicht hier -- der Rendering-Thread darf nicht blockieren,
 * sonst knackt das Mikrofonsignal jedes anderen Verbrauchers mit.
 */
class HoererProzessor extends AudioWorkletProcessor {
  process(eingaenge) {
    const kanal = eingaenge[0]?.[0]
    if (kanal && kanal.length) {
      // Kopieren: der Puffer, den 'process' hier bekommt, gehoert dem
      // Audiosystem und wird wiederverwendet -- ohne Kopie waere er beim
      // Ankommen im Hauptthread laengst ueberschrieben.
      this.port.postMessage(kanal.slice())
    }
    return true
  }
}
registerProcessor('hoerer-prozessor', HoererProzessor)
