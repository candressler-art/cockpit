# Nachtschicht-Logbuch

Fuer die vollstaendige Historie jedes fruehen Fundes (Reproduktionsschritte,
genaue Codestellen, Testbelege): `git log -p -- NACHTSCHICHT.md` zeigt jede
fruehere Fassung dieser Datei (bis Durchgang 12, vor dem Kuerzen hier).

## Fuer Can (Kurzfassung)

Nacht 1 (bis "Logbuch nach Durchgang 12") ist live. Seitdem, **bitte pruefen**:
- **D13-D16 Konten:** Messwerte ueberleben Neustart, 429-Backoff, Reset-Zeit
  aus CLI-Text, Anmeldesperre faellt nach `/login` (DB-Schema v2), "manuell"
  nur bei wirksamem Vorzug. Pruefen: Server-Tab "Anmeldefehler · gesperrt bis".
- **D17-D19 Stoppen:** Stopp-Knopf im Lauf-Tab (Kopfzeile rechts, Handy
  links) und im Chats-Tab; gestoppter Agent endet als `stopped`, kein
  Kontowechsel danach; nach Stopp sofort neu senden ohne 409. Pruefen in der
  App mit echtem Agent (hier nicht moeglich).
- **D20:** vertipptes Arbeitsverzeichnis / unsinnige Zahlen -> sofort 400.
- **D21/22:** Lauf-Tab auf altem Lauf blockierte Ereignisse neuer Laeufe fuer
  die ganze Oberflaeche. Pruefen: alter Lauf offen, neuen starten ->
  Freigabe wird angesagt, Lauf erscheint in der Auswahl.
- **D23 Beszel:** "8 °C" war die Thread-Zahl; Temperatur/RAM/Platte jetzt aus
  `system_stats`. Pruefen: serverone ~20-30 °C; bleibt leer -> Beszel-Nutzer
  darf `system_stats` nicht lesen (Log "Beszel-Abfrage fehlgeschlagen").
- **D24:** WS-Nachricht `null` und werfender Discord-Befehl beendeten den
  ganzen Daemon; kaputter Anfragekoerper -> 413/400 mit Klartext.
- **D25:** eine kaputte Piper-Antwort (Kopfzeile `null`) **beendete den
  ganzen Daemon**, eine unsinnige Laengenangabe liess ihn endlos haengen --
  jetzt 503 (`e85ec1a`). WAV mit absurder Abtastrate an /api/hoeren blaehte
  sich auf GB auf -- jetzt abgelehnt (`54857ed`). Logbuch auf ~150 Zeilen.
- **D26:** hielt ein anderer Prozess kurz eine Schreibsperre auf
  `cockpit.db` (z. B. `sqlite3` in der Shell), **starb der Daemon** beim
  naechsten Agenten-Ereignis ("database is locked"). Jetzt wartet er bis
  5 s (`c537153`). Hinweis: in dieser Zeit steht die Ereignisschleife.
- **D27:** zwei gleichzeitige Sprachgespraech-Runden (App + Handy, oder
  Neuladen waehrend einer Runde) liefen unter demselben Agentenschluessel
  -- erste nicht mehr stoppbar, sessionId evtl. vertauscht. Jetzt 409
  (`17c97e5`). Pruefen: in der Zentrale erscheint dann "Antwort nicht
  bekommen: Das Gespräch antwortet gerade noch ...".
- **D28:** die CLI schreibt Reset-Zeiten meist ohne Datum ("resets 4am
  (Europe/Berlin)", auch beim Wochenlimit) -- das wurde nicht erkannt, das
  Konto nur pauschal 5 h gesperrt und lief danach erneut ins Wochenlimit.
  Jetzt naechstes Vorkommen der Uhrzeit/des Wochentags (`8408224`).
  Pruefen: Server-Tab "gesperrt bis" nach einem Limit passt zur CLI-Meldung.
- **D29:** Nachlieferung im Live-Strom war bei 5000 Ereignissen gedeckelt
  (grosse Laeufe: Loch im Lauf-Tab) und trennte langsame Klienten (Handy)
  mitten im Nachtrag -- ganze Oberflaeche "getrennt". Jetzt seitenweise mit
  Warten auf den Puffer (`9aa5caf`). Pruefen: grossen alten Lauf im
  Lauf-Tab am Handy oeffnen -> vollstaendig, keine "getrennt"-Pille.

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
   Discord-Ausgaenge geprueft: Embed-Grenzen werden durch kuerzen()
   eingehalten. D26: `.catch(runBeenden)` in daemon.ts abgesichert.
   Weiterhin gilt: jeder andere DB-Fehler (Platte voll, Sperre > 5 s) in
   einem Supervisor-Handler beendet den Daemon -- bewusst ohne globales
   process.on (siehe Punkt 5).
5. Prioritaet 2/3 laut Aufgabenstellung: Oberflaeche weiter feinschleifen
   (Konsistenz, Handy, Tastatur, Ladezustaende), mehr End-to-End-Szenarien,
   Daemon-Robustheit bei Last/Fehlern -- bisher nur das oben Gelistete tief
   geprueft, nicht erschoepfend. D24 hat Absturzpfade gesucht (WS, Discord,
   Anfragekoerper), D25 Sprachdienste (Piper/Whisper). D27: Promise-Ketten
   in daemon.ts/supervisor.ts/orchestrator.ts/discord.ts/kontenNutzungPuls
   durchgesehen -- alle haben Faenger, kein weiterer Absturzpfad gefunden.
   D28: feste Schluessel geprueft -- /api/lauf, Konsole, Discord-!lauf
   nutzen je Aufruf frische Ids, kein weiterer Fall. D29: Live-Strom-
   Nachlieferung (Last) behoben; /api/lauf ?seit=abc -> 400 (`995a94c`).
   Noch offen: Zentrale holt /api/lauf/<id> nur fuer die Agenten, bekommt
   aber bis zu 5000 Ereignisse mit (nur Verschwendung, kein Fehler).

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

## Erledigt (neueste zuerst, Details im Commit)

- `9aa5caf` `src/nachlieferung.ts` (Senden + Nachlieferung aus daemon.ts),
  `tests/nachlieferung.test.mjs`; Repro-Skripte `/tmp/nachtschicht/d29/`
  (`fuellen.mjs` 12000 Ereignisse, `wstest.mjs <pause-ms>`).
- `995a94c` /api/lauf/:id?seit= per zahlLesen geprueft.

- `8408224` resetzeitAusFehlertext: Uhrzeit/Wochentag ohne Datum (Formate
  aus echten Sitzungen gezaehlt: `grep -rhoa "You've hit your..."`).
- `17c97e5` /api/gespraech: zweite Runde waehrend der ersten -> 409
  (`src/gespraech.ts`, `tests/gespraech.test.mjs`).
- `c537153` DB busy_timeout 5 s (db.ts, chats.ts), laufAbschliessen() in
  daemon.ts; Sperr-Stub `/tmp/nachtschicht/halter.cjs <ms>`.
- `e85ec1a` WyomingLeser prueft Kopf/Laengen/Datenfeld, stimme.ts nutzt ihn
  (Absturz alt/neu in Testinstanz mit Stub `/tmp/nachtschicht/piperstub.mjs`).
- `54857ed` /api/hoeren: Abtastrate nur 3-768 kHz (`src/hoeren.ts`).
- `77bf285` `af5945a` `15c19cf` Daemon: Anfragekoerper 413/400, WS "null",
  Discord-catch (`src/httpFehler.ts`, `src/eingaben.ts`).
- `f82a1e6` Beszel-Felder + feldweises Mischen (`src/system.ts`; Stub
  `/tmp/nachtschicht/beszelstub.mjs`). Handy-Kopfzeile wischbar = Absicht.
- `501e649` Live-Strom ungefiltert an alle Klienten, Lauf-Tab filtert selbst.
- `c0d49e3` cwd/Zahlen bei /api/lauf, /api/orchestrator vorab pruefen.
- `59a3eca` Chats: nach Stopp sofort senden (`src/chatZuege.ts`).
- `da2ac07` Chats-Tab Stopp-Knopf. `886ad89` Lauf-Tab Stopp-Knopf.
- `f5407cc` URIError 400, EISDIR/ENOTDIR 404, /api-Fehler als JSON.
- `f3b5f04` 'stopped' haelt, kein Kontowechsel nach Abbruch.
- `9e4ae1b` neutraler Fortsetzungsprompt. `7b891d2` modus 'manuell' nur wirksam.
- `7f5c455` Anmeldesperre faellt nach erfolgreichem Poll (DB v2).
- `2685036` Test "keine Messung" vs. "0%" (`tests/server.test.mjs`).
- `3cd4a73` 429-Backoff (max 2h), Reset-Zeit aus CLI-Fehlertext.
- `aebf9e8` Nutzungsstand persistiert (`konten_nutzung`).
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
- **Vor dem Start pruefen, ob 8798 frei ist** -- D21 hatte seine Instanz
  nicht beendet (D22 fand sie noch laufen).
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
