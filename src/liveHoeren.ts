// Live-Spracherkennung fuer das Diktat: reicht Audio vom Browser an den
// Vosk-Container (deploy/stacks/vosk) durch und dessen Zwischenstaende zurueck.
//
// Whisper (hoeren.ts) ist genauer, braucht auf servertwo aber 5-7 s je Satz
// -- mitschreiben, waehrend man spricht, kann es nicht. Die graue Vorschau
// im Eingabefeld kommt deshalb von hier; die fertigen Saetze schickt der
// Browser danach zusaetzlich an /api/hoeren (web/diktat.js).
//
// Der Browser erreicht Vosk nicht selbst: der Container hoert nur auf
// 127.0.0.1, und nach aussen geht allein der Daemon. Die Verbindung kommt als
// /ws?hoeren an -- ein eigener Pfad ginge nicht, weil der WebSocketServer in
// daemon.ts jede Anfrage auf einen anderen Pfad mit 400 abweist. Die
// Herkunftspruefung dort gilt damit auch hier.
//
// Protokoll zum Browser (dasselbe wie zu Vosk, siehe server.py), plus:
//   <- {"bereit": true}   Vosk ist verbunden, ab jetzt kommt Text
//   <- {"fehler": "…"}    Vosk nicht erreichbar -- der Browser diktiert dann
//                         ohne Vorschau weiter (nur Whisper)

import WebSocket from 'ws'

const VOSK_URL = process.env.VOSK_URL ?? 'ws://127.0.0.1:2700'
/** Audio, das ankommt, bevor Vosk verbunden ist: hoechstens ~10 s (16 kHz, 16 bit). */
const PUFFER_MAX = 10 * 32_000

export function liveHoerenVerbinden(browser: WebSocket): void {
  const vosk = new WebSocket(VOSK_URL, { handshakeTimeout: 3000, maxPayload: 64 * 1024 })
  let puffer: Buffer[] = []
  let gepuffert = 0

  const anBrowser = (daten: unknown): void => {
    if (browser.readyState === WebSocket.OPEN) browser.send(typeof daten === 'string' ? daten : JSON.stringify(daten))
  }

  vosk.on('open', () => {
    for (const b of puffer) vosk.send(b)
    puffer = []
    anBrowser({ bereit: true })
  })
  vosk.on('message', (d, binaer) => { if (!binaer) anBrowser(String(d)) })
  vosk.on('error', (e) => {
    console.warn('[hoeren] Live-Erkennung nicht erreichbar:', String(e))
    anBrowser({ fehler: 'Live-Erkennung nicht erreichbar' })
  })
  vosk.on('close', () => { if (browser.readyState === WebSocket.OPEN) browser.close(1000) })

  browser.on('message', (d, binaer) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)
    if (vosk.readyState === WebSocket.OPEN) return vosk.send(b, { binary: binaer })
    if (vosk.readyState !== WebSocket.CONNECTING) return
    // Noch nicht verbunden: den Anfang nicht verlieren, aber auch nicht
    // unbegrenzt puffern, falls Vosk nie antwortet.
    if (!binaer) return
    if (gepuffert + b.length > PUFFER_MAX) return
    puffer.push(b)
    gepuffert += b.length
  })
  // Offen: sauber schliessen (sonst schreibt server.py bei jedem Abbruch einen
  // Traceback). Noch im Aufbau: abreissen, ein close() ginge dort nicht.
  const beenden = (): void => {
    if (vosk.readyState === WebSocket.OPEN) vosk.close(1000)
    else if (vosk.readyState === WebSocket.CONNECTING) vosk.terminate()
  }
  browser.on('close', beenden)
  browser.on('error', beenden)
}
