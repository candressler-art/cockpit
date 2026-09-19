# Cockpit

Eine Zentrale für Claude-Code-Agenten: ein Orchestrator beauftragt Worker, und
man sieht live, wer gerade was tut, wie die beiden miteinander reden und was
es kostet.

## Wozu

Der Vorgänger `~/projekte/loop/loop.py` treibt seine Worker mit
`--output-format json`. Dieser Modus gibt erst am Ende etwas zurück — bis zu
45 Minuten ohne Lebenszeichen. Stirbt ein Lauf, lässt sich erst hinterher aus
Logs rekonstruieren, woran. Das Cockpit liest stattdessen den vollständigen
Ereignisstrom, schreibt ihn nach SQLite und zeigt ihn live an.

## Start

```bash
npm install
npm run build
node dist/daemon.js
```

Dann <http://127.0.0.1:8765> öffnen.

Der Daemon bindet auf `127.0.0.1`. Nach außen kommt er nur über
`tailscale serve` — es steht bewusst kein Port im LAN offen.

### Umgebungsvariablen

| Variable | Voreinstellung | Bedeutung |
|---|---|---|
| `COCKPIT_PORT` | `8765` | HTTP- und WebSocket-Port |
| `COCKPIT_HOST` | `127.0.0.1` | Bindeadresse |
| `COCKPIT_DB` | `~/.cockpit/cockpit.db` | SQLite-Datei |

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/typen.ts` | Ereignisschema, Agentenzustand, Tokengewichte, Limitstand |
| `src/db.ts` | SQLite mit WAL, Backfill ab Sequenznummer, Aufräumen verwaister Läufe |
| `src/normalisieren.ts` | SDK-Nachricht → Cockpit-Ereignis, defensiv gegen neue Varianten |
| `src/protokoll.ts` | Vier-Fälle-Protokoll, Report-Typ, Blocker, Wiederholungserkennung |
| `src/supervisor.ts` | Eine SDK-Session je Agent, Freigabe-Broker, Verbrauchszähler |
| `src/orchestrator.ts` | Runden, Fallauswertung, Leseanfragen, Stoppbedingungen |
| `src/daemon.ts` | HTTP, WebSocket, REST |
| `web/index.html` | Oberfläche: Live-Log, Agentenliste, Freigaben, Auslastung |

## Das Protokoll

Der Orchestrator sieht keine Dateien, nur Reports, und antwortet in genau
einem von vier Fällen:

| Fall | Feld | Bedeutung |
|---|---|---|
| A | `NAECHSTER-PROMPT` | weiter, nächster Auftrag an den Worker |
| B | `ENTSCHEIDUNG-NOETIG` | pausiert, Frage an den Menschen |
| C | `PROJEKT-FERTIG` | Lauf beendet |
| D | `LESE-ANFRAGE` | Datei oder Suchtreffer nachsehen, kostet keine Runde |

Jede Antwort beginnt mit `STATUS-KURZ`. Der Worker deklariert seinen Reporttyp
in Zeile 1 (`Report-Typ: ZWISCHENSTAND` oder `FERTIG-MELDUNG`) und meldet einen
Blocker als eigene Zeile direkt darunter. Beides wird mechanisch gelesen —
deklarieren statt aus Freitext raten, weil eine Heuristik auf den Wortlaut sich
im Vorgänger als unzuverlässig erwiesen hat.

Ein gemeldeter Blocker muss zu Fall B führen. Tut der Orchestrator das nicht,
stoppt der Lauf, statt Runden an einer Aufgabe zu verbrennen, die ohne eine
Entscheidung nicht weitergeht.

## Zwei Dinge, die anders sind als im Vorgänger

**Bewertet wird der gesammelte Text, nicht `result`.** Reißt eine Antwort die
Ausgabegrenze, setzt die CLI sie in einem weiteren Zug fort, und `result` trägt
nur noch den letzten Block. In `loop_log` sind genau so zwei
Orchestrator-Antworten verlorengegangen: 32 510 Ausgabe-Tokens, im `result`
standen die letzten 1 041 Zeichen ab „Fortsetzung des NAECHSTER-PROMPT:". Der
Lauf starb an einem Formatfehler, der keiner war.

**Die Auslastung wird gemessen, nicht geschätzt.** Das SDK meldet in
`rate_limit_event` den echten Stand der Nutzungsfenster. Die gewichtete
Tokenrechnung aus `loop.py` bleibt trotzdem, weil sie den Verbrauch einzelnen
Agenten zuordnet — das können die Fensterwerte nicht.

## REST

| Endpunkt | Methode | Zweck |
|---|---|---|
| `/api/laeufe` | GET | Liste der Läufe |
| `/api/lauf/<id>?seit=<seq>` | GET | Agenten, Ereignisse ab Sequenznummer, offene Freigaben |
| `/api/lauf` | POST | Einzelnen Chat-Agenten starten |
| `/api/orchestrator` | POST | Orchestrator-Lauf starten |
| `/api/freigabe` | POST | Offene Freigabe entscheiden |
| `/api/abbrechen` | POST | Agent oder ganzen Lauf abbrechen |
| `/api/gesundheit` | GET | Status und letzter Limitstand |

## Stand

Stufe 1 (Sichtbarkeit) und Stufe 2 (Orchestrator) sind fertig und getestet.
Offen: Tauri-App, Server-Deployment mit `tailscale serve`, Discord-Anbindung,
und die Feature-Parität zur Desktop-App.
