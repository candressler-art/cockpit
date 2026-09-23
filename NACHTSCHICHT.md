# Nachtschicht-Logbuch

## Fuer Can (Kurzfassung)

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

## Offene Punkte (Prioritaet 1, noch zu pruefen)

- [ ] **Alle Konten gesperrt:** `kontoWaehlen()` gibt dann `null` zurueck,
  der Agent bleibt (laut Code-Lesen) im alten Wartezustand
  `waiting_ratelimit` haengen, OHNE automatischen Wechsel. Noch nicht
  end-to-end mit allen Fake-Konten gleichzeitig gesperrt durchgetestet --
  nur die Unit-Tests in `konten.test.mjs` (Abschnitt 3) decken die reine
  Auswahlfunktion ab. Insbesondere: Weckt danach je ein Poll (10 Minuten)
  oder ein manueller Wiederholungsversuch den Agenten wieder auf, oder bleibt
  er fuer immer haengen, bis Can eingreift?
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
- [ ] **Vorzug setzen/aufheben:** `POST /api/konten` mit `name` und mit
  `null` bisher nur per curl gegen die Testinstanz angetestet (Vorzug setzen
  hat funktioniert, siehe oben). Aufheben (`null`) noch nicht verifiziert,
  ebenso wenig die Fehlerantwort bei einem unbekannten Kontonamen.

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

- Fake-Konten liegen bereits unter `/tmp/nachtschicht/konten/{zweit,dritt}`
  und `zweit-test` (letzteres von Durchgang 1 uebrig, Inhalt nicht
  verifiziert aber vermutlich derselbe Attrappen-Aufbau). Wiederverwendbar.
- **Fuer einen Test, der einen ECHTEN Kontowechsel-Erfolg zeigt** (nicht nur
  "Wechsel wird versucht"): den Fake-Konten fehlt der `projects/`-Symlink
  aufs Hauptkonto, den `deploy/konto-hinzufuegen.sh` fuer echte Zusatzkonten
  anlegt (siehe README). Ohne den scheitert jeder Kontowechsel-Versuch mit
  `resume` an "No conversation found", auch wenn das Zielkonto an sich
  laeuft. Um einen VOLLSTAENDIGEN Erfolgsfall zu simulieren, muesste man das
  nachbauen -- fuer den hier behobenen Bug war es nicht noetig (der Fehler
  lag VOR dem ersten Versuch, ueberhaupt zu wechseln).
- Vor dem Beenden immer pruefen, ob genau die eigene Test-Daemon-PID
  getroffen wird -- `pgrep -af 'dist/daemon.js'` matcht auch die eigene
  `claude -p`-Prozesszeile (der komplette Nachtschicht-Prompt steht in deren
  Kommandozeile und enthaelt zufaellig denselben Text). Immer mit
  `ps -p <pid> -o cmd` gegenpruefen, dass es wirklich `node dist/daemon.js`
  ohne Praefix ist, bevor `kill` laeuft.
