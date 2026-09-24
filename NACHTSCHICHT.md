# Nachtschicht-Logbuch

Fuer die vollstaendige Historie jedes fruehen Fundes (Reproduktionsschritte,
genaue Codestellen, Testbelege): `git log -p -- NACHTSCHICHT.md` zeigt jede
fruehere Fassung dieser Datei (bis Durchgang 12, vor dem Kuerzen hier).

## Fuer Can (Kurzfassung)

- Nacht 1 (21 Commits bis "Logbuch nach Durchgang 12") ist live ausgerollt.
  Danach hast Du drei konkrete Beobachtungen aus dem echten Betrieb notiert
  (Token-Ablauf, 429 bei `zweit`, falsche Kontoempfehlung nach Neustart) --
  das war Prioritaet 1 fuer die naechsten Durchgaenge.
- **Durchgang 13:** Logbuch gekuerzt; Messwert-Persistenz ueber einen
  Neustart hinweg gebaut (`aebf9e8`).
- **Durchgang 14:** die drei verbliebenen Punkte aus Cans Beobachtung
  abgeschlossen -- 429-Backoff beim Nutzungspoll und Reset-Zeit aus dem
  CLI-Fehlertext lesen (`3cd4a73`), dazu ein Regressionstest fuer die
  UI-Unterscheidung "keine Messung" vs. "0%" (die war inhaltlich schon seit
  Durchgang 1 korrekt, `98435ae`, hatte nur keinen Test, jetzt `2685036`).
  Damit ist Cans Beobachtungsliste abgearbeitet. Naechster Schwerpunkt:
  Punkt 1 unten (weitere Multi-Konto-Luecken selbst suchen).

## Offene Punkte (naechste Durchgaenge, Prioritaet 1 zuerst)

1. **Weitere Multi-Konto-Luecken** selbst suchen (z.B. Konto wird waehrend
   eines langen Laufs abgemeldet). **Noch nicht begonnen.**
2. **Chat-Sitzungen wachsen minimal im Supervisor-Speicher:** ein Eintrag
   pro NEU ERSTELLTER Sitzung bleibt fuer immer in `supervisor.agenten`
   (viel kleiner als das in Durchgang 6 behobene Leck, da Fortschreiben nur
   ueberschreibt statt anzuhaeufen). Braucht eine Produktentscheidung, wann
   eine Sitzung als "verworfen" gilt -- nicht angefasst.
3. **`src-tauri/`** nie angefasst (kein `cargo` in dieser Umgebung) -- auf
   dem PC bauen und pruefen.
4. Prioritaet 2/3 laut Aufgabenstellung: Oberflaeche weiter feinschleifen
   (Konsistenz, Handy, Tastatur, Ladezustaende), mehr End-to-End-Szenarien,
   Daemon-Robustheit bei Last/Fehlern -- bisher nur das oben Gelistete tief
   geprueft, nicht erschoepfend.

## Entscheidungen fuer Can (noch offen, keine Selbstentscheidung getroffen)

- **Anmeldefehler-Sperre:** aktuell 5 Stunden (`KONTO_SPERRE_VORGABE_MS`),
  gleich wie ein echtes Nutzungslimit. Evtl. zu lang, wenn Du ein Konto
  sofort per `/login` neu anmeldest -- es gibt aktuell KEINEN Weg, eine
  Sperre manuell aufzuheben. Optionen: kuerzeres Backoff nur fuer
  Anmeldefehler, oder ein "Sperre aufheben"-Endpunkt/Knopf.
- **Keine automatische Wiederaufnahme**, wenn alle Konten gesperrt waren und
  spaeter wieder frei werden -- ein `failed`-Lauf bleibt `failed`, Du musst
  ihn von Hand neu anstossen. Bewusst nicht automatisiert (Tradeoffs:
  Ressourcenbindung durch wartende Laeufe, Sichtbarkeit "wartet" vs. "tot").

## Erledigt (chronologisch, mit Commit)

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
