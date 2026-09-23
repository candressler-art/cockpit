# Nachtschicht-Logbuch

## Fuer Can (Kurzfassung)

- **Durchgang 8:** Prioritaet 2, den bisher offenen Punkt "Zustaende mit
  aktiven Agenten noch nicht visuell geprueft" (aus Durchgang 5) endlich
  angegangen -- und dabei zwei echte, zusammenhaengende Bugs gefunden und
  behoben:
  1. **Zentrale-Tab: Agenten-Panel blieb nach einem (Neu-)Laden leer, auch
     wenn laengst ein Auftrag lief.** Das Panel fuellte sich ausschliesslich
     aus WebSocket-Ereignissen ab dem Verbindungsaufbau; anders als der
     Lauf-Tab (der `/api/lauf/<id>` beim Mount abfragt) holte die Zentrale
     nie per REST den aktuellen Stand nach. Wer die Seite laedt oder neu
     laedt, waehrend ein Orchestrator-Lauf schon eine Weile arbeitet, sah
     "keine aktiven" bis zum naechsten Live-Ereignis -- ausgerechnet auf der
     Seite, die laut eigenem Kommentar "den Zustand des ganzen Systems
     gleichzeitig" zeigen soll. Live nachgewiesen: ein synthetischer Lauf
     (drei Agenten in unterschiedlichen Zustaenden) direkt in die Test-DB
     eingetragen -- ohne echten Agentenprozess, nur Datenbankzeilen --, dann
     mit Playwright NUR die Zentrale geoeffnet, nie den Lauf-Tab besucht: vor
     dem Fix "keine aktiven", danach sofort alle drei sichtbar. Ein
     zusaetzlicher Test mit einem echten (an "Not logged in" scheiternden)
     Lauf bestaetigt, dass sich Erstbefuellung und Live-WS-Pfad sauber
     mischen (kein Duplikat). Commit "Zentrale: Agenten-Panel zeigt laufende
     Agenten auch ohne Lauf-Tab-Besuch".
  2. **Vault-Tab: derselbe Fehler, aber mit schon fertiger, nur nie
     aufgerufener Serverunterstuetzung.** `/api/vault/graph` liefert laut
     eigenem Code-Kommentar in `daemon.ts` ("Notizen und Agenten in EINER
     Szene") Agenten eines Laufs mit -- aber nur, wenn `?run=<id>`
     mitgegeben wird. `web/tabs/vault.js` rief die Route seit jeher OHNE
     diesen Parameter auf, das Feld war dadurch immer leer. Fix: vault.js
     fragt beim Mount zuerst `/api/laeufe` nach einem laufenden Auftrag und
     haengt dessen `run_id` an. Live verifiziert wie oben (synthetischer
     Lauf, Playwright, vorher/nachher-Vergleich). Commit "Vault:
     3D-Agentenanzeige nutzt den vom Server schon vorbereiteten
     ?run=-Parameter".
  Zusaetzlich systematisch geprueft (kein weiterer Bug gefunden, siehe
  "Erledigt" unten fuer Details): Freigabe-Dialog mit echtem, langem Inhalt
  (Desktop UND mobile Schublade) sieht sauber aus, kein Ueberlauf, `pre`
  scrollt wie vorgesehen. Tablet-Breite 800px (in der 768-820px-Luecke aus
  Durchgang 5) durchgetestet -- ein vermeintlicher Fund (Freigaben-Panel
  "ragt" bei 800px weit ueber den Rand) war ein Mess-Artefakt des eigenen
  Testskripts (Kinder eines `position:fixed`-Elements erben dessen
  Unsichtbarkeit, das Skript pruefte das nur fuer das Element selbst, nicht
  die Vorfahrenkette) -- nach Korrektur des Skripts: kein Ueberlauf. Auch
  **Fehlerzustaende bei Serverausfall** (letzter offener Punkt aus
  Durchgang 5) jetzt erstmals visuell/live geprueft: Test-Daemon mitten in
  einer offenen Browsersitzung beendet (simuliert Netzwerkausfall/Neustart
  waehrend der Nutzung), alle sechs Tabs durchgeklickt. Kein Absturz, keine
  unbehandelte Exception (`pageerror`) -- nur erwartete
  Netzwerk-Konsolenmeldungen. "getrennt — neuer Versuch" erscheint korrekt
  im Kopf, alte Daten bleiben sichtbar statt einer Fehlerwand (Server-Tab,
  wie schon in Durchgang 4 als bewusstes Verhalten dokumentiert). Kleiner
  Schoenheitsfehler, NICHT behoben (siehe "Offene Punkte"): Chats/Vault/
  Server-Tab zeigen bei einem fehlgeschlagenen ERSTEN Laden die rohe
  `TypeError: Failed to fetch`-Meldung statt eines deutschen Satzes -- lesbar
  und nicht irrefuehrend, aber unschoen.
- **Durchgang 7:** Erster gruendlicher Blick auf `src/orchestrator.ts`
  selbst (vorher nur das aussenrum liegende Speicherleck angeschaut, siehe
  Durchgang 6) -- zwei echte, wenn auch seltene, Robustheitsluecken
  gefunden und behoben:
  1. **Leseanfrage-Limit fehlerhaft behandelt:** Antwortet der Orchestrator
     VIER Mal in Folge mit `LESE-ANFRAGE` (statt irgendwann zu
     WEITER/ENTSCHEIDUNG/FERTIG zu wechseln), verliess die innere Schleife
     in `fahren()` ohne das erwartete `break` -- der Code danach behandelte
     das faelschlich wie einen normalen "weiter"-Fall mit leerem
     `NAECHSTER-PROMPT`. Die naechste Runde bekam dadurch null Auftraege,
     und der Lauf starb eine Runde SPAETER mit der irrefuehrenden Meldung
     "Worker lieferte keinen Report", obwohl nie ein Worker lief. Jetzt:
     sofortiger, klarer `formatfehler` mit Grundangabe. Per Test bewiesen
     (`tests/warten.test.mjs`, Test 5): schlaegt ohne den Fix nachweislich
     fehl (per `git stash`/Patch-Diff verifiziert, nicht nur behauptet).
  2. **Leseanfrage (DATEI/GREP) ohne Groessendeckel:** Der Code warnte
     selbst schon (Kommentar beim Regex-Deckel gegen katastrophales
     Backtracking) davor, dass ein blockierender Aufruf in
     `leseZeileAusfuehren()` die EINE Ereignisschleife des Daemons einfriert
     -- deckelte aber nur das Suchmuster, nicht die Dateigroesse. Ein vom
     Orchestrator angefragtes `GREP`/`DATEI` auf eine grosse Datei im
     Arbeitsverzeichnis (Logdatei, DB-Dump, versehentlich mitgelesenes
     Binaerartefakt) haette den ganzen Daemon fuer die Lesedauer
     eingefroren, nicht nur diesen Lauf -- das synchrone `readFileSync`
     kennt keine Groessenpruefung vorher. Fix: 2-MB-Deckel per `statSync`
     vor jedem Lesen, sonst klare "abgelehnt"-Meldung. Neue Testdatei
     `tests/orchestrator.test.mjs` (in `package.json` eingetragen) deckt
     DATEI/GREP je normal und ueber dem Deckel ab, plus den bestehenden
     Pfad-Ausbruchsschutz als Regressionstest.
  Der Rest von `orchestrator.ts` (Blocker-Erkennung, Wiederholungs-Check,
  Token-Budget-Pruefung, Parallelitaet, Rollen-Aufloesung) wurde beim
  gruendlichen Durchlesen sonst nicht auffaellig -- eine kleine, bewusst
  NICHT behobene Beobachtung: bei Fall B (Entscheidung noetig -> Mensch
  antwortet -> Lauf laeuft weiter) wird die Token-Budget-Pruefung fuer
  genau diese eine Runde uebersprungen (der `continue` springt daran
  vorbei) -- kein Verlust, die naechste "weiter"-Runde summiert ohnehin
  ueber ALLE bisherigen Agenten, also wird ein Ueberschreiten nur um eine
  Runde spaeter erkannt, nie dauerhaft uebersehen. Nicht als Bug behandelt.
- **Durchgang 6, wichtigster Fund:** Ein echtes Speicherleck in Prioritaet 3
  (Daemon-Robustheit) -- genau die Art Fehler, vor der ein eigener
  Code-Kommentar schon warnte, aber der Fix dazu war nie verdrahtet.
  `Supervisor.laufVergessen()` (`src/supervisor.ts`) existiert extra dafuer,
  dass `agenten`- und `seq`-Map nicht ueber die ganze Prozesslaufzeit wachsen
  ("bei einem Daemon, der wochenlang laeuft"), wurde aber **von nirgends im
  Code aufgerufen** -- weder bei einem Orchestrator-Lauf noch bei einem
  einfachen Chat-Lauf ueber `POST /api/lauf`. Beide bekommen bei jedem
  Aufruf eine frische `runId` (anders als Chat-Fortsetzen/Konsole/Gespraech,
  die eine feste `runId` je Sitzung wiederverwenden und denselben Map-Eintrag
  ueberschreiben statt neue anzuhaeufen) -- jeder je gestartete Agent jedes
  je gelaufenen Auftrags blieb dadurch fuer immer im Speicher. Behoben:
  `supervisor.laufVergessen(runId)` jetzt in `daemon.ts` an beiden Stellen
  aufgerufen, nachdem der Lauf wirklich zu Ende ist (`.finally()`, nach allen
  Stellen, die noch lesend auf die Live-Agentenliste zugreifen). **Live
  verifiziert** (siehe "Wie getestet" unten): ohne den Fix blieb nach einem
  Testlauf ein Eintrag fuer immer stehen, mit dem Fix ist er nach
  `laufVergessen` weg -- UND beide betroffenen HTTP-Routen (`/api/lauf`,
  `/api/orchestrator`) laufen mit dem Fix unveraendert bis zum sauberen
  `failed`-Endzustand durch, keine Regression.
- **Weiterer Blick auf Prioritaet 3** (Vault, Konsole, Sprachausgabe/
  -eingabe, Fachrollen, Sprachgespraech): `src/vault.ts`, `src/vaultZugriff.ts`,
  `src/konsole.ts`, `src/rollen.ts`, `src/gespraech.ts`, `src/hoeren.ts`,
  `src/stimme.ts` gegengelesen. Kein weiterer Fehler gefunden -- Details
  unten unter "Erledigt (Durchgang 6)", inklusive der Stellen, die ich
  gezielt auf Fehlerklassen wie falsche Fehlerbehandlung bei `maxBuffer`/
  Timeout in der Konsole ueberprueft habe (per echtem Node-Experiment, nicht
  nur Codelesen).
- **Kleinere, bewusst nicht behobene Beobachtung:** Chat-Sitzungen
  (`src/chats.ts`, `chat-<sessionId>` als Pseudo-`runId`) haben denselben
  "eine `runId` bleibt fuer immer im Speicher"-Charakter wie das behobene
  Leck, sind aber viel kleiner (ein Eintrag pro je ERSTELLTER Chat-Sitzung,
  nicht pro Turn/Wechsel -- weiteres Fortschreiben ueberschreibt denselben
  Map-Eintrag). Nicht angefasst: mit sehr vielen Chats ueber Monate waere das
  trotzdem ein langsames Wachstum. Siehe "Offene Punkte" unten.
- **Durchgang 5:** Prioritaet 2 (Desktop-App/Oberflaeche) zum ersten Mal
  angeschaut -- bisher hatte kein Durchgang dort angefangen. Playwright +
  Chromium liessen sich in dieser Umgebung doch installieren (kein
  Systembibliotheken-Problem, anders als befuerchtet), damit konnte ich
  tatsaechlich im echten (headless) Browser gegen die Testinstanz pruefen,
  nicht nur Code lesen. **Ergebnis: kein einziger neuer Layout-Bug
  gefunden.** Alle sechs Tabs (Zentrale, Lauf, Chats, Vault, Konsole,
  Server) bei 1280px und 375px systematisch gescreenshottet, im leeren
  Zustand UND mit echten Testdaten (Vault mit 3 verlinkten Notizen, ein
  Chat mit echtem Verlauf), inklusive Tab-Wechsel-Stresstest (10 schnelle
  Spruenge zwischen allen Tabs, zwei Durchlaeufe) und der mobilen
  Agenten-/Freigaben-Schublade (oeffnen, wechseln, per Tipp auf den Inhalt
  schliessen). Die schon vorhandene Absicherung gegen die
  ID-vs-Klassen-Spezifitaets-Falle (`#tab-x.an{...}` statt `#tab-x{...}`,
  siehe `web/index.html`) haelt: keine der drei betroffenen Regeln
  (`#tab-vault.an`, `#tab-konsole.an`, `#tab-zentrale.an`) kann je ohne
  `.an` greifen, der Sicherheitsnetz-Selektor `#app>.tabflaeche:not(.an)`
  gewinnt in jedem Fall. Zwei vermeintliche Funde erwiesen sich bei
  genauerem Hinsehen als gewolltes Verhalten (siehe "Erledigt" unten) --
  dokumentiert, damit ein spaeterer Durchgang nicht dieselbe Zeit noch
  einmal investiert. Screenshots liegen unter `nachtschicht-bilder/`
  (gitignored, nicht committet) fuer Cans eigene Kontrolle.
  `src-tauri/` weiterhin nicht angefasst (kein cargo hier).
- **Durchgang 4, wichtigster Fund:** Ein echter Chat-Tab-Bug, live gegen die
  Testinstanz reproduziert: sind waehrend eines fortgesetzten Chats
  irgendwann ALLE Konten gesperrt (kein weiteres zum Wechseln mehr), bleibt
  der Chat-Agent im Status `waiting_ratelimit` stehen -- ein Status, den der
  Chat-Tab (`web/tabs/chats.js`, `pollSchritt()`) bisher NICHT als Endzustand
  kannte. Folge: die Eingabe blieb fuer immer gesperrt, die
  "Claude arbeitet..."-Anzeige lief endlos weiter, der Poll alle 1,2s auch,
  und der Fehlertext kam nie an -- nur ein Neuladen der Seite half. Behoben
  (Commit "Chats: Kontowechsel bis zur Sperre aller Konten..."): eine Zeile,
  `waiting_ratelimit` gehoert jetzt zur Endzustandsliste. **Bitte im Browser
  gegenpruefen**, sobald Du kannst -- ich konnte die Oberflaeche nur ueber
  die berechneten Werte/HTTP pruefen (siehe "Wie getestet" unten), nicht
  visuell in einem echten Browser (kein DOM-Testaufbau in dieser Nachtschicht
  vorhanden, siehe Punkt zu Playwright/jsdom weiter unten).
- **Kontowechsel WAEHREND eines Chat-Fortsetzens** (die eigentliche Frage aus
  der Aufgabenliste) ist ansonsten sauber gebaut: `agentStarten()` in
  `supervisor.ts` haelt `resumeSessionId` selbst ueber mehrere Kontowechsel
  hinweg aktuell (`resumeSessionId = this.agenten.get(k)?.sessionId ??
  resumeSessionId`), und `chats.ts`/`daemon.ts` lesen erst NACH dem
  vollstaendigen Abschluss von `agentStarten()` die dann aktuelle
  `sessionId` aus, um `chat_fortsetzung.aktuelle_session` zu aktualisieren.
  Kein Wettlauf, keine veraltete Session-Id gefunden.
- **Discord-Bruecke** geprueft (nur Code-Lesen + Ereignis-Verdrahtung, kein
  eigener Discord-Server verfuegbar): Kontowechsel-Ereignisse sind vom Typ
  `protocol` und werden von `daemon.ts` an Discord weitergereicht
  (`discord.protokoll()`), erscheinen also im Lauf-Faden. Der Fall "letztes
  Konto auch noch gesperrt" ist vom Ereignistyp `rate_limit`, der bewusst
  NICHT an Discord geht (nur `protocol` und `error`, siehe Kommentar in
  `daemon.ts`) -- fuer einen Orchestrator-Lauf kommt trotzdem am Ende eine
  `laufBeendet`-Nachricht mit Grund und Text. Fuer einen Chat-Zug (kein
  Orchestrator-Lauf) gibt es dagegen GAR KEINE Discord-Nachricht, wenn alle
  Konten gesperrt sind -- das ist aber vermutlich kein Bug, sondern
  Kontext: Discord kennt Chats ueberhaupt nicht (keine Befehle dafuer, nur
  `!lauf`/`!stop`/`!status` fuer Orchestrator-Laeufe), also war ein
  Chat-Ereignis dort wohl nie vorgesehen.
- **Anzeige im Server-Tab** (`web/tabs/server.js`, Kontokarten) kurz
  gegengelesen: Leerzustand, Fehlerzustand (alte Liste bleibt stehen statt
  Fehlerwand), nicht angemeldet, gesperrt/frei, Ringe mit `null`-Werten --
  alles sauber abgefangen. Kein Fehler gefunden, aber nicht visuell
  (Browser) geprueft.
- **Durchgang 3, wichtigster Fund:** Ein Datenschutz-Bug in `emailLesen()`
  (`src/konten.ts`) liess eine isolierte Testinstanz (eigenes
  `CLAUDE_CONFIG_DIR`, wie in dieser Nachtschicht vorgeschrieben) fuer ein
  Test-Hauptkonto ohne eigene E-Mail still auf die ECHTE
  `/home/.../.claude.json` ausweichen -- ich habe live in meiner eigenen
  Testinstanz Deine echte E-Mail-Adresse aus `/api/konten` zurueckbekommen,
  obwohl ich extra ein eigenes `CLAUDE_CONFIG_DIR` gesetzt hatte. Behoben:
  der Home-Fallback greift jetzt nur noch, wenn `CLAUDE_CONFIG_DIR`
  tatsaechlich NICHT gesetzt ist (Commit "Konten: Hauptkonto-E-Mail nicht
  mehr aus dem echten Home lesen..."). Das betrifft vermutlich auch jede
  andere isolierte Instanz (z.B. eine zweite Cockpit-Installation), nicht
  nur meine Nachtschicht-Testinstanz.
- **Alle Konten gesperrt** end-to-end durchgetestet (siehe unten): Der Lauf
  endet sauber als `failed` mit klarer Fehlermeldung, haengt NICHT. Es gibt
  aber KEINE automatische Wiederaufnahme, sobald ein Konto wieder frei waere
  -- das ist eine bewusste Nicht-Entscheidung von mir, siehe "Entscheidung
  fuer Can" unten, keine automatische Fix-Anwendung.
- **Vorzug setzen/aufheben** end-to-end verifiziert: funktioniert korrekt in
  allen drei Faellen (setzen, aufheben mit `null`, unbekannter Kontoname ->
  404 ohne Seiteneffekt).
- **Durchgang 1** hat offenbar nichts committet und keine Notizen hinterlassen
  -- nur einen Test-Daemon auf Port 8798 (PID 663997, seit 21:11 gelaufen,
  mit Fake-Konten `zweit`/`zweit-test`/`dritt` unter `/tmp/nachtschicht`).
  Ich habe ihn ueber seine eigene PID beendet (nicht pkill) und mit einer
  frischen Instanz weitergemacht. Was Durchgang 1 dort genau geprueft hat,
  ist nicht rekonstruierbar -- die DB-Datei existierte schon, der Inhalt
  wurde nicht ausgewertet, nur die Konten-Verzeichnisse fuer eigene Tests
  weiterverwendet.
- **Gefundener und behobener Bug:** Ein Konto mit kaputtem/abgelaufenem
  Token liess den GANZEN Lauf sterben, statt auf ein anderes Konto zu
  wechseln -- obwohl genau dieser Fall in der Aufgabenliste ausdruecklich
  stand ("abgelaufenes Token"). Details unten unter "Erledigt". **Bitte
  pruefen:** die neue 5-Stunden-Sperre fuer ein Konto mit Anmeldefehler
  (siehe "Entscheidung fuer Can" unten) -- ist das die richtige Wartezeit,
  oder soll ein Login-Fehler kuerzer gesperrt werden als ein echtes Limit?
- Der Rest des Codes (`src/konten.ts`, `src/supervisor.ts`) ist ungewoehnlich
  gruendlich dokumentiert und mit vielen Tests abgesichert -- wirkt wie
  frisch von Can selbst fertiggestellt, nicht wie unfertiger Code. Die
  Nachtschicht-Aufgabe nennt es "ziemlich verbuggt"; nach genauerem Lesen
  wirkt Prioritaet 1 (Konten) eher solide, siehe Bestandsaufnahme.

## Bestandsaufnahme (Durchgang 2, 2026-09-23)

Repo ist sauber (kein uncommitted-Rest von Can), Branch `nacht-optimierung`,
`npx tsc && npm test` liefen bei Start bereits gruen (53/53 in
konten.test.mjs nach meinen Ergaenzungen, 49/49 in chats.test.mjs, Rest ok).

**Prioritaet 1 -- Mehrere Konten:** `src/konten.ts` und `src/supervisor.ts`
sind sehr sorgfaeltig gebaut: Sperre vor Vorzug vor Balancing, Hysterese
gegen Hin-und-Herspringen, korrekte Sekunden->ms-Umrechnung der SDK-Reset-
Zeitpunkte, ein eigener verbrauchsfreier Nutzungs-Poll (`kontenNutzung.ts`),
und ein sauberer Kontowechsel-Loop in `agentStarten()` mit Schutz gegen
Doppelwechsel (`versuchteKonten`-Set). Die Selbstdokumentation im Code ist
aussergewoehnlich gut (siehe Kommentare zu `sperrzeitpunktAusLimitstand`,
`versuchPrompt`, `kontoWaehlen`). Trotzdem war eine Luecke da, siehe unten.

**Noch nicht angeschaut in diesem Durchgang:** Prioritaet 2 (Desktop-App /
Tabs) und der Rest von Prioritaet 3 (Vault, Konsole, Orchestrator, Sprache).

## Erledigt (dieser Durchgang)

### Anmeldefehler eines Kontos toetete den ganzen Lauf statt zu wechseln

**Commit:** siehe `git log` nach diesem Log-Eintrag ("Kontowechsel: auch bei
kaputtem Token wechseln, nicht nur bei Nutzungslimit").

**Befund:** Live gegen die Testinstanz reproduziert (siehe "Wie getestet").
Ein Konto mit ungueltigem `accessToken` (z.B. ein wirklich abgelaufenes
Token, oder wie im Test ein Fake-Wert) laesst die CLI mit
`Claude Code returned an error result: Not logged in · Please run /login`
scheitern. Dieser Text kommt als ganz normale `result`-Nachricht mit
`is_error:true` durch -- exakt der Mechanismus, den ein frueherer Fix schon
fuer Nutzungslimits abgefangen hat (siehe Kommentar in `supervisor.ts` zu
"Vorher wurde ein Nutzungslimit nur erkannt..."). Nur passte "Not logged in"
zu keinem Eintrag in `USAGE_LIMIT_ERROR_PREFIXES` (SDK-Konstante, nur fuer
Nutzungslimits) -- der Agent landete als `failed`, der Kontowechsel-Loop in
`agentStarten()` griff gar nicht erst, OBWOHL andere Konten frei gewesen
waeren.

**Fix:** `src/konten.ts` bekommt `KONTO_AUTH_FEHLER_PRAEFIXE` (bisher nur
`'Not logged in'`, das einzige live beobachtete Beispiel) und zwei reine,
getestete Funktionen `istKontoFehlertext()` / `kontoFehlerLabel()`, die
Nutzungslimit-Text (SDK-Liste, als Parameter durchgereicht) und
Anmeldefehler-Text gemeinsam behandeln. `src/supervisor.ts` nutzt das jetzt
an allen drei Stellen, die vorher nur `USAGE_LIMIT_ERROR_PREFIXES` kannten:
die `schonGeantwortet`-Berechnung (wichtig: sonst wuerde ein
Anmeldefehler-Textblock faelschlich als "hat schon geantwortet" zaehlen und
beim Wechsel den falschen Fortsetzungsprompt ausloesen -- derselbe
Fehlerklasse wie der schon dokumentierte "schonGeantwortet"-Fund), die
`result`-Auswertung und den `catch`-Zweig fuer geworfene Exceptions. Die
Log-Meldung sagt jetzt korrekt "Anmeldefehler" statt "Nutzungslimit", wo das
zutrifft.

**Entscheidung fuer Can:** Ein Konto mit Anmeldefehler wird wie ein Konto im
Limit fuer `KONTO_SPERRE_VORGABE_MS` (5 Stunden) gesperrt, weil es keinen
"Reset-Zeitpunkt" fuer einen kaputten Login gibt und dieselbe Konstante schon
fuer "kein genauer Reset bekannt" existiert. Das ist konservativ (kein
Wiederholungssturm gegen ein kaputtes Konto), aber moeglicherweise zu lang,
wenn Can das Konto z.B. sofort neu anmeldet (`/login`) -- dann bleibt es bis
zu 5 Stunden faelschlich als gesperrt markiert, obwohl es laengst wieder
ginge. Es gibt aktuell KEINE Moeglichkeit, eine Sperre manuell aufzuheben
(auch nicht fuer echte Limit-Sperren) -- `/api/konten` POST setzt nur den
Vorzug, nicht die Sperre selbst. Falls das stoert: entweder ein kuerzeres
Backoff nur fuer Anmeldefehler (z.B. 10 Minuten statt 5 Stunden), oder ein
"Sperre aufheben"-Knopf/-Endpunkt. Beides ist eine Produktentscheidung, die
ich nicht eigenmaechtig treffen wollte.

**Wie getestet:**
- `tests/konten.test.mjs`, Abschnitt 15: `istKontoFehlertext()` /
  `kontoFehlerLabel()` / `KONTO_AUTH_FEHLER_PRAEFIXE` unit-getestet (reine
  Funktionen, ohne SDK oder Netzwerk). 53/53 gruen.
- End-to-end gegen die Testinstanz (Port 8798): Fake-Konto `zweit` mit
  `accessToken: "attrappe"` als Vorzug gesetzt, `POST /api/lauf` ausgeloest.
  **Vor dem Fix:** Lauf endete sofort als `failed`,
  `last_error: "...Not logged in · Please run /login"`, kein
  Kontowechsel-Ereignis. **Nach dem Fix:** Ereignisprotokoll zeigt
  `rate_limit: Anmeldefehler (zweit): ...Not logged in...` gefolgt von
  `protocol: Kontowechsel: zweit nicht nutzbar (Anmeldefehler), weiter mit
  haupt` -- der Wechsel greift jetzt. Der zweite Versuch scheiterte danach an
  `No conversation found with session ID: ...` -- das ist ein Artefakt
  meines Test-Setups (meine Fake-Konten `zweit`/`dritt` haben KEIN
  `projects/`-Symlink auf das Hauptkonto, anders als
  `deploy/konto-hinzufuegen.sh` es fuer echte Zusatzkonten anlegt, siehe
  README-Abschnitt "Mehrere Konten") und keine echte Regression -- mit
  echten, per Skript angelegten Konten teilen sie sich `projects/`, `resume`
  findet die Session dort wieder.

## Erledigt (Durchgang 3)

### Datenschutz-Bug: Home-E-Mail-Fallback ignorierte gesetztes CLAUDE_CONFIG_DIR

Siehe Kurzfassung oben und Commit "Konten: Hauptkonto-E-Mail nicht mehr aus
dem echten Home lesen...". Unit-Test in `tests/konten.test.mjs`, Abschnitt
16 (`emailLesen` jetzt exportiert, drei Faelle: mit gesetztem
`CLAUDE_CONFIG_DIR` kein Fallback, ohne gesetztes greift der Fallback wie
frueher, Zusatzkonto (`istHaupt=false`) nutzt den Fallback nie). Zusaetzlich
live in der Testinstanz nachvollzogen: vor dem Fix lieferte `/api/konten`
fuer `haupt` `email:"candressler@gmail.com"` (Deine echte Adresse aus
`/home/claude/.claude.json`), obwohl die Testinstanz ihr eigenes
`CLAUDE_CONFIG_DIR=/tmp/nachtschicht/claude` hatte, dessen eigene
`.claude.json` gar keine E-Mail enthaelt. Nach dem Fix: `email:null` fuer
`haupt` in der Testinstanz, unveraendertes Verhalten auf dem echten Server
(dort ist `CLAUDE_CONFIG_DIR` ja nicht gesetzt, der Fallback bleibt aktiv).

### Alle Konten gesperrt -- end-to-end verifiziert

**Aufbau:** In der Testinstanz allen vier Fake-Konten (`haupt`, `dritt`,
`zweit`, `zweit-test`) einen `projects/`-Symlink auf
`/tmp/nachtschicht/claude/projects` gegeben (wie `konto-hinzufuegen.sh` es
fuer echte Zusatzkonten tut, siehe README) -- vorher hatten die Fake-Konten
keinen gemeinsamen `projects/`, weshalb ein Kontowechsel-Versuch immer an
"No conversation found" statt am eigentlich zu testenden Verhalten scheiterte
(siehe Durchgang-2-Notiz weiter unten). Mit dem Symlink lief `POST /api/lauf`
zweimal hintereinander durch: erster Lauf sperrte `haupt` (Anmeldefehler,
5 Stunden), zweiter Lauf wechselte sauber `dritt` -> `zweit` -> `zweit-test`
(alle mit demselben Fake-Token, alle scheitern am selben synthetischen
"Not logged in"), bis auch das letzte Konto gesperrt war.

**Ergebnis:** Kein Haenger. Der Agent-Status wird `waiting_ratelimit`, der
Lauf-Status wird sauber `failed` mit `last_error`/`stop_reason` = der letzten
Fehlermeldung (siehe `daemon.ts`, `ende.grund === 'fehler'` -> `status =
'failed'`). Das Ereignisprotokoll zeigt jeden einzelnen Wechselversuch
nachvollziehbar (`rate_limit` + `protocol`-Eintrag je Konto).

**Entscheidung fuer Can:** Es gibt danach KEINE automatische Wiederaufnahme.
Sind irgendwann wieder Konten frei (Reset nach 5h/7d, oder Can meldet ein
Konto manuell neu an), bleibt der Lauf trotzdem `failed` -- Can muss ihn von
Hand neu anstossen (`/api/lauf`, beim Orchestrator-Lauf ohne den bisherigen
Rundenverlauf). Es gibt aktuell auch keinen Mechanismus im Code, der das
anders vorsaehe (kein Scheduler/Retry-Timer fuer fehlgeschlagene Laeufe,
`grund: 'fehler'` ist ueberall ein Endzustand, genau wie Formatfehler oder
Budget-Ueberschreitung). Ich habe das bewusst NICHT automatisiert: ein Lauf,
der stundenlang blockierend auf einen Reset wartet (oder ein Timer, der ihn
Stunden spaeter von selbst neu startet), ist eine groessere Verhaltensaenderung
mit eigenen Tradeoffs (belegt der wartende Lauf Ressourcen? was, wenn Can den
Auftrag in der Zwischenzeit gar nicht mehr will? wie sichtbar ist "wartet
noch" vs. "ist tot"?) -- eher eine Produktentscheidung als ein Bugfix. Die
konservative Wahl war, das Verhalten zu pruefen und zu dokumentieren statt
etwas Neues zu bauen.

## Erledigt (Durchgang 4)

### Chat-Tab haengt, wenn waehrend eines Chats alle Konten gesperrt werden

**Commit:** "Chats: Kontowechsel bis zur Sperre aller Konten beendet den
Poll nicht mehr haengend".

**Befund, live gegen die Testinstanz reproduziert:** Test-Chat mit echter
UUID-Session-Id angelegt (`/tmp/nachtschicht/spiegel4/.../<uuid>.jsonl`,
passende `chats`-Indexzeile), dann `POST /api/chats/<id>/weiter` mit allen
vier Fake-Konten (`haupt`, `dritt`, `zweit`, `zweit-test`, alle mit
`accessToken:"attrappe"`) ausgeloest. Ereignisprotokoll zeigt den erwarteten
Ablauf -- vier Anmeldefehler nacheinander, drei `Kontowechsel`-Protokollzeilen
dazwischen, am Ende `status: waiting_ratelimit` fuer den Agenten `chat`.
Das ist serverseitig alles korrekt (siehe naechster Absatz). Der Fehler liegt
im Client: `web/tabs/chats.js`, `pollSchritt()` kannte als Endzustand nur
`['done', 'failed', 'stopped']` -- `waiting_ratelimit` fehlte. Der Poll
(alle 1,2s) laeuft dadurch fuer immer weiter, `eingabeSperren(false)` wird
nie aufgerufen (Eingabefeld bleibt gesperrt), die "arbeitet"-Anzeige
verschwindet nie, und der Fehlertext (`agent.lastError`) wird nie angezeigt.
Einziger Ausweg fuer einen Nutzer waere ein Neuladen der Seite.

**Fix:** `waiting_ratelimit` zur Endzustandsliste in `pollSchritt()`
hinzugefuegt (eine Zeile plus Kommentar). Die vorhandene
`fehlertext`-Berechnung direkt danach (`agent.status !== 'done' ? ... :
null`) griff schon vorher korrekt fuer jeden Nicht-`done`-Status, keine
weitere Anpassung noetig.

**Wie getestet:** Kein Browser/DOM-Testaufbau vorhanden (kein `jsdom` als
Dependency, `chats.js` importiert `bus.js`, das top-level auf
`location.host`/`window.__TAURI__` zugreift -- ohne echten Browser oder
jsdom-Setup laesst sich das Modul nicht mal laden). Playwright-Installation
in diesem Durchgang nicht versucht (siehe Prioritaet-2-Punkt unten, dort
noch offen). Stattdessen: das komplette Backend-Ereignisprotokoll fuer den
Testlauf gegen `/api/lauf/<laufId>` gelesen und Zeile fuer Zeile mit dem
Code in `pollSchritt()`/`ereignisVerarbeiten()` abgeglichen -- der Agent
landet nachweislich (JSON-Beleg im Testlauf) bei `status: "waiting_ratelimit"`
und NIRGENDS bei `done`/`failed`/`stopped`, also haette der alte Code den
Poll nie beendet. Zusaetzlich verifiziert: ein zweiter `/weiter`-Aufruf
direkt danach bekam `202` (kein haengendes `chatLaeuft`-Lock serverseitig --
das Problem ist rein clientseitig), und `chat_fortsetzung.aktuelle_session`
in der DB blieb unveraendert korrekt (keine Verfaelschung durch die vier
gescheiterten Versuche, da nie eine neue Session-Id vergeben wurde, bevor
der Login-Fehler kam). **Bitte von Can im echten Browser gegenpruefen.**

### Kontowechsel waehrend eines fortgesetzten Chats -- Code gelesen, kein Fehler gefunden

`agentStarten()` in `supervisor.ts` fuehrt `resumeSessionId` selbst ueber
mehrere Kontowechsel-Versuche innerhalb EINES Aufrufs nach (Zeile ~322:
`resumeSessionId = this.agenten.get(k)?.sessionId ?? resumeSessionId`).
`daemon.ts` liest die finale `sessionId` erst NACH Abschluss des gesamten
`agentStarten()`-Aufrufs aus `supervisor.agentenListe(...)`, um
`chats.ts`s `fortsetzungAktualisieren()` aufzurufen -- kein Wettlauf
zwischen Kontowechsel und Session-Buchhaltung moeglich, weil beides
sequenziell im selben Promise-Verlauf passiert. Live mit der UUID-Session
aus dem obigen Test nachvollzogen: `chat_fortsetzung.aktuelle_session` blieb
exakt bei der urspruenglichen Session-Id stehen, weil kein Konto je eine
neue Antwort lieferte (alle vier scheiterten sofort an "Not logged in",
bevor die CLI je eine neue Session-Id vergeben haette) -- das ist das
korrekte Verhalten fuer diesen Fall, keine Verwechslung oder verlorene
Zuordnung.

### Discord-Bruecke -- Code gelesen, kein Fehler gefunden (aber eine Luecke notiert)

`supervisor.on('ereignis', ...)` in `daemon.ts` reicht nur Ereignisse vom
Typ `protocol` und `error` an Discord weiter (bewusst, siehe Kommentar:
"alles andere waere Rauschen"). Die `Kontowechsel: X nicht nutzbar (...),
weiter mit Y`-Zeile aus `supervisor.ts` ist vom Typ `protocol` und kommt
damit in Discord an (im Lauf-Faden, `discord.protokoll()`). Der Fall "auch
das letzte Konto ist jetzt gesperrt" ist dagegen vom Typ `rate_limit` und
geht NICHT an Discord -- fuer einen Orchestrator-Lauf faengt das die
abschliessende `laufBeendet()`-Nachricht auf (die kommt so oder so, wenn der
Lauf endet). Fuer einen Chat-Zug (kein Orchestrator-Lauf, kein
`laufBegonnen`/`laufBeendet`-Aufruf) gibt es dagegen ueberhaupt keine
Discord-Nachricht mehr, sobald alle Konten gesperrt sind. **Einschaetzung:**
vermutlich kein Bug, sondern Discord war fuer Chats nie vorgesehen (keine
`!chat`-Befehle, nur `!lauf`/`!stop`/`!status`) -- aber falls Can Chats auch
per Handy/Discord ueberwachen will, waere das eine Luecke, die erst mit dem
heutigen Fix im Chat-Tab (siehe oben) ueberhaupt sichtbar wuerde (vorher
haengte die Oberflaeche sowieso).

### Anzeige im Server-Tab (Kontokarten) -- kurz gegengelesen, kein Fehler gefunden

`web/tabs/server.js`, `kontoKarte()`/`kontenZeichnen()`/`kontenLaden()`:
Leerliste zeigt `<div class="leer">`, ein Ladefehler laesst die zuletzt
bekannte Liste stehen statt einer Fehlerwand, nicht angemeldete Konten
zeigen eine eigene Pille und deaktivieren den Vorzug-Knopf, die
Nutzungsringe (`ring()`) vertragen `null` (noch nie gemessen) sichtbar
anders als `0`. Nur Code gelesen, nicht visuell im Browser geprueft (siehe
Prioritaet-2-Luecke).

## Erledigt (Durchgang 6)

### Speicherleck: `laufVergessen()` war nie verdrahtet

**Commit:** "Daemon: laufVergessen() nach Orchestrator- und Einzellauf
aufrufen" (siehe `git log`).

**Befund:** `src/supervisor.ts`, `laufVergessen(runId)` loescht alle
Eintraege in `this.agenten` (und `this.seq`) fuer eine `runId` -- der
Kommentar direkt daneben sagt ausdruecklich, wozu: "seq und agenten wuchsen
vorher ueber die ganze Prozesslaufzeit ... bei einem Daemon, der wochenlang
laeuft, bleibt jeder Agent jedes Laufs im Speicher". Trotzdem rief KEINE
Stelle im Code diese Funktion je auf (`grep -rn laufVergessen src/`
zeigte nur die Definition selbst). Betroffen sind zwei Stellen in
`daemon.ts`:
- `orchestratorLaufStarten()`: jeder `POST /api/orchestrator`-Aufruf legt
  eine neue `randomUUID()` als `runId` an; der Orchestrator-Agent selbst und
  jeder Worker landen darunter in `this.agenten` und blieben dort auch nach
  `orch.fahren(...)` fertig war.
- `POST /api/lauf` (einfacher Einzelagenten-Lauf ohne Orchestrator, genutzt
  von `web/tabs/lauf.js`): ebenfalls eine frische `runId` je Aufruf, derselbe
  Effekt fuer den einen `chat`-Agenten.

Zum Vergleich: Chat-Fortsetzen, Konsole (`KONSOLE_LAUF`) und Sprachgespraech
(`GESPRAECH_LAUF`) nutzen dagegen eine FESTE `runId` je Sitzung wieder --
jeder neue Aufruf ueberschreibt denselben Map-Eintrag (`agentAendern`/`set`
mit demselben Schluessel), es waechst dort nichts. Nur die beiden
"jeder Aufruf eine neue runId"-Pfade waren betroffen.

**Auswirkung in der Praxis:** Bei Cans tatsaechlicher Nutzung (Orchestrator-
Auftraege mit mehreren Workern, ueber Wochen/Monate) waechst
`this.agenten` unbegrenzt weiter -- jeder Agent jedes je gelaufenen Auftrags
bleibt fuer immer im Prozessspeicher, obwohl er nach Laufende nur noch aus
der Datenbank gelesen wird (`GET /api/lauf/<id>` liest bereits `db.agentenLesen()`,
NIE die Live-Map -- das Verhalten der Oberflaeche war also nie falsch,
nur der Speicherverbrauch stieg unbemerkt). Bei einem Daemon, der laut
README "wochenlang" durchlaufen soll, ist das genau das schleichende
Problem, vor dem der Code-Kommentar warnt.

**Fix:** `supervisor.laufVergessen(runId)` in `daemon.ts` an beiden Stellen
in ein `.finally()` gehaengt, das erst nach `db.runBeenden(...)` und nach
jeder Stelle greift, die noch lesend auf `supervisor.agentenListe(runId)`
zugreift (z.B. die `weightedTokens`-Summe fuer die Discord-Endnachricht) --
also garantiert erst, wenn der Lauf wirklich zu Ende ist und niemand mehr
die Live-Ansicht braucht. `GET /api/lauf/<id>`, `GET /api/vault/graph?run=`
und `/api/abbrechen` lesen ohnehin aus der DB bzw. betreffen nur noch
laufende Agenten -- keine dieser Stellen haette nach dem Aufraeumen anders
reagiert als bei einem Lauf, der nie gestartet wurde (leere Liste), was fuer
einen bereits beendeten Lauf ohnehin das richtige Verhalten ist.

**Wie getestet:**
- `npx tsc && npm test`: weiterhin 49/49 gruen, keine Regression.
- Live, direkt gegen `dist/supervisor.js` (Skript in `/tmp/nachtschicht/`,
  nicht committet -- passt zur Konvention dieses Repos, dass `agentStarten()`
  die echte CLI aufruft und deshalb nicht in die automatisierte `npm
  test`-Suite gehoert, siehe `tests/chats.test.mjs`, das genau deswegen
  nie `Supervisor` importiert): `Supervisor` mit dem Fake-Konto `haupt`
  (`CLAUDE_CONFIG_DIR=/tmp/nachtschicht/claude`) einen Agenten unter einer
  frischen `runId` starten lassen (schlaegt sofort mit dem erwarteten
  "Not logged in" fehl, siehe Durchgang-2-Fund). Ergebnis: vor
  `laufVergessen()` `agentenListe(runId).length === 1`, danach `=== 0` --
  genau der Beweis fuer das Leck und den Fix.
- Live gegen die volle Testinstanz (Port 8798, derselbe Aufbau wie in den
  Vorgaengern): `POST /api/lauf` UND `POST /api/orchestrator` (mit
  `maxRunden:1`) je einmal ausgeloest. Beide enden weiterhin sauber als
  `status:'failed'` in der `runs`-Tabelle (per SQLite direkt gelesen, nicht
  ueber eine eigene API-Route -- es gibt keine `GET /api/laeufe/<id>/status`,
  nur `agenten`/`ereignisse`/`freigaben` in `GET /api/lauf/<id>`), keine
  Exception im Daemon-Log, keine unbehandelte Promise-Ablehnung. Bestaetigt:
  die neue `.finally()`-Verdrahtung aendert am Aussenverhalten nichts,
  ausser dass der Speicher jetzt tatsaechlich wieder frei wird.
- Testdaemon (PID 682161) danach sauber ueber die eigene PID beendet,
  Skript und temporaere DB-Dateien aus `/tmp/nachtschicht/` wieder entfernt.

### Vault (`src/vault.ts`, `src/vaultZugriff.ts`) -- gegengelesen, kein Fehler gefunden

Kein einziger automatisierter Test existierte bisher fuer `vault.ts`
(`vaultZugriff.ts` hatte schon Tests in `chats.test.mjs`, siehe Durchgang-2/3-
Arbeit an `autoErlauben`). Gegengelesen:
- Die WIKILINK-Regex deckt `[[Ziel]]`, `[[Ziel|Text]]`, `[[Ziel#Abschnitt]]`
  und die Kombination korrekt ab (alle drei optionalen Gruppen unabhaengig
  voneinander).
- Selbstverweise (`nach === von`) werden weder als Kante noch als "lose"
  gezaehlt -- konsistent mit der Absicht, nur echte Verweise zwischen
  verschiedenen Notizen zu zeigen.
- Mehrfachverweise auf dieselbe Notiz werden ueber `JSON.stringify([von,
  nach])` in einem Set entdoppelt -- korrekt, auch wenn `von`/`nach` nie
  Zeichen enthalten, die das verfaelschen koennten (beides sind interne
  Datei-Ids ohne Nutzereingabe).
- `fs.watch(VAULT, {recursive:true}, ...)`: die Dokumentation warnt, `recursive`
  sei nur unter macOS/Windows verlaesslich -- per echtem Experiment auf
  dieser Maschine (Node 22, Linux) nachgeprueft: funktioniert (eine
  verschachtelte Dateiaenderung loeste zuverlaessig ein `rename`-Ereignis
  aus). Kein Fehler, aber falls ein spaeterer Node-Versions-Wechsel das
  je aendern sollte: der Daemon holt den Graphen ohnehin per Zeitgeber
  regelmaessig nach (siehe Kommentar in `vaultBeobachten()`), also waere
  ein Ausfall der Beobachtung nicht katastrophal, nur traeger.

### Konsole (`src/konsole.ts`) -- Fehlerbehandlung bei Timeout/maxBuffer per echtem Experiment nachgeprueft

Zwei Zweige in der `execFile`-Callback-Behandlung (`konsoleBefehl`) sahen auf
den ersten Blick nach einer moeglichen Verwechslung aus: ein durch `timeout`
abgebrochener Befehl UND ein Befehl, dessen Ausgabe `maxBuffer` (256 KiB)
sprengt, fuehren beide dazu, dass der Kindprozess per SIGKILL beendet wird --
faelschlich als "Timeout" (`grund: 'abgebrochen nach Xs'`) angezeigt zu
bekommen, waere fuer den Nutzer irreführend gewesen. Per echtem Node-
Experiment (nicht nur Codelesen) nachgeprueft, was Node in beiden Faellen
tatsaechlich liefert:
- Bei `timeout`: `error.killed === true`.
- Bei `maxBuffer`-Ueberschreitung: `error.killed === undefined` (falsy),
  `error.message === 'stdout maxBuffer length exceeded'`, `exitCode === null`.

Der Code prueft `killed` zuerst und faellt sonst auf `exitCode === null` mit
`fehler.message` zurueck -- landet bei `maxBuffer` also korrekt im zweiten
Zweig mit der zutreffenden Meldung, nicht im ersten mit der falschen. Kein
Fehler, nur durch das Experiment jetzt sicher statt vermutet.

### Fachrollen (`src/rollen.ts`), Sprachgespraech (`src/gespraech.ts`), Sprachausgabe/-eingabe (`src/hoeren.ts`, `src/stimme.ts`) -- gegengelesen, kein Fehler gefunden

- `rollen.ts`: laedt beim Start aus `rollen/*.md`, wirft beim kleinsten
  Problem (Verzeichnis fehlt, keine Vorgaberolle `coder`) einen echten
  Startfehler statt einer stillen Warnung -- bewusst so gebaut (siehe
  Kommentar: sonst wuerde ein Tippfehler im Pfad alle Worker unbemerkt von
  jeder Werkzeugbeschraenkung befreien). Kein Fehler gefunden.
- `gespraech.ts`: `sessionId` fuer die naechste Gespraechsrunde kommt aus
  `supervisor.agentenListe(GESPRAECH_LAUF).find(...)` -- das funktioniert nur
  zuverlaessig, WEIL `GESPRAECH_LAUF` (wie `KONSOLE_LAUF`) eine feste `runId`
  ist und der Agent nach Laufende (anders als beim jetzt gefixten Leck) nie
  aus der Map entfernt wird. Waere `laufVergessen()` hier je versehentlich
  aufgerufen worden, waere jedes Sprachgespraech nach der ersten Runde ohne
  Gedaechtnis gewesen -- deshalb der Fix in diesem Durchgang bewusst NUR an
  den beiden Stellen mit frischer `runId` pro Aufruf, nicht generisch nach
  jedem `agentStarten()`.
- `hoeren.ts`/`stimme.ts`: TCP-Verbindung zu Whisper/Piper, Timeout- und
  Fehlerpfade (`sock.on('error'/'close')`, `fertig`-Wache gegen
  Doppelaufloesung) wirken sorgfaeltig gebaut und sind bereits indirekt durch
  `tests/wyoming.test.mjs`/`tests/wav.test.mjs`/`tests/audio.test.mjs`
  abgedeckt (die tieferliegenden Protokoll-/Resampling-Funktionen, die diese
  beiden Module nutzen). Ein echter Whisper/Piper-Container stand in dieser
  Nachtschicht nicht zur Verfuegung, also nicht live gegen einen echten
  Dienst getestet -- nur gegengelesen, kein Fehler gefunden.

## Erledigt (Durchgang 5)

### Prioritaet 2 (Desktop-App/Oberflaeche) -- erstmals visuell geprueft, kein Bug gefunden

**Aufbau:** `playwright` als devDependency ergaenzt (`npm install --save-dev
playwright`, siehe `package.json`), `npx playwright install chromium` lief
ohne Systembibliotheken-Problem durch (anders als in der Aufgabe befuerchtet
-- diese Umgebung hat offenbar alles Noetige). Der Chromium-Download landet
in `~/.cache/ms-playwright` (ausserhalb des Repos, uebersteht vermutlich
einen Neustart des Containers/der VM, da es derselbe Server ist -- ein
spaeterer Durchgang sollte `npx playwright install chromium` trotzdem kurz
gegenpruefen, bevor er sich auf den Cache verlaesst).

Eigene Testinstanz auf Port 8799 mit den wiederverwendbaren Fake-Konten aus
`/tmp/nachtschicht/konten`, dem Chat-Spiegel aus Durchgang 4
(`/tmp/nachtschicht/spiegel4` nach `spiegel5b` kopiert, `cockpit4.db` nach
`cockpit5.db` kopiert -- enthaelt die eine Test-Sitzung "Testfrage eins").
**Wichtig:** Kopieren aus `/var/lib/cockpit/vault` wurde vom
Sandbox-Berechtigungssystem verweigert (auch ein einzelnes `cp` einer
Markdown-Datei) -- die Nachtschicht-Vorgabe erlaubt das zwar, aber
unbeaufsichtigt kam die Genehmigung nie durch. Stattdessen drei eigene,
synthetische Testnotizen mit Wikilinks in `/tmp/nachtschicht/vault5`
angelegt (siehe unten), um den Vault-Tab trotzdem mit echtem Inhalt statt
nur dem Leerzustand zu pruefen.

**Geprueft (Playwright, headless Chromium, echtes DOM/Layout, nicht nur
Code gelesen):**
- Alle sechs Tabs (Zentrale, Lauf, Chats, Vault, Konsole, Server) bei
  1280px (Desktop) und 375px (Handy), erst im Leerzustand.
- Automatische Ueberlauf-Erkennung: jedes Element, dessen rechte Kante
  ueber die Fensterbreite hinausragt (mit Ausnahme von `position:fixed`
  bewusst per `translateX(100%)` aus dem Bild geschobenen Schubladen).
  Zwei Treffer, beide als gewolltes Verhalten identifiziert, siehe unten.
- Dieselben sechs Tabs noch einmal mit echten Testdaten: Vault mit 3
  verlinkten Notizen (`/api/vault/graph` lieferte korrekt 3 Knoten, 5
  Kanten), Chatliste mit einem echten Eintrag, Chat im Fokusmodus mit
  echtem Frage/Antwort-Verlauf.
- Tab-Wechsel-Stresstest: 10 schnelle Spruenge zwischen allen Tabs
  (inklusive Ruecksprüngen auf schon besuchte Tabs), bei jedem Schritt
  geprueft, dass hoechstens EINE `.tabflaeche` sichtbar ist (`display`
  berechnet, nicht nur die Klasse) -- bei beiden Breiten, 20 Uebergaenge
  insgesamt, immer korrekt genau eine oder (im Lauf-Tab, der das
  Drei-Spalten-Grid statt einer `.tabflaeche` nutzt) keine.
- Mobile Agenten-/Freigaben-Schublade (`#aufAgenten`/`#aufFreigaben`,
  `web/app.js`): Oeffnen, zur anderen Seite wechseln (schliesst die erste
  automatisch, kein doppeltes Offenstehen), per echtem Mausklick auf den
  noch sichtbaren Reststreifen von `main` schliessen, erneutes Antippen
  desselben Knopfs schliesst wieder (Toggle). Alles wie im Code/Kommentar
  beschrieben.
- Statische Durchsicht aller ID-Selektoren mit `display` in
  `web/index.html`: die drei Tab-spezifischen Regeln (`#tab-vault.an`,
  `#tab-konsole.an`, `#tab-zentrale.an`) enthalten alle bereits `.an` in
  der ID-Regel selbst -- sie koennen also nie ohne aktives `.an` greifen
  und nie mit `.tabflaeche{display:none}` kollidieren. Keine weitere
  Stelle in `web/` mit einer blossen `#tab-x{display:...}`-Regel ohne
  `.an` gefunden.

**Zwei vermeintliche Funde, beide als gewolltes Verhalten identifiziert
(damit niemand das nochmal untersucht):**
1. `#stimmwahl` (Sprachausgabe-Auswahl) ragt auf 375px um ~10px ueber den
   sichtbaren Rand hinaus, auf JEDEM Tab. Grund: der Header hat unter
   820px bewusst `overflow-x:auto` (Kommentar in `web/index.html`, Zeile
   ~171: "die Kopfzeile hatte overflow:hidden ... jetzt scrollt sie
   waagerecht"). Das ist der bereits gebaute Fix fuer genau dieses
   Problem -- der Header ist absichtlich breiter als der Bildschirm und
   scrollt. Kein Bug.
2. `#rechts` (Freigaben-Schublade) hat im Lauf-Tab auf 375px eine
   Bounding-Box, die weit ueber den rechten Rand hinausragt (bis zu
   690px bei 375px Fensterbreite). Grund: `position:fixed;
   transform:translateX(100%)` verschiebt das Element um seine EIGENE
   Breite nach rechts aus dem sichtbaren Bereich -- das ist exakt die
   Schubladen-Technik aus dem CSS-Kommentar, `getBoundingClientRect()`
   rechnet die Transformation korrekt mit ein, das Element ist trotzdem
   unsichtbar (per Screenshot bestaetigt). Kein Bug, nur ein
   Mess-Artefakt meines ersten, noch zu simplen Ueberlauf-Checks (im
   zweiten, genaueren Skript schon herausgefiltert).
3. (Kein Bug, aber erwaehnenswert) Der 3D-Vault-Graph zeigte bei nur 3
   Notizen zunaechst nur EIN Label sichtbar, nicht drei. Grund:
   `beschriftungZeichnen()` in `web/tabs/vault.js` blendet Labels auf der
   Rueckseite der Kugel bewusst aus (`.filter(b => b.vorne > -0.15)`,
   Kommentar: "ein Name, der quer ueber der Kugel schwebt, sagt weniger
   als gar keiner"). Beim Drehen der Ansicht wuerden die anderen Labels
   erscheinen -- in einem Live-Screenshot ohne Interaktion sieht man nur
   die Momentaufnahme einer Rotation. Kein Bug, aber falls Can es selbst
   pruefen will: im Vault-Tab am Graph ziehen, dann tauchen die anderen
   Namen auf.

**Nicht geprueft / offen fuer den naechsten Durchgang:**
- `src-tauri/` selbst (kein cargo, siehe Aufgabenstellung).
- Zustaende mit AKTIVEN Agenten (laufender Graph, Freigabe-Karten mit
  echtem Werkzeugaufruf, Konsole mit einem Eintrag, Zentrale mit
  Live-Strom) -- dafuer haette ich einen echten (wenn auch mit
  Fake-Token scheiternden) Lauf anstossen muessen, was in diesem
  Durchgang aus Zeitgruenden nicht mehr passiert ist. Die Leerzustaende
  sind alle sauber (siehe oben und Durchgang-4-Notizen zum Server-Tab),
  aber ein Freigabe-Dialog mit echtem `pre`-Block voller Text (moegliches
  Ueberlauf-Ziel, siehe `.freigabe pre{max-height:120px;overflow:auto}`
  in `web/index.html`) wurde nicht visuell bestaetigt.
- Fehlerzustaende (z.B. Server nicht erreichbar, `/api/*` liefert 500)
  nur im Server-Tab codeseitig erwaehnt (Durchgang 4), nicht in den
  anderen Tabs visuell geprueft.
- Reale Bildschirmgroessen zwischen 375px und 1280px (z.B. Tablet-Breiten
  um 768-820px, genau an der Media-Query-Grenze) nicht gesondert
  geprueft -- nur die zwei in der Aufgabe genannten Eckwerte.

## Erledigt (Durchgang 8)

### Zentrale- und Vault-Tab: Agenten-Panel blieb nach (Neu-)Laden leer, obwohl ein Auftrag lief

**Commits:** "Zentrale: Agenten-Panel zeigt laufende Agenten auch ohne
Lauf-Tab-Besuch", "Vault: 3D-Agentenanzeige nutzt den vom Server schon
vorbereiteten ?run=-Parameter".

**Ausgangspunkt:** Der aus Durchgang 5 offene Punkt "Zustaende mit aktiven
Agenten noch nicht visuell geprueft". Da echte Agentenlaeufe hier nicht
gestartet werden duerfen (Kontingent) und Fake-Token-Laeufe binnen einer
Sekunde scheitern, wurde ein neuer Testweg gebraucht: ein synthetischer Lauf
(ein `run`, drei `agents` in den Zustaenden `thinking`/`tool`/
`waiting_permission`, zehn `events`, eine offene `permission`) direkt per
`CockpitDb`-Klasse in die Test-SQLite-Datei eingetragen -- KEIN echter
Agentenprozess, nur Datenbankzeilen, wie sie ein echter Lauf hinterlassen
haette. Damit lieferte die echte, laufende Test-API (`GET /api/laeufe`,
`GET /api/lauf/<id>`) genau die Antworten, die ein echter aktiver Lauf
liefern wuerde, ohne dass die Nachtschicht-Regeln zu echten Agentenlaeufen
verletzt wurden.

**Befund 1 (Zentrale):** Mit Playwright NUR die Zentrale geoeffnet (nie den
Lauf-Tab besucht, wie es beim ersten Start der App oder nach einem Reload
der Fall waere) -- das Agenten-Panel zeigte "keine aktiven", obwohl der
synthetische Lauf drei aktive Agenten hatte. Ursache: `zentrale.js` fuellt
`letzteAgenten` ausschliesslich aus zwei WebSocket-Nachrichtentypen
(`agenten`, `agent`), beide kommen nur ab dem Zeitpunkt, an dem sie
eintreffen -- es gibt (anders als beim Lauf-Tab, der `/api/laeufe` +
`/api/lauf/<id>` explizit beim Mount abfragt) keinen REST-Aufruf, der den
JETZT schon bestehenden Zustand nachholt. Ein zusaetzlicher Test mit einem
echten (an "Not logged in" scheiternden) `/api/lauf`-Aufruf zeigte: der
Live-Pfad selbst funktioniert (das Panel aktualisierte sich innerhalb von
Millisekunden nach dem echten `agent_start`-Ereignis) -- das Problem war
ausschliesslich das Fehlen einer Erstbefuellung.

**Fix 1:** `zentrale.js`, `mount()`: nach dem Einrichten der
WS-Abonnements zusaetzlich `GET /api/laeufe` abfragen, alle Laeufe mit
`status:'running'` herausfiltern, fuer jeden `GET /api/lauf/<id>` abfragen
und die Agenten per Upsert (gleiche Logik wie der bestehende `'agent'`-
Handler) in `letzteAgenten` einspeisen. Bewusst als eigener, kleiner
try/catch-Block direkt geschrieben (keine Abstraktion mit dem bestehenden
`'agenten'`-Handler geteilt) -- die paar Zeilen Mapping-Code doppelt zu
haben war das kleinere Risiko als den schon funktionierenden Live-Pfad beim
Refactoring versehentlich zu veraendern.

**Befund 2 (Vault):** Derselbe Fehlerklasse, aber mit einer Ueberraschung:
`GET /api/vault/graph` in `daemon.ts` unterstuetzt bereits einen
`?run=<id>`-Parameter, der die Agenten dieses Laufs mitliefert -- der
Code-Kommentar dort sagt sogar ausdruecklich, wozu ("Notizen und Agenten in
EINER Szene ... aus zwei Anfragen zusammenzusetzen waere nur Gelegenheit
fuer Zwischenstaende"). `web/tabs/vault.js` ruft die Route aber seit jeher
OHNE diesen Parameter auf (`fetch(api('/api/vault/graph'))`, kein `?run=`
irgendwo im Code) -- das serverseitig fertig gebaute Feature wurde nie vom
Frontend benutzt. Live bestaetigt: `curl .../api/vault/graph` ohne `run`
liefert immer `"agenten":[]`, mit `?run=<id>` die echten Zeilen.

**Fix 2:** `vault.js`, `mount()`: vor dem eigentlichen Graph-Aufruf zuerst
`GET /api/laeufe` abfragen (mit `.catch(() => null)`, falls das schon
fehlschlaegt), den ersten Lauf mit `status:'running'` suchen, und falls
gefunden dessen `run_id` als `?run=` an die Graph-Anfrage haengen. Schlaegt
auch das fehl oder gibt es keinen laufenden Auftrag, bleibt das Verhalten
exakt wie vorher (Graph ohne Agenten).

**Wie getestet:**
- `npx tsc && npm test`: weiterhin gruen (49/49), beide Aenderungen sind
  reines `web/*.js` ohne TypeScript-Beruehrung.
- Live gegen die Testinstanz (Port 8800, dann 8801): synthetischer Lauf wie
  oben beschrieben eingetragen, mit Playwright verifiziert -- vor dem Fix
  "keine aktiven" (Zentrale) bzw. "keine Agenten aktiv" (Vault), nach dem
  Fix sofort alle Agenten sichtbar, beim blossen Laden der jeweiligen Seite,
  ohne dass ein Live-Ereignis noetig war.
- Regressionstest: derselbe echte (scheiternde) `/api/lauf`-Aufruf wie oben
  nochmal nach dem Fix ausgefuehrt -- die neue Erstbefuellung und der
  bestehende Live-WS-Pfad zeigen den neuen Agenten korrekt zusaetzlich zu
  den synthetischen, keine Duplikate, keine widerspruechlichen Zustaende.
- Kompletter Sichttest (alle sechs Tabs, 1280/800/375px, Ueberlauf-Check,
  Konsolenfehler-Check) nach beiden Fixes erneut durchlaufen: keine neuen
  Layout-Probleme, keine JS-Fehler.

### Ueberlauf-Check bei 800px (Tablet-Luecke aus Durchgang 5): ein Fund, aber Mess-Artefakt des eigenen Skripts

Das eigene Ueberlauf-Pruefskript (siehe "Testinstanz-Hinweise" unten) meldete
bei 800px im Lauf-Tab zunaechst einen Treffer: `#freigaben` und seine Kinder
ragten weit ueber den rechten Rand hinaus (bis `right=1110` bei 800px
Fensterbreite). Nachgeprueft mit einer direkten `getComputedStyle`-Abfrage:
`#rechts` (die Freigaben-Schublade) ist bei dieser Breite korrekt
`position:fixed` mit `transform:translateX(320px)` -- vollstaendig ausserhalb
des sichtbaren Bereichs, wie von der `@media (max-width:820px)`-Regel in
`web/index.html` vorgesehen. Das eigene Skript pruefte aber nur, ob das
Element SELBST `position:fixed` ist (Durchgang-5-Technik), nicht ob ein
VORFAHRE es ist -- Kinder eines verschobenen `position:fixed`-Elements haben
selbst `position:static` und wurden faelschlich als ueberlaufend gemeldet,
obwohl sie (wie ihr Elternelement) unsichtbar sind. Skript korrigiert
(`inFixedSchublade()`-Helfer, laeuft die Vorfahrenkette hoch), danach kein
Treffer mehr bei 800px auf keinem der sechs Tabs. Kein Bug im Cockpit selbst,
nur im eigenen Testwerkzeug -- dokumentiert, damit ein spaeterer Durchgang
nicht denselben Fund nochmal untersucht.

### Fehlerzustaende bei Serverausfall waehrend der Nutzung -- erstmals live geprueft, kein Absturz

**Aufbau:** Test-Daemon gestartet, Seite im (headless) Browser vollstaendig
geladen, DANN der Daemon-Prozess ueber seine eigene PID beendet (verifiziert
per `ps -p <pid> -o cmd` vor dem `kill`, wie in den Testinstanz-Hinweisen
vorgeschrieben) -- simuliert einen Server, der waehrend der Nutzung wegbricht
(Netzwerkausfall, Neustart, Absturz), nicht einen von Anfang an unerreichbaren
Server. Danach alle sechs Tabs durchgeklickt und Konsole/`pageerror`-Ereignisse
mitgeschnitten.

**Ergebnis:** Keine einzige unbehandelte Exception (`pageerror`), nur
erwartete Netzwerk-Fehlermeldungen in der Browserkonsole (WebSocket-Reconnect-
Versuche, fehlgeschlagene `fetch`-Aufrufe). Der Verbindungsstatus in der
Kopfzeile wechselt korrekt auf "getrennt — neuer Versuch". Tabs mit schon
vorher geladenen Daten (Zentrale, Lauf) behalten ihren letzten bekannten
Stand sichtbar, statt einer Fehlerwand -- konsistent mit dem in Durchgang 4
dokumentierten, bewussten Verhalten des Server-Tabs. Konsole-Tab (holt beim
Mount nichts vom Server) zeigt unveraendert nur den statischen Warnhinweis,
keine Fehlermeldung noetig.

**Ein kleiner, nicht behobener Schoenheitsfehler:** Chats-, Vault- und
Server-Tab zeigen bei einem fehlgeschlagenen ERSTEN Laden (noch nie zuvor
erfolgreich geladen, dann bricht der Server weg) die rohe
`TypeError: Failed to fetch`-Meldung (`String(e)` im catch-Zweig) statt
eines deutschen Satzes wie in `lauf.js` ("Kein Daemon erreichbar auf ...").
Lesbar und nicht irrefuehrend (kein falscher "leer"-Zustand wie z.B. beim
Server-Tab-Konten-Panel, siehe naechster Absatz), aber unschoen. Nicht
behoben -- kleine, risikoarme Verbesserung fuer einen spaeteren Durchgang,
siehe "Offene Punkte".

**Randbeobachtung, NICHT behoben (bewusst, siehe Durchgang 4):** Das
Server-Tab-Konten-Panel zeigt bei einem fehlgeschlagenen ERSTEN Laden
"keine Konten gefunden" -- dieselbe Meldung wie bei tatsaechlich null
konfigurierten Konten, obwohl die Ursache hier ein Verbindungsfehler ist,
nicht fehlende Konten. Das ist eine Folge der in Durchgang 4 bereits
gepruefte und als bewusst akzeptierten Entscheidung, bei einem Ladefehler
NICHTS zu veraendern (Code-Kommentar in `server.js`: "Ohne Antwort bleibt
die letzte bekannte Liste stehen statt einer Fehlerwand") -- die
Kehrseite ist eben dieser eine Randfall (Fehler EXAKT beim allerersten
Laden, bevor je eine echte Liste stand). Nicht als neuer Fund behandelt,
nur als bisher unbeobachtete Konsequenz einer schon getroffenen,
begruendeten Entscheidung notiert.

## Offene Punkte (Prioritaet 1, noch zu pruefen)

- [ ] **Daemon-Neustart:** `gesperrtBis` und `nutzung` in
  `KontenVerwaltung` sind reiner In-Memory-Zustand (`new Map()`, kein
  Laden/Speichern). Nach einem Neustart gelten alle Konten wieder als frei
  und ungemessen (0 %), bis der naechste Poll (bis zu 10 Minuten) oder ein
  neues `rate_limit_event` etwas meldet. Folge: ein Konto, das eigentlich
  noch bis zum Reset gesperrt waere, wird sofort wieder probiert -- im
  schlimmsten Fall ein weiterer sofortiger Limit-Fehler, der sich aber dank
  des Anmeldefehler-Fixes jetzt wenigstens sauber als Wechsel und nicht als
  toter Lauf zeigt. **Einschaetzung:** wahrscheinlich hinnehmbar (Daemon
  laeuft normalerweise wochenlang durch, siehe `laufVergessen()`-Kommentar),
  aber nicht verifiziert. Persistieren waere eine kleine JSON-Datei neben
  der DB -- das ist eine Produktentscheidung (mehr bewegliche Teile fuer
  einen Randfall), noch nicht umgesetzt.
- [x] **Kontowechsel beim Chat-Fortsetzen** (`src/chats.ts`,
  `fortsetzungVorbereiten`/`fortsetzungAktualisieren`): in Durchgang 4
  durchdacht und live verifiziert -- Session-Buchhaltung ist korrekt
  (kein Wettlauf, siehe "Erledigt" oben). Dabei aber einen echten Bug im
  Chat-TAB (nicht in `chats.ts` selbst) gefunden und behoben: der Poll
  erkannte `waiting_ratelimit` nicht als Ende, siehe oben. Bitte im
  Browser gegenpruefen.
- [x] **Discord-Bruecke:** in Durchgang 4 gegengelesen (kein eigener
  Discord-Server verfuegbar, nur Code + Ereignis-Verdrahtung). Kontowechsel
  kommt an (Typ `protocol`), "alle Konten gesperrt" NICHT direkt fuer
  Chat-Zuege (Typ `rate_limit`, wird nur fuer `protocol`/`error`
  weitergereicht) -- vermutlich kein Bug, da Discord Chats gar nicht kennt.
  Siehe "Erledigt" oben fuer Details. Nicht live gegen einen echten
  Discord-Server getestet (kein Server verfuegbar, `COCKPIT_DISCORD_TOKEN`
  in der Testinstanz bewusst leer).
- [x] **Anzeige in allen Zustaenden** (Server-Tab): in Durchgang 4 der
  Server-Tab (Kontokarten) gegengelesen, kein Fehler gefunden (siehe
  "Erledigt" oben). Zentrale (`web/tabs/zentrale.js`) hatte schon vorher
  eine eigene Farbzuordnung fuer `waiting_ratelimit`. NICHT visuell im
  Browser geprueft (kein Playwright/jsdom-Aufbau in dieser Nachtschicht,
  siehe Prioritaet-2-Punkt unten) -- nur Code und berechnete Werte gelesen.
- [x] **Vorzug setzen/aufheben:** in Durchgang 3 end-to-end gegen die
  Testinstanz verifiziert -- `POST /api/konten {"name":"zweit"}` setzt den
  Vorzug (`modus` wechselt auf `manuell`, `bevorzugt:true` nur bei `zweit`),
  `{"name":null}` hebt ihn sauber wieder auf (`modus` zurueck auf
  `ausgeglichen`, kein Konto mehr `bevorzugt:true`), ein unbekannter Name
  liefert `404` mit `ok:false` OHNE den bisherigen Vorzugszustand zu
  veraendern. Kein Fehler gefunden.

## Offene Punkte (Prioritaet 2 -- Desktop-App/Oberflaeche)

- [x] **Tabs bei 1280px/375px, HUD-Stil, Leer-/Ladezustaende,
  Tab-Wechsel-Reste, ID/Klassen-Fehlerklasse:** in Durchgang 5 mit
  Playwright/Chromium visuell geprueft (Systembibliotheken waren KEIN
  Problem, Installation lief durch). Kein Bug gefunden, siehe "Erledigt"
  oben fuer Details und die zwei falsch-positiven Funde.
- [x] **Fehlerzustaende** (Server/API nicht erreichbar) und Zustaende mit
  echten AKTIVEN Agenten (Freigabe-Dialoge mit echtem Inhalt, laufender
  Graph, Konsole/Zentrale mit Live-Ereignissen): in Durchgang 8 mit
  Playwright gegen synthetische "aktive" Datenbankzeilen und einen mitten in
  der Sitzung beendeten Test-Daemon geprueft. Zwei echte Bugs gefunden und
  behoben (Zentrale- und Vault-Agentenpanel blieben nach Laden leer, siehe
  Kurzfassung oben). Fehlerzustaende: kein Absturz, aber
  `TypeError: Failed to fetch` als Rohmeldung in Chats/Vault/Server bei
  fehlgeschlagenem Erstladen -- kleiner, nicht behobener Schoenheitsfehler,
  siehe "Offene Punkte" unten.
- [x] Tablet-Breiten um die 768-820px-Media-Query-Grenze: in Durchgang 8 bei
  800px geprueft (Zentrale, Lauf, Chats, Vault, Konsole, Server, je mit dem
  synthetischen aktiven Lauf). Ein vermeintlicher Ueberlauf-Fund war ein
  Mess-Artefakt des eigenen Testskripts (siehe Kurzfassung oben), kein
  echter Bug. Nur genau 800px getestet, nicht der ganze 768-820px-Bereich.
- [ ] `src-tauri/` nicht angefasst -- kein cargo hier verfuegbar.
- [ ] **Neu, nicht behoben:** Chats-, Vault- und Server-Tab zeigen bei einem
  fehlgeschlagenen ERSTEN Laden (Server nicht erreichbar, noch nie zuvor
  erfolgreich geladen) die rohe JS-Fehlermeldung `TypeError: Failed to
  fetch` statt eines deutschen Satzes wie in `lauf.js`
  ("Kein Daemon erreichbar auf ..."). Nicht irrefuehrend, nur unschoen --
  ein spaeterer Durchgang koennte `String(e)` durch eine freundlichere
  Meldung ersetzen, an allen drei Stellen (`web/tabs/chats.js`,
  `web/tabs/vault.js`, `web/tabs/server.js`, jeweils im catch-Zweig des
  initialen Ladens).

## Offene Punkte (Prioritaet 3 -- Rest des Cockpits)

- [x] **Daemon-Robustheit -- Speicherleck:** in Durchgang 6 gefunden und
  behoben (`laufVergessen()` war nie verdrahtet, siehe "Erledigt" oben).
  Live verifiziert, kein automatisierter Test (passt nicht zur Konvention
  dieses Repos, echte SDK-Aufrufe aus `npm test` herauszuhalten).
- [ ] **Kleines, verbleibendes Wachstum bei Chat-Sitzungen:** jede neu
  ERSTELLTE Chat-Sitzung (`chat-<sessionId>` als Pseudo-`runId` in
  `chats.ts`) bekommt einen dauerhaften Eintrag in `supervisor.agenten`, der
  nie entfernt wird (weiteres Fortschreiben derselben Sitzung ueberschreibt
  ihn nur, entfernt ihn nicht). Viel kleiner als das behobene Leck (ein
  Eintrag pro Chat, nicht pro Lauf/Worker), aber ueber Monate mit vielen
  Chats trotzdem ein langsames Wachstum. Nicht angefasst: unklar, ob Can
  das je stoert, und ein Fix braeuchte eine Entscheidung, WANN eine
  Chat-Sitzung als "verworfen" gilt (nie geloescht in der DB, jederzeit
  wieder fortsetzbar) -- eher eine Produktentscheidung als ein klarer Bug.
- [x] Vault (`src/vault.ts`, `src/vaultZugriff.ts`), Konsole
  (`src/konsole.ts`), Sprachausgabe/-eingabe (`src/hoeren.ts`,
  `src/stimme.ts`), Fachrollen (`src/rollen.ts`), Sprachgespraech
  (`src/gespraech.ts`): in Durchgang 6 erstmals gegengelesen (vorher noch
  nie angeschaut), kein weiterer Fehler gefunden. Details siehe "Erledigt
  (Durchgang 6)" oben.
- [x] **Orchestrator/Laeufe (`src/orchestrator.ts`):** in Durchgang 7
  erstmals gruendlich gegengelesen -- zwei echte Robustheitsluecken
  gefunden und behoben (Leseanfrage-Limit fuehrte zu falscher
  Fehlermeldung; Leseanfrage ohne Groessendeckel konnte den Daemon
  einfrieren). Details siehe "Durchgang 7" in der Kurzfassung oben. Die
  Hilfsfunktionen zum Format der Orchestrator-Antwort selbst
  (`src/protokoll.ts`: `orchestratorAntwortLesen`, `auftraegeTrennen`,
  `istWiederholung`, `blockerGrund`, `reportTypLesen`) waren schon vorher
  gut getestet (`tests/protokoll.test.mjs`) und wurden nur gegengelesen,
  nicht veraendert.

## Testinstanz-Hinweise fuer den naechsten Durchgang

- Fake-Konten liegen bereits unter `/tmp/nachtschicht/konten/{zweit,dritt,
  zweit-test}`. Seit Durchgang 3 haben ALLE DREI einen `projects/`-Symlink
  auf `/tmp/nachtschicht/claude/projects` (das Hauptkonto der Testinstanz,
  Attrappe wie in `konto-hinzufuegen.sh` fuer echte Zusatzkonten
  beschrieben) -- damit teilen sie sich Sessions mit `haupt`, und ein
  `resume` nach einem Kontowechsel scheitert nicht mehr an "No conversation
  found". Wiederverwendbar, nichts weiter noetig.
- Achtung bei wiederholten Testlaeufen in derselben Instanz: `sperren()` ist
  In-Memory und ueberlebt keinen Neustart, ABER die 5-Stunden-Sperre aus
  einem fruehen Testlauf gilt fuer den Rest desselben Prozesses weiter --
  wer gezielt EIN bestimmtes Konto als "frei" testen will, startet am besten
  eine frische Instanz statt sich auf den Zustand vom letzten Testlauf zu
  verlassen (ist mir in Durchgang 3 selbst passiert: `haupt` war im zweiten
  Testlauf noch vom ersten gesperrt, war aber genau das, was den
  "alle Konten gesperrt am Ende"-Fall dann sauber zeigte).
- Vor dem Beenden immer pruefen, ob genau die eigene Test-Daemon-PID
  getroffen wird -- `pgrep -af 'dist/daemon.js'` matcht auch die eigene
  `claude -p`-Prozesszeile (der komplette Nachtschicht-Prompt steht in deren
  Kommandozeile und enthaelt zufaellig denselben Text). Immer mit
  `ps -p <pid> -o cmd` gegenpruefen, dass es wirklich `node dist/daemon.js`
  ohne Praefix ist, bevor `kill` laeuft.
- Durchgang 4 hat `/tmp/nachtschicht/spiegel4/` (eigener Spiegel-Ordner mit
  EINEM Test-Chat, Datei `-tmp-nachtschicht-work/<uuid>.jsonl`) und
  `/tmp/nachtschicht/cockpit4.db*` angelegt, um `COCKPIT_SESSIONS` nicht mit
  dem (leeren) `/tmp/nachtschicht/spiegel/` aus den Vorgaengern zu
  vermischen. Wichtig fuer eigene Chat-Tests: die CLI validiert `--resume`
  strikt als UUID -- ein selbstgebauter Session-Dateiname wie
  `sess-test-0001.jsonl` scheitert SOFORT mit einem CLI-Nutzungsfehler
  ("...is not a UUID..."), BEVOR ueberhaupt ein Konto/Login gepruefte wird,
  und taeuscht damit einen ganz anderen Fehlerpfad vor als eine echte
  Sitzung. Fuer Chat+Konten-Tests immer eine echte UUID als Dateiname/
  Session-Id verwenden (z.B. `python3 -c "import uuid; print(uuid.uuid4())"`).
  Test-Daemon aus Durchgang 4 (PID 677265) wurde sauber ueber die eigene PID
  beendet.
- Durchgang 5: `playwright` ist jetzt als devDependency in `package.json`
  eingetragen (`npm install` reicht danach). Die Chromium-Binary selbst
  liegt in `~/.cache/ms-playwright` ausserhalb des Repos -- vor der
  Nutzung kurz `npx playwright install chromium` laufen lassen (dauert nur
  Sekunden, wenn schon gecacht, sonst laedt es ~300MB nach). Fuer eigene
  Oberflaechen-Tests: Testdaemon starten, dann ein kleines `.mjs`-Skript
  mit `import { chromium } from 'playwright'`, `chromium.launch()`,
  `page.goto('http://localhost:<port>/#/<tab>')` -- das Skript muss
  IM Repo liegen (z.B. unter `nachtschicht-bilder/`, komplett gitignored),
  sonst findet Node das `node_modules/playwright` nicht per relativem
  Import. Kopieren aus `/var/lib/cockpit/vault` wurde vom
  Berechtigungssystem verweigert (auch einzelne, nicht-rekursive
  `cp`-Befehle) -- fuer Vault-Tests mit echtem Inhalt eigene synthetische
  Markdown-Dateien mit `[[Wikilinks]]` direkt in
  `/tmp/nachtschicht/vault<n>/` anlegen, das reicht dem Indexer.
  Test-Daemons aus Durchgang 5 (PIDs 679012, 679478, 680325) wurden alle
  sauber ueber die eigene PID beendet, jeweils vorher mit
  `ps -p <pid> -o cmd` gegengeprueft.
- Durchgang 8: **Wichtig fuer eigene Prozesssuche** -- `pgrep -af 'node
  dist/daemon.js'` traf diesmal (anders als der in Durchgang 2 dokumentierte
  Treffer mit dem eigenen `claude -p`-Prompt) auch auf die Bash-Wrapper-
  Prozesszeile, die den Startbefehl im `eval '...'`-Argument enthaelt --
  IMMER `ps -p <pid> -o cmd --no-headers` gegenpruefen und nur `kill`, wenn
  die Ausgabe EXAKT `node dist/daemon.js` ist, nicht nur "enthaelt den
  Text". `pgrep` selbst reicht als Filter nicht.
- Durchgang 8: `nachtschicht-bilder/sichttest8.mjs` (alle sechs Tabs,
  1280/800/375px, Ueberlauf-Check inkl. `inFixedSchublade()`-Korrektur fuer
  Kinder verschobener `position:fixed`-Elemente, Konsolenfehler-Check),
  `zentrale_bug.mjs`/`zentrale_live.mjs`/`vault_bug.mjs` (Vorher/Nachher-
  Tests fuer die beiden Agenten-Panel-Fixes) und `fehlerzustand.mjs`
  (Server-Ausfall-waehrend-Nutzung-Test, nimmt die Test-PID als Argument)
  liegen alle unter `nachtschicht-bilder/` (gitignored) und sind
  wiederverwendbar. Fuer synthetische "aktive" Laufdaten (ohne echten
  Agentenprozess): `CockpitDb` aus `dist/db.js` direkt importieren,
  `runAnlegen`/`agentSpeichern`/`ereignisSpeichern`/`freigabeAnlegen`
  aufrufen -- siehe die eingebetteten Beispiele in den obigen Skripten
  (die Insert-Skripte selbst wurden nach Gebrauch geloescht, da rein
  einmalig; das Muster steht in "Erledigt (Durchgang 8)" oben). `cockpit8.db`
  unter `/tmp/nachtschicht/` sowie `spiegel8/`, `vault8/` (Kopien von
  `spiegel4`/`vault5`) sind wiederverwendbar liegen geblieben.
