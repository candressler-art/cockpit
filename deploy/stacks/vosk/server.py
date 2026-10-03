"""
Live-Spracherkennung fuer das Diktat im Cockpit (Vosk, deutsches Kleinmodell).

Whisper (whisper.yml) ist genauer, braucht auf servertwo aber 5-7 s je Satz
und kann nicht mitlaufen. Dieser Dienst liefert waehrend des Sprechens
Zwischenstaende; Whisper schreibt die Saetze danach sauber (web/diktat.js).

Protokoll je WebSocket-Verbindung (nur der Cockpit-Daemon spricht hiermit,
src/liveHoeren.ts):
  -> binaer            16-bit-PCM, mono, 16 kHz, little endian
  -> {"reset": true}   aktuelle Aeusserung verwerfen (Can hat getippt)
  <- {"reset": true}   Bestaetigung: alles, was davor unterwegs war, ist alt
  -> {"eof": true}     Ende: letzte Aeusserung abschliessen, dann schliessen
  <- {"partial": "…"}  Zwischenstand der laufenden Aeusserung (nur bei Aenderung)
  <- {"text": "…"}     abgeschlossene Aeusserung (Vosk hat eine Pause erkannt)
  <- {"text": "…", "eof": true}  Rest beim Ende
"""
import asyncio
import json
import os

from vosk import KaldiRecognizer, Model, SetLogLevel
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

RATE = 16000
SetLogLevel(-1)
MODELL = Model(os.environ.get('VOSK_MODELL', '/modell'))


async def sitzung(ws):
    # Bricht der Browser ab (Verwerfen, Seite zu), endet die Verbindung ohne
    # eof -- das ist der Normalfall, kein Fehler.
    try:
        await verarbeiten(ws)
    except ConnectionClosed:
        pass


async def verarbeiten(ws):
    rec = KaldiRecognizer(MODELL, RATE)
    letzter = ''
    async for nachricht in ws:
        if isinstance(nachricht, bytes):
            # Kaldi rechnet im C-Teil; im Thread blockiert es die Schleife nicht.
            fertig = await asyncio.to_thread(rec.AcceptWaveform, nachricht)
            if fertig:
                text = json.loads(rec.Result()).get('text', '')
                letzter = ''
                await ws.send(json.dumps({'text': text}, ensure_ascii=False))
            else:
                p = json.loads(rec.PartialResult()).get('partial', '')
                if p != letzter:
                    letzter = p
                    await ws.send(json.dumps({'partial': p}, ensure_ascii=False))
            continue
        try:
            befehl = json.loads(nachricht)
        except ValueError:
            continue
        if befehl.get('reset'):
            rec.Reset()
            letzter = ''
            await ws.send(json.dumps({'reset': True}))
        elif befehl.get('eof'):
            text = json.loads(rec.FinalResult()).get('text', '')
            await ws.send(json.dumps({'text': text, 'eof': True}, ensure_ascii=False))
            await ws.close()
            return


async def main():
    # 64 KiB je Nachricht reichen fuer jeden Audioblock (100 ms = 3,2 KB).
    async with serve(sitzung, '0.0.0.0', 2700, max_size=64 * 1024):
        await asyncio.get_running_loop().create_future()


asyncio.run(main())
