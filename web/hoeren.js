/**
 * Diktat-Aufnahme im Browser -- kein MediaRecorder, keine Web-Speech-API.
 *
 * Beide fehlen im WebKitGTK der Tauri-Huelle bzw. laufen bei der
 * Web-Speech-API ueber Googles Server, was hier niemand will. Stattdessen
 * wird das Mikrofon ueber denselben AudioContext angezapft, den
 * sprachpegel.js schon fuer die Pegelanzeige offen haelt: ein AudioWorklet
 * liest die rohen Samples ab, dieses Modul rechnet sie auf 16 kHz / 16 bit
 * herunter und
 *   - schickt sie laufend ueber /ws?hoeren an die Live-Erkennung (Vosk, src/liveHoeren.ts),
 *   - behaelt sie, damit diktat.js einzelne Saetze als WAV an Whisper geben kann.
 *
 * Kein automatisches Ende: Can schaltet das Mikro selbst aus und will
 * zwischendurch Pausen machen koennen. Nur eine Obergrenze (MAX_MS) schuetzt
 * vor einer vergessenen Aufnahme.
 *
 * Ist die Live-Erkennung nicht erreichbar, laeuft das Diktat ohne Vorschau
 * weiter: Saetze werden dann hier an Sprechpausen abgeschnitten (Pegel), und
 * ihren Text liefert allein Whisper.
 *
 * Den Pegel misst dieses Modul selbst aus den aufgenommenen Samples --
 * sprachpegel.standLesen() aendert sich nur, solange jemand messen() je Bild
 * aufruft.
 */
import * as sp from './sprachpegel.js'
import * as bus from './bus.js'

export const RATE = 16000
/** Im Massstab von sprachpegel.js (RMS * 4,2), damit beide dasselbe meinen. */
const SCHWELLE = 0.055
/** Ohne Live-Erkennung: so lange Stille schliesst einen Satz ab. */
const SATZ_PAUSE_MS = 800
const MAX_MS = 10 * 60_000
const PRUEF_MS = 100
/** Kommt so lange nach dem Oeffnen kein einziger Audioblock, ist etwas faul. */
const KEIN_TON_MS = 4000
/** Auf das letzte Wort der Live-Erkennung warten, aber nicht ewig. */
const SCHLUSS_WARTEN_MS = 2500
/** So viel Audio je Nachricht an den Server (100 ms). */
const BLOCK = RATE / 10
/** Ohne Live-Erkennung spaetestens so lang je Satz -- Whisper schafft ~30 s nicht mehr. */
const SATZ_MAX = 12 * RATE

let belegt = false
/** AudioContexte, in denen hoerer-prozessor.js schon geladen ist. */
const geladen = new WeakSet()

/** 16-bit-PCM (16 kHz, mono) als WAV. */
export function pcmZuWav(i16, rate = RATE) {
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
 * Herunterrechnen auf 16 kHz: Mittelwert je Ausgabefenster -- das ist
 * zugleich ein grober Tiefpass, gegen Aliasing reicht das fuer Sprache.
 * Haelt den Rest zwischen zwei Bloecken fest.
 */
export function abtaster(eingangsRate) {
  const schritt = eingangsRate / RATE
  let summe = 0
  let anzahl = 0
  let bisGrenze = schritt
  return (f32) => {
    const aus = new Int16Array(Math.ceil(f32.length / schritt) + 1)
    let n = 0
    for (let i = 0; i < f32.length; i++) {
      summe += f32[i]
      anzahl++
      bisGrenze -= 1
      if (bisGrenze <= 0) {
        const s = Math.max(-1, Math.min(1, summe / anzahl))
        aus[n++] = s < 0 ? s * 0x8000 : s * 0x7fff
        summe = 0
        anzahl = 0
        bisGrenze += schritt
      }
    }
    return aus.subarray(0, n)
  }
}

/**
 * Aufnahme starten.
 *
 * @param opt.beiBereit()                erster echter Audioblock -- erst jetzt "Jetzt sprechen"
 * @param opt.beiStand({ ms, pegel, gehoert, restMs })  alle 100 ms
 * @param opt.beiVorschau(text)          Zwischenstand des gerade gesprochenen Satzes
 * @param opt.beiSatz({ text, von, bis }) Satz abgeschlossen; von/bis = Samples (16 kHz)
 * @param opt.beiOhneVorschau()          Live-Erkennung nicht erreichbar, nur noch Whisper
 * @param opt.beiEnde(grund)             Aufnahme endete von selbst ('max' | 'kein-ton' | 'fehler')
 * @returns {Promise<{ steuerung } | { fehler: string, grund: string }>}
 */
export async function aufnahmeStarten(opt = {}) {
  if (belegt) return { grund: 'belegt', fehler: 'belegt' }
  belegt = true
  try {
    const erg = await starten(opt)
    if (!erg.steuerung) belegt = false
    return erg
  } catch (e) {
    belegt = false
    sp.mikroAus()
    return { grund: 'fehler', fehler: String(e?.message ?? e) }
  }
}

async function starten({ beiBereit, beiStand, beiVorschau, beiSatz, beiOhneVorschau, beiEnde }) {
  const ruf = (fn, ...a) => { try { fn?.(...a) } catch (e) { console.warn('[hoeren] Rueckruf warf:', e) } }

  const ok = await sp.mikroAn()
  if (!ok) return { grund: 'kein-mikro', fehler: sp.mikroFehler() }
  const ctx = sp.kontextLesen()
  const quelle = sp.mikroKnoten()
  if (!ctx || !quelle) { sp.mikroAus(); return { grund: 'kein-mikro', fehler: 'unbekannt' } }

  // --- Zustand ----------------------------------------------------------------
  let aktiv = true
  const stuecke = []          // Int16Array-Stuecke, 16 kHz
  let laenge = 0              // Samples insgesamt
  let unterwegs = []          // noch nicht an den Server geschickte Samples
  let unterwegsLaenge = 0
  let grenze = 0              // Beginn des laufenden Satzes (Samples)
  let start = null            // erster Audioblock (performance.now())
  const geoeffnet = performance.now()
  let gehoert = false         // schon einmal Sprache
  let sprachSeitGrenze = false
  let letzteSprache = null
  let pegelSumme = 0
  let pegelAnzahl = 0
  let ohneVorschau = false
  let resetOffen = false      // zurueckgesetzt, Bestaetigung steht aus
  let schlussLoesen = null
  let letzteVorschau = ''     // fuer den Fall, dass Vosks Schlusswort ausbleibt
  let maxGemeldet = false
  const herunter = abtaster(ctx.sampleRate)

  // --- Live-Erkennung -----------------------------------------------------------
  let ws = null
  const vorschauAus = () => {
    if (ohneVorschau) return
    ohneVorschau = true
    ruf(beiVorschau, '')
    ruf(beiOhneVorschau)
    schlussLoesen?.()
  }
  try {
    ws = new WebSocket(`${bus.wsUrl()}?hoeren`)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.fehler) return vorschauAus()
      if (m.reset) { resetOffen = false; return }
      // Was vor dem Zuruecksetzen unterwegs war, gehoert zum getippten Text.
      if (resetOffen || ohneVorschau) return
      if (typeof m.partial === 'string') { letzteVorschau = m.partial; ruf(beiVorschau, m.partial) }
      if (typeof m.text === 'string') {
        letzteVorschau = ''
        const bis = laenge
        if (m.text.trim()) ruf(beiSatz, { text: m.text.trim(), von: grenze, bis })
        grenze = bis
        sprachSeitGrenze = false
        ruf(beiVorschau, '')
        if (m.eof) schlussLoesen?.()
      }
    }
    ws.onclose = () => { if (aktiv) vorschauAus(); schlussLoesen?.() }
    ws.onerror = () => { if (aktiv) vorschauAus() }
  } catch {
    vorschauAus()
  }

  const senden = (i16) => {
    if (!ws || ohneVorschau) return
    unterwegs.push(i16)
    unterwegsLaenge += i16.length
    if (unterwegsLaenge < BLOCK || ws.readyState !== WebSocket.OPEN) {
      // Vor dem Verbinden nicht endlos sammeln -- der Daemon puffert auch.
      if (ws.readyState === WebSocket.CONNECTING && unterwegsLaenge > RATE * 10) { unterwegs = []; unterwegsLaenge = 0 }
      return
    }
    const alles = new Int16Array(unterwegsLaenge)
    let off = 0
    for (const u of unterwegs) { alles.set(u, off); off += u.length }
    unterwegs = []
    unterwegsLaenge = 0
    // In 100-ms-Bloecken: nach langsamem Verbindungsaufbau kann sich viel
    // angesammelt haben, und der Daemon nimmt hoechstens 64 KiB je Nachricht.
    for (let a = 0; a < alles.length; a += BLOCK) ws.send(alles.slice(a, a + BLOCK).buffer)
  }

  const annehmen = (f32) => {
    if (!aktiv) return
    for (let i = 0; i < f32.length; i++) pegelSumme += f32[i] * f32[i]
    pegelAnzahl += f32.length
    const i16 = herunter(f32)
    if (!i16.length) return
    const kopie = i16.slice()
    stuecke.push(kopie)
    laenge += kopie.length
    senden(kopie)
    if (start === null) { start = performance.now(); ruf(beiBereit) }
  }

  // --- Abgreifen: AudioWorklet, sonst ScriptProcessor ---------------------------
  let knoten
  try {
    if (!geladen.has(ctx)) { await ctx.audioWorklet.addModule('./hoerer-prozessor.js'); geladen.add(ctx) }
    const w = new AudioWorkletNode(ctx, 'hoerer-prozessor', { numberOfInputs: 1, numberOfOutputs: 0 })
    w.port.onmessage = (ev) => annehmen(ev.data)
    quelle.connect(w)
    knoten = { node: w, port: w.port }
  } catch (e) {
    // Aeltere Engines kennen AudioWorklet moeglicherweise nicht;
    // ScriptProcessorNode ist veraltet, aber ueberall vorhanden. Er feuert
    // nur, wenn er bis zu einem Ziel verbunden ist -- eine stumme Senke reicht.
    console.warn('[hoeren] AudioWorklet nicht verfuegbar, nehme ScriptProcessor:', String(e))
    const proz = ctx.createScriptProcessor(4096, 1, 1)
    const senke = ctx.createGain()
    senke.gain.value = 0
    proz.onaudioprocess = (ev) => annehmen(new Float32Array(ev.inputBuffer.getChannelData(0)))
    quelle.connect(proz)
    proz.connect(senke)
    senke.connect(ctx.destination)
    knoten = { node: proz, senke, proz }
  }

  // --- Ohne Live-Erkennung: Saetze an Pausen abschneiden ----------------------------
  const satzOhneVorschau = () => {
    if (!sprachSeitGrenze) { grenze = laenge; return }
    ruf(beiSatz, { text: '', von: grenze, bis: laenge })
    grenze = laenge
    sprachSeitGrenze = false
  }

  const mikroZu = () => {
    aktiv = false
    belegt = false
    clearInterval(uhr)
    try { knoten.node.disconnect(); knoten.senke?.disconnect() } catch { /* schon getrennt */ }
    // Den Prozessor wirklich anhalten und die Verweise loesen -- sonst laeuft er
    // weiter und haelt das Audio dieses Diktats bis zum Neuladen fest.
    if (knoten.port) { knoten.port.postMessage('stopp'); knoten.port.onmessage = null }
    if (knoten.proz) knoten.proz.onaudioprocess = null
    sp.mikroAus()
  }

  const uhr = setInterval(() => {
    const jetzt = performance.now()
    if (start === null) {
      if (jetzt - geoeffnet > KEIN_TON_MS) { mikroZu(); ws?.close(); ruf(beiEnde, 'kein-ton') }
      return
    }
    const pegel = pegelAnzahl ? Math.min(1, Math.sqrt(pegelSumme / pegelAnzahl) * 4.2) : 0
    pegelSumme = 0
    pegelAnzahl = 0
    if (pegel > SCHWELLE) { gehoert = true; sprachSeitGrenze = true; letzteSprache = jetzt }
    if (ohneVorschau && sprachSeitGrenze && (jetzt - letzteSprache > SATZ_PAUSE_MS || laenge - grenze > SATZ_MAX)) satzOhneVorschau()
    const ms = jetzt - start
    ruf(beiStand, { ms, pegel, gehoert, restMs: Math.max(0, MAX_MS - ms) })
    if (ms > MAX_MS && !maxGemeldet) { maxGemeldet = true; ruf(beiEnde, 'max') }
  }, PRUEF_MS)

  const steuerung = {
    /** Samples bisher (16 kHz). */
    position: () => laenge,
    /** Audio [von, bis) als WAV. */
    ausschnitt(von, bis) {
      const aus = new Int16Array(Math.max(0, bis - von))
      let pos = 0
      for (const s of stuecke) {
        const a = Math.max(von, pos)
        const b = Math.min(bis, pos + s.length)
        if (b > a) aus.set(s.subarray(a - pos, b - pos), a - von)
        pos += s.length
        if (pos >= bis) break
      }
      return pcmZuWav(aus)
    },
    /** Can hat getippt: die laufende Aeusserung gehoert jetzt zum Text, neu anfangen. */
    zuruecksetzen() {
      grenze = laenge
      sprachSeitGrenze = false
      letzteVorschau = ''
      if (!ohneVorschau && ws?.readyState === WebSocket.OPEN) {
        resetOffen = true
        ws.send(JSON.stringify({ reset: true }))
      }
    },
    /** Mikro aus; loest auf, sobald der letzte Satz da ist (oder nach SCHLUSS_WARTEN_MS). */
    async beenden() {
      if (!aktiv) return
      mikroZu()
      if (ohneVorschau || !ws || ws.readyState !== WebSocket.OPEN) {
        satzOhneVorschau()
        ws?.close()
        return
      }
      // Rest schicken, dann auf das Schlusswort warten.
      if (unterwegsLaenge) { const u = unterwegs; unterwegs = []; unterwegsLaenge = 0; for (const x of u) ws.send(x.buffer) }
      await new Promise((loesen) => {
        const t = setTimeout(loesen, SCHLUSS_WARTEN_MS)
        schlussLoesen = () => { clearTimeout(t); schlussLoesen = null; loesen() }
        ws.send(JSON.stringify({ eof: true }))
      })
      // Kam kein Schlusswort (Vosk zu langsam oder weg): den Rest mit der
      // letzten Vorschau abschliessen -- Whisper schreibt ihn dann noch sauber.
      if (grenze < laenge && (sprachSeitGrenze || letzteVorschau)) ruf(beiSatz, { text: letzteVorschau, von: grenze, bis: laenge })
      ws.close()
    },
    /** Sofort alles weg, ohne Ergebnis. */
    abbrechen() {
      if (aktiv) mikroZu()
      schlussLoesen?.()
      ws?.close()
    },
  }
  return { steuerung }
}
