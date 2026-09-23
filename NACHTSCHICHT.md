# Nachtschicht-Logbuch

## Fuer Can (Kurzfassung)

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

- [ ] Noch nicht begonnen. `npx playwright install chromium` noch nicht
  versucht -- unklar, ob Systembibliotheken fehlen. Falls nicht: Tabs bei
  1280px und 375px pruefen, HUD-Stil, Leer-/Lade-/Fehlerzustaende,
  Tab-Wechsel-Reste, insbesondere die ID/Klassen-Fehlerklasse
  (`#tab-x{display:flex}` vs. `.tabflaeche{display:none}`), die laut
  Aufgabe "inzwischen abgesichert" ist (Commit `d56b87c`) -- gegenpruefen,
  ob es aehnliche Stellen anderswo in `web/` gibt.
- [ ] `src-tauri/` nicht angefasst -- kein cargo hier verfuegbar.

## Offene Punkte (Prioritaet 3 -- Rest des Cockpits)

- [ ] Vault, Konsole, Orchestrator/Laeufe, Sprachausgabe/-eingabe: noch
  nicht angeschaut in dieser Nachtschicht (weder Durchgang 1 noch 2, soweit
  rekonstruierbar).

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
