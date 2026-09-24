# Nachtschicht-Logbuch

Fuer die vollstaendige Historie jedes fruehen Fundes (Reproduktionsschritte,
genaue Codestellen, Testbelege): `git log -p -- NACHTSCHICHT.md` zeigt jede
fruehere Fassung dieser Datei (bis Durchgang 12, vor dem Kuerzen hier).

## Fuer Can (Kurzfassung)

- Nacht 1 (bis "Logbuch nach Durchgang 12") ist live. **D13-D16** haben
  Deine Beobachtungsliste abgearbeitet: Messwerte ueberleben Neustart
  (`aebf9e8`), 429-Backoff + Reset-Zeit aus CLI-Text (`3cd4a73`), Anmelde-
  sperre faellt nach `/login` beim naechsten Poll (`7f5c455`, DB-Schema v2),
  Modus "manuell" nur bei wirksamem Vorzug (`7b891d2`), neutraler
  Fortsetzungsprompt (`9e4ae1b`). **Bitte pruefen:** Server-Tab zeigt
  "Anmeldefehler · gesperrt bis ...".
- **Durchgang 17:** Die Oberflaeche hatte **keinen Abbrechen-Knopf** (nur
  Discord `!stop`). Jetzt "Stoppen" im Lauf-Tab (nur sichtbar, solange ein
  Agent arbeitet; zweiter Klick bestaetigt), `/api/abbrechen` meldet bei
  Einzellaeufen nicht mehr faelschlich 404 (`886ad89`). Dabei gefunden: ein
  gestoppter Agent landete als `failed` ("Operation aborted") statt
  `stopped`, und haette nach Kontofehler sogar das naechste Konto probiert
  (`f3b5f04`). **Bitte pruefen:** Knopf in der Desktop-App (Kopfzeile rechts,
  am Handy ganz links).
- **Durchgang 18:** Chats-Tab hat jetzt ebenfalls "Stoppen" fuer einen
  laufenden Zug (ersetzt waehrenddessen "Senden", `da2ac07`). Kaputte
  URL-Kodierung liefert 400, Verzeichnispfade 404 statt 500; API-Fehler
  kommen als JSON (`f5407cc`). **Bitte pruefen:** Stopp im Chat in der App.
- **Durchgang 19:** Restpunkt aus D18 bestaetigt und behoben: nach
  "Stoppen" sofort wieder senden gab 409, solange der alte Zug auslief.
  Jetzt wartet der Server kurz (max. 10 s) darauf; zwei gleichzeitige
  Sendungen kommen nicht mehr beide durch (`59a3eca`). **Bitte pruefen:**
  Chat stoppen und direkt neu senden (mit echtem Agent nicht testbar hier).
- **Durchgang 20:** Vertipptes Arbeitsverzeichnis in der Zentrale ergab
  einen Lauf, der mit "native binary ... failed to launch" (libc!)
  scheiterte. Jetzt sofort "Start abgelehnt: /x gibt es auf diesem Host
  nicht"; unsinnige Zahlen (Runden "abc" -> Lauf endete sofort ohne Arbeit)
  ebenfalls 400 (`c0d49e3`).

## Offene Punkte (naechste Durchgaenge, Prioritaet 1 zuerst)

1. **Weitere Multi-Konto-Luecken** selbst suchen. Erledigt: Abmeldung
   mitten im Lauf (D15), Vorzug auf geloeschtes Konto und Wortlaut des
   Fortsetzungsprompts (D16). Keine konkrete Idee mehr offen -- naechster
   Durchgang kann zu Prioritaet 2/3 (Punkt 4) wechseln.
2. **Chat-Sitzungen wachsen minimal im Supervisor-Speicher:** ein Eintrag
   pro NEU ERSTELLTER Sitzung bleibt fuer immer in `supervisor.agenten`
   (viel kleiner als das in Durchgang 6 behobene Leck, da Fortschreiben nur
   ueberschreibt statt anzuhaeufen). Braucht eine Produktentscheidung, wann
   eine Sitzung als "verworfen" gilt -- nicht angefasst.
3. **`src-tauri/`** nie angefasst (kein `cargo` in dieser Umgebung) -- auf
   dem PC bauen und pruefen.
4. Chat-Stopp/Neu-Senden (D18/D19) nur mit Unit-Test und Attrappen-Konten
   geprueft (Attrappe endet sofort mit "Not logged in", kein echter
   laufender Agent zum Stoppen) -- in der App gegenpruefen.
5. Prioritaet 2/3 laut Aufgabenstellung: Oberflaeche weiter feinschleifen
   (Konsistenz, Handy, Tastatur, Ladezustaende), mehr End-to-End-Szenarien,
   Daemon-Robustheit bei Last/Fehlern -- bisher nur das oben Gelistete tief
   geprueft, nicht erschoepfend.

## Entscheidungen fuer Can (noch offen, keine Selbstentscheidung getroffen)

- **Obergrenzen fuer Runden/Parallelitaet:** die Zentrale-Felder sagen
  max 40/4, der Server prueft seit D20 nur Untergrenze und Zahlformat
  (kein Deckel, damit API-Aufrufe mit mehr nicht brechen). Deckeln?

- **Anmeldefehler-Sperre:** seit D15 faellt sie nach erneutem `/login`
  automatisch (naechster erfolgreicher Poll, konservativ: nur Anmelde-,
  nie Limitsperren). Einen manuellen "Sperre aufheben"-Knopf gibt es
  weiterhin nicht -- willst Du einen?
- **Keine automatische Wiederaufnahme**, wenn alle Konten gesperrt waren und
  spaeter wieder frei werden -- ein `failed`-Lauf bleibt `failed`, Du musst
  ihn von Hand neu anstossen. Bewusst nicht automatisiert (Tradeoffs:
  Ressourcenbindung durch wartende Laeufe, Sichtbarkeit "wartet" vs. "tot").

## Erledigt (chronologisch, mit Commit)

- `c0d49e3` Daemon: cwd/Zahlen bei /api/lauf, /api/orchestrator vorab
  pruefen (`src/eingaben.ts`, `tests/eingaben.test.mjs`; Testinstanz: 400er
  fuer fehlendes/Datei-cwd und NaN, gueltiger Lauf wie gehabt 202).
- `59a3eca` Chats: nach Stopp sofort senden ohne 409 (`src/chatZuege.ts`,
  `tests/chatZuege.test.mjs`; Testinstanz: 3 parallele POSTs -> 202/409/409).
- `da2ac07` Chats-Tab: Stopp-Knopf fuer laufenden Zug (Skript
  `nachtschicht-bilder/chatstopp18.mjs`, 1280/375 per Playwright).
- `f5407cc` Daemon: URIError -> 400, EISDIR/ENOTDIR -> 404, /api-Fehler als
  JSON (`src/httpFehler.ts`, `tests/httpFehler.test.mjs`).

- `886ad89` Lauf-Tab: Stopp-Knopf (1280/375 per Playwright geprueft,
  Skript `nachtschicht-bilder/stopp_ui.mjs`); /api/abbrechen ok+gestoppt
  auch ohne Orchestrator; Einzellauf endet als 'stopped'.
- `f3b5f04` Supervisor: 'stopped' haelt gegen spaete Nachrichten, kein
  Kontowechsel nach Abbruch (`tests/abbruch.test.mjs`).
- `9e4ae1b` Konten: Fortsetzungsprompt neutral ("Kontowechsel").
- `7b891d2` Konten: `modus` in /api/konten nur 'manuell', wenn der Vorzug
  wirken kann (Konto vorhanden + angemeldet); gespeicherter Wert bleibt.
- `7f5c455` Konten: Anmeldesperre faellt nach erfolgreichem Nutzungs-Poll
  weg (Sperrgrund limit/anmeldung, DB-Migration v2 am alten Testbestand
  live geprueft, Karte bei 375/1280px per Playwright geprueft).
- `2685036` Server-Tab: Regressionstest fuer "keine Messung" vs. "0%" (war
  inhaltlich schon korrekt seit `98435ae`, jetzt mit Test in
  `tests/server.test.mjs` -- kontoKarte()/nutzungHerkunft()/pz() dafuer aus
  `web/tabs/server.js` benannt exportiert).
- `3cd4a73` Konten: 429-Backoff beim Nutzungspoll (naechsteBackoffMs(),
  verdoppelt sich je Folge-429, gedeckelt bei 2h), Reset-Zeit aus dem
  CLI-Fehlertext lesen, wenn Wochenlimit-Format mit Datum+Zeitzone vorliegt
  (resetzeitAusFehlertext(), ueber Intl, kein Zeitzonen-Tabellen-Paket noetig).
- `aebf9e8` Konten: Nutzungsstand ueberlebt jetzt einen Daemon-Neustart (neue
  Tabelle `konten_nutzung`, `nutzungBeimLadenFiltern()` verwirft dabei
  Fenster mit laengst vergangenem Reset-Zeitpunkt). Live gegen die
  Testinstanz geprueft: nach Neustart mit vorher persistierter 100%-Messung
  fuer `haupt` empfiehlt `/api/konten` korrekt `dritt`, nicht mehr `haupt`.
- `e340d9a` Chats: Nutzungslimit-Meldung nicht mehr als falsche Antwort angezeigt
- `d56b87c` Tabs: inaktive Flaechen verdecken aktiven Tab nicht mehr
- `98435ae` Konten-Balancing: Nutzung je Konto messen, niedrigstes Wochenkonto zuerst
- `b8f3dc7` Sprachausgabe: in Desktop-App ohne Klick hoerbar, Fehler nicht mehr stumm
- `dd0525c` Kontowechsel: auch bei kaputtem Token wechseln, nicht nur bei Nutzungslimit
- `defba1c` Konten: Hauptkonto-E-Mail nicht mehr aus echtem Home gelesen, wenn CLAUDE_CONFIG_DIR gesetzt
- `0126820` Chats: Kontowechsel bis Sperre aller Konten beendet Poll nicht mehr haengend
- `88c7947` Oberflaeche: Playwright als devDependency (visuelle Tab-Tests 1280/375px, kein Bug gefunden)
- `9cc5557` Daemon: laufVergessen() nach Orchestrator- und Einzellauf aufrufen (Speicherleck behoben)
- `e473f82` Orchestrator: ausgeschoepftes Leseanfrage-Limit endet klar statt irrefuehrend
- `48b5a62` Orchestrator: Leseanfrage (DATEI/GREP) lehnt zu grosse Dateien ab
- `e7f3994` Zentrale: Agenten-Panel zeigt laufende Agenten auch ohne Lauf-Tab-Besuch
- `3cecb58` Vault: 3D-Agentenanzeige nutzt vom Server vorbereiteten ?run=-Parameter
- `7236ca4` Konten: Sperren und Vorzug ueberleben jetzt einen Daemon-Neustart (SQLite-Persistenz)
- `b4fd253` Oberflaeche: deutsche Meldung statt roher TypeError bei nicht erreichbarem Daemon
- `50db464` Discord: !stop erkennt normalen Chat nicht mehr faelschlich als Befehl
- Durchgang 12: kein neuer Fund; verbliebener Restpunkt (deutsche Fehlermeldung)
  erstmals visuell im Browser bestaetigt, kein Bug.

## Gepruefte Bereiche ohne Fund (nicht doppelt untersuchen)

- **Konten:** Vorzug setzen/aufheben, alle Konten gesperrt (end-to-end),
  Kontowechsel waehrend Chat-Fortsetzen, Discord-Ereignisweiterleitung,
  Server-Tab-Kontokarten.
- **Oberflaeche:** alle 6 Tabs bei 1280/800/375px (Playwright), Tab-Wechsel-
  Stresstest, mobile Schublade, Fehlerzustaende bei Serverausfall waehrend
  Nutzung, Zustaende mit aktiven Agenten (nach den beiden Panel-Fixes oben).
- **Rest:** Vault (`vault.ts`/`vaultZugriff.ts`), Konsole (Timeout/maxBuffer
  per echtem Node-Experiment gepruefte), Fachrollen, Sprachgespraech,
  Sprachausgabe/-eingabe (nur Logik -- kein echter Whisper/Piper-Server
  verfuegbar zum Live-Test).

## Testinstanz-Hinweise (siehe Git-Historie fuer volle Details)

```
mkdir -p /tmp/nachtschicht/{spiegel,claude,konten,vault}
COCKPIT_PORT=8798 COCKPIT_DB=/tmp/nachtschicht/cockpit.db \
COCKPIT_SESSIONS=/tmp/nachtschicht/spiegel CLAUDE_CONFIG_DIR=/tmp/nachtschicht/claude \
COCKPIT_KONTEN_DIR=/tmp/nachtschicht/konten COCKPIT_VAULT=/tmp/nachtschicht/vault \
COCKPIT_DISCORD_TOKEN= BESZEL_URL= node dist/daemon.js
```

- Fake-Konten liegen bereits unter `/tmp/nachtschicht/konten/{zweit,dritt,
  zweit-test}`, alle mit `projects/`-Symlink auf
  `/tmp/nachtschicht/claude/projects` -- Sessions teilen sich mit `haupt`,
  `resume` nach Kontowechsel funktioniert.
- **PID-Check vor `kill` immer** mit `ps -p <pid> -o cmd --no-headers`
  gegenpruefen -- `pgrep -af 'dist/daemon.js'` matcht auch den eigenen
  Claude-Prompt/Bash-Wrapper, nicht nur den echten Node-Prozess.
- Chat-Tests brauchen eine echte UUID als Session-Id/Dateiname (CLI
  validiert `--resume` strikt, sonst falscher Fehlerpfad).
- `playwright` ist bereits als devDependency in `package.json` eingetragen;
  vor Nutzung kurz `npx playwright install chromium` laufen lassen (Cache
  unter `~/.cache/ms-playwright`, ausserhalb des Repos).
- Kopieren aus `/var/lib/cockpit/vault` wird vom Sandbox-Berechtigungs-
  system oft verweigert -- eigene synthetische Notizen mit `[[Wikilinks]]`
  in `/tmp/nachtschicht/vault<n>/` anlegen reicht dem Indexer.
  `.credentials.json` NIE kopieren oder lesen.
- Fuer synthetische "aktive" Laufdaten ohne echten Agentenprozess:
  `CockpitDb` aus `dist/db.js` direkt importieren (`runAnlegen`/
  `agentSpeichern`/`ereignisSpeichern`/`freigabeAnlegen`).

## Bestandsaufnahme (weiterhin gueltig)

Prioritaet 1 (Konten, `src/konten.ts`/`src/supervisor.ts`) ist sorgfaeltig
gebaut (Sperre vor Vorzug vor Balancing, Hysterese, eigener Nutzungs-Poll,
gut dokumentiert und getestet). Gefundene Bugs waren bisher meist Randfaelle
(fehlende Fehlerklasse, fehlende Erstbefuellung), keine grundlegenden
Konstruktionsfehler.
