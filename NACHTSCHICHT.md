# Nachtschicht-Logbuch

## Fuer Can (Kurzfassung)

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
- [ ] **Kontowechsel beim Chat-Fortsetzen** (`src/chats.ts`,
  `fortsetzungVorbereiten`/`fortsetzungAktualisieren`): noch nicht
  durchdacht, ob ein Kontowechsel WAEHREND eines fortgesetzten Chats
  (`resume` von aussen, siehe `versuchPrompt()`-Kommentar zum
  "servertwo-Fund") sauber mit `chats.ts`s eigenem Session-Tracking
  zusammenspielt.
- [ ] **Discord-Bruecke:** noch nicht angeschaut, ob/wie ein Kontowechsel
  dort sichtbar wird.
- [ ] **Anzeige in allen Zustaenden** (Server-Tab, Zentrale): noch nicht
  gegen echtes HTML/CSS geprueft (gehoert eigentlich zu Prioritaet 2, aber
  inhaltlich an Prioritaet 1 gekoppelt).
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
