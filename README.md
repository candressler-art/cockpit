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

## Wo es laeuft

Der Daemon laeuft auf **servertwo** als systemd-Unit `cockpit`, Code unter
`/opt/cockpit`, Datenbank unter `/var/lib/cockpit/cockpit.db`. Er bindet auf
`127.0.0.1:8765`; nach aussen kommt er ausschliesslich ueber `tailscale serve`:

    https://servertwo.tail9c8a2b.ts.net:8443

Port 8443 und nicht die Wurzel, weil dort schon ntfy haengt. Es steht bewusst
kein Port im LAN offen.

Warum servertwo und nicht serverone: serverone traegt Immich mit Postgres,
Redis und dem ML-Container, servertwo war nahezu leer. Der Preis ist weniger
Reserve -- 4 Kerne statt 8, 7,5 GB statt 32 -- weshalb `parallelitaet` bei 2
gedeckelt gehoert.

### Ortlich entwickeln

```bash
npm install
npm run build
COCKPIT_DB=~/.cockpit/cockpit.db node dist/daemon.js
```

Dann <http://127.0.0.1:8765> oeffnen.

### Auf den Server bringen

```bash
npm run build
./deploy/server-einrichten.sh
```

Die Desktop-Huelle (Tauri) zeigt per Vorgabe auf den Server:

```bash
npx tauri build --no-bundle && ./deploy/installieren-desktop.sh
```

Sie wird ueber `~/.local/bin/cockpit-start` gestartet -- ein Wrapper, der
vorher Wispr Flow hochholt, das seinerseits Obsidian nachzieht.

#### Die Huelle buendelt die Oberflaeche nicht mehr

`src-tauri/src/main.rs` laedt `web/` nicht mehr zur Bauzeit ein (kein
`frontendDist "../web"` mehr). Das Fenster oeffnet stattdessen direkt die
Adresse aus `COCKPIT_DAEMON` (`WebviewUrl::External`) -- dieselbe Quelle, die
auch der Browser sieht. Frueher gab es zwei Kopien der Oberflaeche: die
gebuendelte in der installierten Binary und die aktuelle, die der Daemon
selbst ausliefert. Beide liefen auseinander, weil ein Aendern von `web/`
keinen Neubau der Huelle nach sich zog.

Praktische Folge: **`npx tauri build` ist nur noch noetig, wenn sich
`src-tauri/` selbst aendert** (Fenstergroesse, Mikrofon-Freigabe, WebGL-
Einstellungen etc.). Aenderungen an `web/` wirken sofort, sobald der Daemon
neu gestartet ist -- kein Neubuendeln, kein `installieren-desktop.sh` noetig.

Gebuendelt (`frontendDist`, jetzt `web-huelle/`) ist nur noch eine winzige
Ersatzseite `offline.html`: sie erscheint, wenn `main.rs` beim Start keinen
TCP-Connect zum Daemon hinbekommt, zeigt "Server nicht erreichbar" und
probiert selbst alle paar Sekunden weiter (per `fetch(..., {mode:'no-cors'})`,
damit eine fehlende `COCKPIT_ORIGIN`-Freigabe den Test nicht verfaelscht),
bis sie auf die Daemon-URL weiterleitet.

Mikrofon (`web/sprachpegel.js`, `getUserMedia`) erteilt WebKitGTK nicht von
selbst -- `main.rs` behandelt das `permission-request`-Signal der rohen
`webkit2gtk::WebView` (per `with_webview`) und erlaubt Medien- und
Benachrichtigungsanfragen ausschliesslich fuer die Herkunft des Daemons.
Dieselbe Stelle setzt `HardwareAccelerationPolicy::Always` und
`enable_webgl(true)`, weil `WEBKIT_DISABLE_DMABUF_RENDERER=1` (noetig gegen
das leere Fenster unter Wayland/Hyprland) WebKit sonst die Grundlage nimmt,
von sich aus einen beschleunigten Kontext fuer three.js im Vault-Tab
anzulegen.

### Umgebungsvariablen

| Variable | Voreinstellung | Bedeutung |
|---|---|---|
| `COCKPIT_PORT` | `8765` | HTTP- und WebSocket-Port |
| `COCKPIT_HOST` | `127.0.0.1` | Bindeadresse |
| `COCKPIT_DB` | `~/.cockpit/cockpit.db` | SQLite-Datei |
| `COCKPIT_ROLLEN` | `<wurzel>/rollen` | Verzeichnis der Fachrollen |
| `COCKPIT_VAULT` | `/var/lib/cockpit/vault` | Spiegel des Obsidian-Vaults |
| `COCKPIT_SESSIONS` | `/var/lib/cockpit/sessions-desktop` | Spiegel der Sessions |
| `COCKPIT_ORIGIN` | — | zusaetzlich erlaubte Herkunft fuer die API |
| `BESZEL_URL/USER/PASS` | — | Zugang zum Monitoring-Hub (sonst nur eigener Host) |
| `PIPER_HOST/PORT` | `127.0.0.1:10200` | Sprachausgabe |
| `COCKPIT_MCP_BROWSER` | — | ueberschreibt den Browser-MCP-Server |
| `COCKPIT_KONTEN_DIR` | `~/.claude-konten` | Verzeichnis der Zusatzkonten (siehe unten) |

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
| `src/rollen.ts` | Fachrollen aus `rollen/*.md`: Modell, Werkzeuge, Prompt |
| `src/mcp.ts` | Katalog der MCP-Server; der Browser laeuft ueber stdio |
| `src/system.ts` | Auslastung beider Server: Beszel-Hub, `/proc` als Notbehelf |
| `src/chats.ts` | Index der Claude-Code-Sessions, Volltextsuche ueber FTS5 |
| `src/vault.ts` | Index des Obsidian-Vaults: Titel, Wikilinks, Tags |
| `src/stimme.ts` | Sprachausgabe ueber Piper (Wyoming-Protokoll) |
| `src/konsole.ts` | Befehle mit Freigabepflicht |
| `src/konten.ts` | mehrere Claude-Code-Konten: Erkennung, Wahl, Sperrung bei Limit |
| `web/bus.js` | die eine WebSocket-Verbindung, Abonnements je Nachrichtentyp |
| `web/tabs.js` | Tab-Registry und Router ueber den URL-Hash |
| `web/tabs/*.js` | die fuenf Ansichten: Lauf, Chats, Vault, Konsole, Server |
| `web/index.html` | Geruest, Kopfzeile, Stile |

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

## Mehrere Konten

Ein Konto ist nichts weiter als ein eigenes `CLAUDE_CONFIG_DIR`: eigene
`.credentials.json`, eigenes `.claude.json`, eigenes `projects/`. Das
Hauptkonto (`haupt`) ist `/home/claude/.claude`, unveraendert. Zusatzkonten
legt `deploy/konto-hinzufuegen.sh <name>` unter `COCKPIT_KONTEN_DIR` an
(Vorgabe `~/.claude-konten/<name>/`) und verlinkt deren `projects/` auf das
des Hauptkontos, damit `resume` eine Session auch nach einem Kontowechsel
wiederfindet -- der Projektschluessel unter `projects/` haengt am
Arbeitsverzeichnis, nicht am Konto.

`src/konten.ts` scannt dieses Verzeichnis bei jedem Zugriff neu (kein
Zwischenspeicher), damit ein frisch angemeldetes Konto ohne Neustart des
Daemons auftaucht. Nur ein Konto mit gueltiger `.credentials.json` gilt als
nutzbar. Der Supervisor waehlt je Agentenstart das bevorzugte Konto, sonst das
erste freie; laeuft ein Konto in ein Nutzungslimit, wird es bis zum
gemessenen oder geschaetzten Reset gesperrt und der Agent macht per `resume`
mit dem naechsten freien Konto weiter, statt in `waiting_ratelimit` zu parken
-- sichtbar als Protokollzeile im Lauf-Log. Erst wenn alle Konten gesperrt
sind, gilt das alte Warteverhalten. `GET /api/konten` und `POST /api/konten`
lesen bzw. setzen den Vorzug; der Server-Tab zeigt die Konten mit Ampel, Abo
und Sperrstatus.

## Fachrollen

`AgentRole` in `src/typen.ts` ist die **Stellung** im Lauf (orchestrator,
worker, chat, subagent) -- daran haengt der Graph mit seinen drei Ebenen. Die
**Spezialisierung** steht daneben als `AgentState.fachrolle`. Waeren die
Fachrollen in `AgentRole` gelandet, fielen sie alle in die Worker-Ebene und
der Graph waere still falsch.

| Rolle | Modell | Werkzeuge | Zweck |
|---|---|---|---|
| `orchestrator` | Opus | keine | beauftragt, prueft, entscheidet |
| `rechercheur` | Sonnet | lesend + Browser | liest, sucht, belegt; aendert nichts |
| `coder` | Sonnet | alle | aendert Code, weist mit Tests nach |
| `kommunikator` | Sonnet | lesend | uebersetzt zwischen den Rollen, meldet nach aussen |

Adressiert wird mit einer optionalen ersten Zeile im Auftrag:

    AN-ROLLE: rechercheur

Je Auftrag, nicht je Antwort -- eine Runde darf einen Rechercheur und einen
Coder gleichzeitig beschaeftigen. Fehlt die Zeile, gilt `coder`; damit laufen
Auftraege aus der Zeit vor den Fachrollen unveraendert weiter.

## Die Tabs

| Tab | Was er zeigt |
|---|---|
| **Lauf** | Live-Log, Agentengraph, Zeitachse, Freigaben -- die urspruengliche Ansicht |
| **Chats** | die Claude-Code-Sessions vom Desktop, durchsuchbar und lesbar |
| **Vault** | Notizen und Agenten in einer 3D-Szene (three.js, fest eingelegt) |
| **Konsole** | Befehle auf dem Server, jeder einzeln freizugeben |
| **Server** | Auslastung beider Maschinen: CPU, Speicher, Platte, Temperatur |

Vault und Sessions kommen per Syncthing vom Desktop, beide als `receiveonly` --
der Spiegel schreibt nie zurueck. Details in `deploy/stacks/README.md`.

## Die Konsole hat keine Shell im Netz

Jeder Befehl geht durch denselben Freigabe-Broker wie ein Werkzeugaufruf eines
Agenten: er wird angefragt, erscheint im Tab, laeuft erst nach einem
ausdruecklichen Ja und steht danach im selben Nachweis. Ein "immer erlauben"
gibt es absichtlich nicht -- es wuerde genau das aushoehlen, wofuer der Tab so
gebaut ist.

Dasselbe gilt fuer den Browser der Agenten: er haengt an der Fachrolle, laeuft
je Sitzung in einem eigenen Container ueber `docker run --rm -i` und behaelt
kein Profil.

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
| `/api/rollen` | GET | verfuegbare Fachrollen |
| `/api/konten` | GET | bekannte Konten mit Anmelde-, Sperr- und Vorzugsstatus |
| `/api/konten` | POST | bevorzugtes Konto setzen (`name`, `null` hebt es auf) |
| `/api/system` | GET | Auslastung beider Server |
| `/api/chats?q=` | GET | Sessions suchen |
| `/api/chats/<id>` | GET | eine Session als Beitraege |
| `/api/vault/graph?run=<id>` | GET | Notizen, Verknuepfungen und Agenten |
| `/api/konsole` | POST | Befehl anfragen (Freigabe noetig) |
| `/api/sprechen` | POST | Text als WAV; 503, wenn Piper fehlt |

## Stand

Alle geplanten Stufen sind umgesetzt: Umzug auf servertwo, Tab-Geruest und PWA,
Server-Auslastung, Fachrollen, Vault-Graph, Chat-Verzeichnis, Sprachausgabe,
Konsole mit Freigabe und der Browser fuer die Agenten.

Nicht verifiziert: ob die PWA sich im Handy-Chrome wirklich installieren laesst
(der Service Worker scheitert im eingebauten Browser-Fenster), und der
Kaltstart der Autostart-Kette auf dem Desktop.
