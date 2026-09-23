/**
 * Sprachpegel -- echter Ton, keine Attrappe.
 *
 * Der Nutzer hat ausdruecklich keine Zierde gewollt, die nur so tut. Also
 * liest dieses Modul den tatsaechlichen Pegel: die Piper-Ausgabe beim
 * Sprechen, das Mikrofon beim Zuhoeren. Wenn nichts laeuft, atmet es -- und
 * zwar sichtbar anders als wenn Ton anliegt, damit man den Unterschied sieht.
 *
 * Drei Dinge aus der Recherche, die den Unterschied zwischen "lebendig" und
 * "Balkendiagramm" ausmachen:
 *
 *   1. Attack/Release statt Tiefpass. Schnell hoch, langsam runter -- das ist
 *      die Ballistik eines analogen Zeigers. Ein symmetrischer Filter wirkt
 *      entweder zappelig oder tot.
 *   2. Drei Baender statt eines Mittelwerts. Bass, Mitten, Hoehen treiben
 *      verschiedene Groessen; ein einziger Wert sieht immer nach Aussteuerung
 *      aus.
 *   3. Atmen mit nicht-ganzzahligen Frequenzen. Ueberlagert man 0.13, 0.29
 *      und 0.071 Hz, wiederholt sich das Muster praktisch nie -- bei runden
 *      Verhaeltnissen sieht man sofort die Schleife.
 */

let ctx = null
let analyserAus = null   // Piper-Wiedergabe
let analyserEin = null   // Mikrofon
let mikroStrom = null
let quelleAus = null
let quelleEin = null     // MediaStreamAudioSourceNode des Mikrofons -- fuer hoeren.js

/** Geglaettete Werte, die nach aussen gehen. */
const stand = {
  pegel: 0,      // 0..1, Gesamtlautstaerke
  bass: 0,
  mitten: 0,
  hoehen: 0,
  atmen: 0,      // 0..1, laeuft immer -- auch bei Stille
  quelle: 'still', // still | spricht | hoert
}

const zeitbereich = new Uint8Array(2048)
const frequenz = new Uint8Array(1024)

/** Schnell ansteigen, langsam abklingen. */
function ballistik(alt, ziel, attack = 0.42, release = 0.07) {
  return alt + (ziel - alt) * (ziel > alt ? attack : release)
}

function kontext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
  return ctx
}

/**
 * Den Kontext aufwecken.
 *
 * Auf iOS startet er 'suspended' und muss in einem echten Tap-Handler
 * fortgesetzt werden. Passiert das nicht, liefert der Analyser dauerhaft
 * Nullen -- und eine Kugel, die bei lautem Ton stillsteht, wirkt kaputter
 * als eine ohne jeden Tonbezug.
 */
export async function aufwecken() {
  const c = kontext()
  if (c.state === 'suspended') {
    try { await c.resume() } catch { /* ohne Nutzergeste nicht erlaubt */ }
  }
  return c.state === 'running'
}

/** Ein abspielendes <audio> anzapfen. Gibt das Element unveraendert zurueck. */
export function ausgabeAnhaengen(audio) {
  try {
    const c = kontext()
    if (!analyserAus) {
      analyserAus = c.createAnalyser()
      analyserAus.fftSize = 2048
      analyserAus.smoothingTimeConstant = 0.6
    }
    // Ein MediaElementSource laesst sich je Element nur EINMAL anlegen; der
    // zweite Versuch wirft. Deshalb den alten trennen statt neu zu erzeugen.
    quelleAus?.disconnect()
    quelleAus = c.createMediaElementSource(audio)
    quelleAus.connect(analyserAus)
    // Weiter zum Ausgang, sonst bleibt die Wiedergabe stumm -- ein Analyser
    // allein ist eine Sackgasse.
    analyserAus.connect(c.destination)
    stand.quelle = 'spricht'
  } catch (e) {
    console.warn('[sprachpegel] Ausgabe nicht anzapfbar:', String(e))
  }
  return audio
}

export function ausgabeBeendet() {
  if (stand.quelle === 'spricht') stand.quelle = 'still'
}

/** Mikrofon einschalten. Fragt beim ersten Mal nach Erlaubnis. */
export async function mikroAn() {
  if (mikroStrom) { stand.quelle = 'hoert'; return true }
  try {
    const c = kontext()
    await aufwecken()
    mikroStrom = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
    analyserEin = c.createAnalyser()
    analyserEin.fftSize = 2048
    analyserEin.smoothingTimeConstant = 0.5
    quelleEin = c.createMediaStreamSource(mikroStrom)
    quelleEin.connect(analyserEin)
    // Bewusst NICHT an destination: das waere eine Rueckkopplung.
    stand.quelle = 'hoert'
    return true
  } catch (e) {
    console.warn('[sprachpegel] Mikrofon nicht verfuegbar:', String(e))
    mikroStrom = null
    return false
  }
}

export function mikroAus() {
  mikroStrom?.getTracks().forEach((t) => t.stop())
  mikroStrom = null
  analyserEin = null
  quelleEin = null
  if (stand.quelle === 'hoert') stand.quelle = 'still'
}

export const mikroLaeuft = () => Boolean(mikroStrom)

/**
 * Rohzugriff fuer hoeren.js: derselbe AudioContext und derselbe Mikrofon-
 * Quellknoten, an den ein AudioWorklet fuer die Aufnahme haengen kann --
 * ohne ein zweites getUserMedia() und damit ein zweites Freigabe-Gerippe.
 */
export function kontextLesen() { return ctx }
export function mikroKnoten() { return quelleEin }

function baenderLesen(an) {
  an.getByteFrequencyData(frequenz)
  const n = Math.min(frequenz.length, an.frequencyBinCount)
  // Logarithmisch geschnitten: Sprache hat ihre Energie unten, eine lineare
  // Drittelung gaebe drei fast identische Kurven.
  const grenzen = [Math.floor(n * 0.02), Math.floor(n * 0.12), Math.floor(n * 0.5)]
  const mittel = (von, bis) => {
    let s = 0
    for (let i = von; i < bis; i++) s += frequenz[i]
    return bis > von ? s / (bis - von) / 255 : 0
  }
  return {
    bass: mittel(0, grenzen[0]),
    mitten: mittel(grenzen[0], grenzen[1]),
    hoehen: mittel(grenzen[1], grenzen[2]),
  }
}

function rms(an) {
  an.getByteTimeDomainData(zeitbereich)
  const n = Math.min(zeitbereich.length, an.fftSize)
  let s = 0
  for (let i = 0; i < n; i++) {
    const v = (zeitbereich[i] - 128) / 128
    s += v * v
  }
  return Math.sqrt(s / n)
}

let t0 = null

/**
 * Einmal je Bild aufrufen. Gibt den geglaetteten Stand zurueck.
 *
 * `jetzt` kommt von aussen (requestAnimationFrame liefert es ohnehin), damit
 * mehrere Verbraucher im selben Bild denselben Wert sehen.
 */
export function messen(jetzt) {
  if (t0 === null) t0 = jetzt
  const t = (jetzt - t0) / 1000

  // Atmen laeuft immer. Drei Frequenzen ohne gemeinsames Vielfaches, damit
  // sich das Muster nicht sichtbar wiederholt.
  stand.atmen =
    0.5 +
    0.28 * Math.sin(t * 0.13 * Math.PI * 2) +
    0.14 * Math.sin(t * 0.29 * Math.PI * 2) +
    0.08 * Math.sin(t * 0.071 * Math.PI * 2)

  // Die Ausgabe hat Vorrang: wenn das Cockpit spricht, soll man das sehen,
  // auch wenn das Mikrofon offen ist.
  const an = stand.quelle === 'spricht' ? analyserAus : analyserEin ?? analyserAus
  if (!an) {
    stand.pegel = ballistik(stand.pegel, 0)
    stand.bass = ballistik(stand.bass, 0)
    stand.mitten = ballistik(stand.mitten, 0)
    stand.hoehen = ballistik(stand.hoehen, 0)
    return stand
  }

  const p = rms(an)
  const b = baenderLesen(an)
  // Der Faktor hebt normale Sprache auf einen brauchbaren Bereich; ohne ihn
  // bleibt der Ausschlag bei ueblichen Pegeln kaum sichtbar.
  stand.pegel = ballistik(stand.pegel, Math.min(1, p * 4.2))
  stand.bass = ballistik(stand.bass, b.bass)
  stand.mitten = ballistik(stand.mitten, b.mitten)
  stand.hoehen = ballistik(stand.hoehen, b.hoehen, 0.5, 0.12)
  return stand
}

export const standLesen = () => stand

/**
 * Wellenform auf ein Canvas zeichnen.
 *
 * Bei Stille wird eine ruhige Linie gezeichnet, die mit dem Atmen leicht
 * wandert -- nicht nichts, aber sichtbar anders als Sprache.
 */
export function wellenformZeichnen(cv, farbe) {
  const ctx2 = cv.getContext('2d')
  const b = cv.width
  const h = cv.height
  ctx2.clearRect(0, 0, b, h)

  const an = stand.quelle === 'spricht' ? analyserAus : analyserEin
  const mitte = h / 2
  const balken = Math.min(72, Math.floor(b / 5))
  const breite = Math.max(2, Math.floor(b / balken) - 2)

  ctx2.fillStyle = farbe
  for (let i = 0; i < balken; i++) {
    let wert
    if (an && stand.pegel > 0.01) {
      const anteil = i / balken
      // Die Mitte des Balkenfelds bekommt die Baesse, die Raender die Hoehen:
      // das sieht aus wie eine Stimme und nicht wie ein Spektrum.
      const naheMitte = 1 - Math.abs(anteil - 0.5) * 2
      wert = (stand.bass * naheMitte + stand.mitten * 0.7 + stand.hoehen * (1 - naheMitte)) *
        (0.55 + 0.45 * Math.sin(i * 1.7 + performance.now() / 260))
    } else {
      wert = 0.035 + 0.03 * Math.sin(i * 0.5 + stand.atmen * 5)
    }
    const hoehe = Math.max(2, Math.min(h, wert * h * 1.6))
    ctx2.globalAlpha = an && stand.pegel > 0.01 ? 0.9 : 0.42
    ctx2.fillRect(i * (breite + 2), mitte - hoehe / 2, breite, hoehe)
  }
  ctx2.globalAlpha = 1
}
