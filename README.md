# Cockpit

Claude Code im Browser, am Handy und in der Desktop-App: Chats wie in Claude
Desktop (Modell, Denkaufwand, Berechtigungsmodus, Freigaben, Spezialisten,
To-do-Listen), dazu Team-Auftraege (ein Orchestrator beauftragt Worker),
Nutzung und Limits aller Konten, Serverlast, Notizen und ein Terminal mit
Freigabe.

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
von sich aus einen beschleunigten Kontext anzulegen (damals fuer die
3D-Ansicht, die es nicht mehr gibt; die Einstellung schadet nicht).

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
| `PIPER_TIMEOUT_MS` | `20000` | wie lange auf Piper gewartet wird |
| `WHISPER_HOST/PORT` | `127.0.0.1:10300` | Spracherkennung |
| `WHISPER_TIMEOUT_MS` | `20000` | wie lange auf Whisper gewartet wird |
| `COCKPIT_MCP_BROWSER` | — | ueberschreibt den Browser-MCP-Server |
| `COCKPIT_KONTEN_DIR` | `~/.claude-konten` | Verzeichnis der Zusatzkonten (siehe unten) |
| `COCKPIT_VARIANTE` | — | Variante unter `varianten/<name>/`, z.B. `roblox` (siehe unten) |

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/typen.ts` | Ereignisschema, Agentenzustand, Tokengewichte, Limitstand |
| `src/db.ts` | SQLite mit WAL, Backfill ab Sequenznummer, Aufräumen verwaister Läufe |
| `src/normalisieren.ts` | SDK-Nachricht → Cockpit-Ereignis, defensiv gegen neue Varianten |
| `src/protokoll.ts` | Vier-Fälle-Protokoll, Report-Typ, Blocker, Wiederholungserkennung |
| `src/supervisor.ts` | Eine SDK-Session je Agent, Freigabe-Broker, Verbrauchszähler, Kontowechsel |
| `src/orchestrator.ts` | Runden, Fallauswertung, Leseanfragen, Stoppbedingungen |
| `src/daemon.ts` | HTTP, WebSocket, REST |
| `src/nachlieferung.ts` | Senden an WebSocket-Klienten, Nachlieferung nach `folgen` |
| `src/einstellungen.ts` | Einstellungen in der DB: Modell, Denkaufwand, Modus, Ordner, Spezialisten, Team |
| `src/chatOptionen.ts` | Einstellungen + Wahl des Zuges → SDK-Optionen eines Chats |
| `src/chatZuege.ts` | Buchfuehrung ueber laufende Chat-Zuege |
| `src/freigaben.ts` | Entscheidung der Oberflaeche → Antwort an die SDK (immer erlauben, Rueckfragen, Plan) |
| `src/chats.ts` | Index der Claude-Code-Sessions (FTS5), Fortsetzen, Verlauf lesen |
| `src/nachrichten.ts` | Sitzungszeilen und Live-Ereignisse → Nachrichten der Chat-Ansicht |
| `src/aufgaben.ts` | Was laeuft: Agenten, To-do-Listen, Spezialisten, Team-Stand |
| `src/nutzung.ts` | Tokenverbrauch je Tag ueber alle Konten (Nutzungsraster) |
| `src/rollen.ts` | Fachrollen aus `rollen/*.md`: Modell, Werkzeuge, Prompt; Spezialisten |
| `src/mcp.ts` | Katalog der MCP-Server; der Browser laeuft ueber stdio |
| `src/system.ts` | Auslastung beider Server: Beszel-Hub, `/proc` als Notbehelf, Verlauf 1 h |
| `src/verzeichnisse.ts` | Ordner durchsuchen fuer die Projektwahl |
| `src/vault.ts` | Ort und Muster des Obsidian-Vaults |
| `src/notizen.ts` | Notizen durchsuchen und lesen |
| `src/vaultZugriff.ts` | Lesezugriffe des Chat-Agenten im Vault ohne Freigabe |
| `src/stimme.ts` | Sprachausgabe ueber Piper (Wyoming-Protokoll) |
| `src/hoeren.ts` | Spracherkennung ueber Whisper (Wyoming-Protokoll) |
| `src/wav.ts` | WAV-Kopf bauen und lesen |
| `src/wyoming.ts` | Wyoming-Rahmen schreiben/zerlegen, ohne Netzwerk -- von hoeren.ts genutzt |
| `src/audio.ts` | PCM auf 16 kHz resampeln |
| `src/konsole.ts` | Befehle mit Freigabepflicht |
| `src/variante.ts` | Varianten: Name, abgeschaltete Bereiche, Arbeitswurzel, eigene Anweisungen und Rollen |
| `src/konten.ts` | mehrere Claude-Code-Konten: Erkennung, Wahl, Sperrung bei Limit |
| `src/kontenNutzung.ts` | Limits und Guthaben je Konto abfragen |
| `src/discord.ts` | Status- und Freigabekanal ueber Discord |
| `src/eingaben.ts`, `src/httpFehler.ts` | Pruefung von API-Eingaben, Statuscodes |
| `web/index.html`, `web/app.js` | Geruest: Seitenleiste (am Handy Schublade), Router ueber den URL-Hash |
| `web/ui/*.js` | Chat, Eingabe, Werkzeuge/Diff, Chatliste und die Bereiche |
| `web/stil.css`, `web/bereiche.css` | Stil (dunkles Farbschema) |
| `web/bus.js` | die eine WebSocket-Verbindung, Abonnements je Nachrichtentyp |
| `web/vendor/` | marked, DOMPurify, highlight.js -- erzeugt von `scripts/vendor.mjs` |

Die Oberflaeche hat keinen Build-Schritt: der Daemon liefert `web/` so aus,
wie es im Repo liegt.

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
nutzbar. Der Supervisor waehlt je Agentenstart das bevorzugte Konto (manuelle
Uebersteuerung), sonst das Konto mit dem niedrigsten Wochenanteil
(Balancing, 3 Punkte Hysterese gegen Hin- und Herspringen). Den Wochenanteil
misst ein Poll alle 10 Minuten ueber `/api/oauth/usage?skip_spend=1`
(`src/kontenNutzung.ts`, verbraucht nichts) und nebenbei jedes
`rate_limit_event` eines laufenden Agenten. Meldet der Poll ein volles
Fenster, wird das Konto sofort bis zum Reset gesperrt. Ist das Token eines
ungenutzten Kontos abgelaufen, liefert der Poll nichts (kein eigener
Token-Refresh) -- das Konto zaehlt dann als ungemessen (0 %), und es greift
der Wechsel beim Limit. Laeuft ein Konto in ein Nutzungslimit, wird es bis zum
gemessenen oder geschaetzten Reset gesperrt und der Agent macht per `resume`
mit dem naechsten freien Konto weiter, statt in `waiting_ratelimit` zu parken
-- sichtbar als Hinweis im Chat. Erst wenn alle Konten gesperrt
sind, gilt das alte Warteverhalten. `GET /api/konten` und `POST /api/konten`
lesen bzw. setzen den Vorzug; der Bereich Nutzung zeigt je Konto Woche und
5 Stunden, den Modus (ausgeglichen/manuell) und wer als naechstes drankaeme.

## Varianten

Dieselbe Software laesst sich als zweite Instanz fuer einen anderen Zweck
betreiben. `COCKPIT_VARIANTE=<name>` liest `varianten/<name>/`:
`variante.json` (Name, abgeschaltete Bereiche `notizen`/`terminal`/`server`,
Arbeitswurzel, Absender und Vorschlaege der Oberflaeche), `anweisungen.md`
(ersetzt die Einleitung des Chat-Systemprompts) und `rollen/` (eigene
Fachrollen). Abgeschaltete Bereiche fehlen auch in der API, nicht nur in der
Oberflaeche; ausserhalb der Arbeitswurzel startet kein Chat und kein
Team-Auftrag, und die Ordnerwahl zeigt nichts davon. Ohne die Variable bleibt
alles wie bisher.

Einzige Variante bisher: das **Roblox-Cockpit** (`varianten/roblox/`), das
mit Konto 2 nur Roblox-Spiele baut und mitbenutzt wird. Es laeuft als eigener
Linux-Benutzer hinter einer Netzsperre, siehe `deploy/roblox/EINRICHTUNG.md`.

## Fachrollen

`AgentRole` in `src/typen.ts` ist die **Stellung** im Lauf (orchestrator,
worker, chat, subagent) -- danach ordnet der Bereich Aufgaben die Agenten. Die
**Spezialisierung** steht daneben als `AgentState.fachrolle`. Waeren die
Fachrollen in `AgentRole` gelandet, waere die Stellung eines Rechercheurs im
Lauf nicht mehr ablesbar.

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

## Die Oberflaeche

Links die Seitenleiste mit "Neuer Chat", der Chatliste (Suche) und den
Bereichen; am Handy ist sie eine Schublade. Jeder Stand hat eine Adresse
(`#/chat/<id>`, `#/nutzung`, `#/notizen/<id>` ...), Zurueck funktioniert.

| Bereich | Was er zeigt |
|---|---|
| **Chat** | Verlauf mit Markdown, Werkzeugzeilen, Diffs, To-do-Listen und Spezialisten; Eingabe mit Ordner, Modell, Denkaufwand, Modus und Mikrofon; Freigaben, Rueckfragen und Plan direkt im Chat |
| **Aufgaben** | was laeuft: je Chat oder Team-Auftrag die Agenten, To-do-Listen, Spezialisten; Fragen des Orchestrators und Freigaben der Worker beantworten; Team-Auftrag starten |
| **Nutzung** | Jahresraster, Kennzahlen, Rueckblick je Tag, Konten mit Limits, Reset, Prognose, Guthaben und Vorzug |
| **Server** | Auslastung beider Maschinen mit Verlauf der letzten Stunde |
| **Notizen** | Obsidian-Vault durchsuchen und lesen, Verweise und Rueckverweise |
| **Terminal** | Befehle auf dem Server, jeder einzeln freizugeben |
| **Einstellungen** | Vorgaben fuer Modell, Denkaufwand, Modus, Arbeitsordner, Spezialisten, Team, Sprache |

Vault und Sessions kommen per Syncthing vom Desktop, beide als `receiveonly` --
der Spiegel schreibt nie zurueck. Details in `deploy/stacks/README.md`.

Pruefen im Browser: `node scripts/oberflaeche-pruefen.mjs [url] [ansichten]`
(1280 und 375 px, Konsolenfehler, Ueberbreite, Bilder nach
`nachtschicht-bilder/`).

## Sprache

**Diktieren:** Das Mikrofon in der Chat-Eingabe schaltet man selbst an und
aus, ein automatisches Ende gibt es nicht (Pausen sind erlaubt, nur nach
10 Minuten geht es von selbst aus). Waehrend man spricht, steht der Text
schon grau im Eingabefeld. Man kann ihn jederzeit mit der Tastatur aendern
und dann weiterreden. Beim Mikro-Aus wird er normal, abschicken tut man
selbst.

Zwei Erkennungen arbeiten zusammen (`web/diktat.js`):

- **Vosk** (`deploy/stacks/vosk/`, deutsches Kleinmodell) liefert die graue
  Vorschau in Echtzeit. Der Browser schickt 16-kHz-PCM ueber `/ws?hoeren`,
  `src/liveHoeren.ts` reicht es an den Container auf 127.0.0.1:2700 durch.
  Das Ergebnis ist klein geschrieben und ohne Satzzeichen.
- **Whisper** (`deploy/stacks/whisper.yml`, `small-int8`) schreibt jeden
  abgeschlossenen Satz danach sauber, schon waehrend man weiterspricht: per
  `POST /api/hoeren`, immer nur ein Aufruf zugleich, gesammelt hoechstens
  12 s Audio. Ein Aufruf braucht auf servertwo 5-7 s, 30 s Audio schafft
  Whisper nicht mehr innerhalb seines 20-s-Limits. Deshalb laeuft es
  satzweise im Hintergrund statt einmal am Ende.

Was man selbst getippt oder geaendert hat, fasst keine der beiden
Erkennungen mehr an. Das gilt nur fuer die beruehrten Saetze, die anderen
verbessert Whisper weiter. Ist Vosk nicht erreichbar, laeuft das Diktat ohne
Vorschau: Saetze werden dann an Sprechpausen abgeschnitten, und den Text
liefert allein Whisper.

Die graue Schrift ist ein Spiegel unter dem Feld, denn eine `textarea` kann
Teile ihres Textes nicht faerben. Waehrend des Diktats schreibt das Feld
deshalb durchsichtig, Cursor und Auswahl bleiben sichtbar. Ein AudioWorklet
(`web/hoerer-prozessor.js`, als Rueckfall ScriptProcessorNode) greift das
Mikrofon ab. Bewusst kein `MediaRecorder` und keine Web-Speech-API: Beide
fehlen im WebKitGTK der Tauri-Huelle, und die Web-Speech-API liefe ueber
Googles Server.

**Sprachausgabe:** Piper (`POST /api/sprechen`, Browserstimme als Rueckfall)
meldet je nach Stufe in den Einstellungen wartende Freigaben und Fragen; die
Stufe gilt je Geraet.

Das fruehere Sprachgespraech der Zentrale (werkzeugloser Antwort-Agent,
`/api/gespraech`) ist mit der Zentrale weggefallen -- gesprochen wird jetzt
in einen normalen Chat.

## Das Terminal hat keine Shell im Netz

Jeder Befehl geht durch denselben Freigabe-Broker wie ein Werkzeugaufruf eines
Agenten: er wird angefragt, erscheint im Bereich Terminal, laeuft erst nach einem
ausdruecklichen Ja und steht danach im selben Nachweis. Ein "immer erlauben"
gibt es absichtlich nicht -- es wuerde genau das aushoehlen, wofuer der Bereich so
gebaut ist. Der Bereich Terminal zeigt die letzten 30 Befehle (`GET
/api/konsole`).

Dasselbe gilt fuer den Browser der Agenten: er haengt an der Fachrolle, laeuft
je Sitzung in einem eigenen Container ueber `docker run --rm -i` und behaelt
kein Profil.

## REST

| Endpunkt | Methode | Zweck |
|---|---|---|
| `/api/gesundheit` | GET | Status und letzter Limitstand |
| `/api/laeufe` | GET | Liste der Läufe |
| `/api/lauf/<id>?seit=<seq>` | GET | Agenten, Ereignisse ab Sequenznummer, offene Freigaben |
| `/api/chats?q=` | GET | Chats suchen |
| `/api/chats` | POST | neuer Chat `{text, cwd?, modell?, aufwand?, berechtigung?, anhaenge?}` -> `202 {id, laufId, cwd, startSeq}` |
| `/api/chats/<id>` | GET | ein Chat als Nachrichten |
| `/api/chats/<id>` | PATCH | nur Cockpit-Eintrag: `{titel?, angeheftet?, ausgeblendet?}` (Titel leer = Original; ausgeblendet bis zur naechsten Aktivitaet) |
| `/api/chats/<id>/weiter` | POST | weiterschreiben `{text, modell?, aufwand?, berechtigung?, anhaenge?}` |
| `/api/anhaenge?name=` | POST | Datei (roher Body, bis 20 MB) fuer den Chat ablegen -> `201 {pfad, name, groesse}`; `pfad` beim Senden in `anhaenge` mitgeben. Der Prompt nennt die Pfade, der Agent liest sie mit Read ohne Freigabe (`src/anhaenge.ts`). Ablage neben der DB (`anhaenge/<Datum>/`, `COCKPIT_ANHAENGE`), nach 30 Tagen geloescht |
| `/api/anhaenge/datei?pfad=` | GET | Anhang fuer die Vorschau im Chat (nur Bilder inline, sonst Download) |
| `/api/freigabe` | POST | Freigabe entscheiden `{id, erlaubt, immer?, antworten?, modus?, nachricht?}` |
| `/api/abbrechen` | POST | Agent (`runId`, `agentId`) oder ganzen Lauf (`runId`) abbrechen |
| `/api/orchestrator` | POST | Team-Auftrag starten |
| `/api/orchestrator/antwort` | POST | Frage des Orchestrators beantworten `{runId, text}` |
| `/api/aufgaben` | GET | laufende und kuerzliche Chats/Auftraege mit Agenten, To-dos, Spezialisten |
| `/api/einstellungen` | GET, POST | Einstellungen lesen bzw. teilweise aendern |
| `/api/verzeichnisse?pfad=` | GET | Ordner, Favoriten, zuletzt benutzte |
| `/api/rollen` | GET | Fachrollen und Spezialisten |
| `/api/konten` | GET | Konten mit Anmelde-, Sperr-, Vorzugs- und Nutzungsstand, Guthaben, Prognose |
| `/api/konten` | POST | bevorzugtes Konto setzen (`name`, `null` hebt es auf) |
| `/api/nutzung` | GET | Tokens je Tag und Kennzahlen |
| `/api/nutzung/tag?tag=` | GET | Sitzungen eines Tages mit Chat |
| `/api/system` | GET | Auslastung beider Server, Verlauf 1 h |
| `/api/notizen?q=` | GET | Notizen suchen (ohne `q` die neuesten) |
| `/api/notizen/lesen?id=` | GET | eine Notiz mit Verweisen und Rueckverweisen |
| `/api/konsole` | GET, POST | letzte Befehle bzw. Befehl anfragen (Freigabe noetig) |
| `/api/sprechen` | POST | Text als WAV; 503, wenn Piper fehlt |
| `/api/hoeren` | POST | WAV-Audio (Body) als Text erkennen; 503, wenn Whisper fehlt |

Ueber den WebSocket (`/ws`) kommen `ereignis`, `agent`, `delta` (Live-Text),
`freigabe`, `aufgaben`, `chats`, `einstellungen`, `konsole`, `limit`,
`system`, `orchestrator` und `lauf_ende`.

## Stand

Umgebaut nach `UMBAU-PLAN.md` (September 2026): die Oberflaeche folgt Claude
Desktop, die Zentrale mit Wissenskern, der Lauf-Graph und die alten Tabs sind
entfernt. Fortschritt und offene Punkte stehen in `UMBAU-LOGBUCH.md`.

Nicht verifiziert: ob die PWA sich im Handy-Chrome wirklich installieren laesst
und ein Diktat ueber ein physisches Mikrofon (die Kette wurde mit einer per
Piper erzeugten WAV-Datei geprueft).
