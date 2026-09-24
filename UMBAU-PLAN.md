# Umbau: Cockpit wie Claude Code -- Plan

Stand 24.09.2026, geschrieben von der Claude-Sitzung, die Cans Wuensche
aufgenommen und den Code analysiert hat. Die Umsetzung macht der
Umbau-Loop auf servertwo (mehrere Durchgaenge mit frischem Kontext). Dieses
Dokument ist die Grundlage -- Fortschritt steht in `UMBAU-LOGBUCH.md`.

## Was Can will (seine Worte, zusammengefasst)

1. **Bedienung wie Claude Code / Claude Desktop.** Die jetzige Oberflaeche
   ist "komisch": der Lauf-Tab ist ein Ereignisprotokoll ("denkt", "ruft
   Bash"), der Auftrag verlangt `AN-ROLLE:`-Syntax, Runden, Parallelitaet.
   Er will chatten wie in der Claude-App: Projektordner waehlen, schreiben,
   Antworten lesen, Werkzeugaufrufe sehen, Freigaben erteilen, Modell und
   Einstellungen waehlen. Leicht zu benutzen, gut aussehend.
2. **Alle Einstellungen im Cockpit**, wie in Claude Code: Modell, Denkaufwand,
   Berechtigungsmodus, Arbeitsordner, Spezialisten, Konten.
3. **Echte Spezialisten statt "Rechercheur/Kommunikator/Coder".** Nur
   genutzt, wenn gebraucht. Ausdruecklich ein **Planer**, der komplexe
   Vorhaben vorher komplett durchplant -- aber nur bei wirklich komplexen
   Sachen. "Und sonst alles Moegliche, was ich brauche."
4. **Keine Doppelungen.** Nichts soll auf zwei Tabs dasselbe zeigen.
5. **Der "Wissenskern" muss weg bzw. anders.** Die leuchtende Kugel/der
   3D-Graph (Zentrale, Vault) "bringt nichts", "sieht nicht cool aus, wie ein
   Herz von der KI", "man kann ihn nicht benutzen".
6. **Agenten wirklich sehen**: was jeder Agent/Orchestrator gerade tut.
7. **Immer eine To-do-Liste** bei jeder Aufgabe, und ein **eigener Tab**, in
   dem man sieht, welcher Agent/Orchestrator was gerade macht und was er noch
   vorhat.
8. **Nutzung & Statistik**: Raster (Heatmap) ueber alle Konten zusammen,
   Tage mit viel Nutzung leuchten heller; Statistiken aller Art, auch
   "wie lange reicht mein Guthaben in diesem Tempo"; im Nachhinein sehen,
   was er alles gemacht hat.
9. **Nutzungsguthaben**: Schalter an/aus + Anzeige, wie viel uebrig ist,
   Prognose. (Siehe Befund unten -- die API meldet es derzeit als AUS.)
10. "Denk selbst nach, was sonst noch sinnvoll waere." -- Qualitaet vor
    Menge, perfektionieren statt nur machen.

## Befunde aus der Analyse (belegt)

- **Opus 5.5 ging im Cockpit gar nicht**: die im Agent SDK gebuendelte CLI
  war 2.1.278, Opus 5.5 braucht >= 2.1.280. Behoben: SDK 0.3.281 (Commit
  "Agent SDK auf 0.3.281"). Fable 5.1 braucht Nutzungsguthaben -- nicht
  anbieten, solange keins aktiv ist.
- **Agenten laden keine CLAUDE.md/Skills/Settings**: `query()` bekommt kein
  `settingSources`. Die SDK-Vorgabe laedt laut sdk.d.ts zwar alle Quellen
  ("When omitted, all sources are loaded (matches CLI defaults)"), trotzdem
  ausdruecklich setzen und in den Einstellungen schaltbar machen.
- **SDK kann alles, was gebraucht wird** (sdk.d.ts, 0.3.281): `model`,
  `effort` ('low'|'medium'|'high'|'xhigh'|'max'), `permissionMode`
  ('default'|'acceptEdits'|'plan'|'bypassPermissions' -- letzteres braucht
  `allowDangerouslySkipPermissions: true`), `agents` (Subagenten:
  description/prompt/tools/model/mcpServers), `includePartialMessages`
  (Live-Text), `canUseTool` mit `suggestions` (-> "immer erlauben" ueber
  `updatedPermissions`), AskUserQuestion-Antworten ueber
  `updatedInput.answers` ({Fragetext: Antwort}), ExitPlanMode ueber
  canUseTool (Plan annehmen -> `updatedPermissions: [{type:'setMode', mode, destination:'session'}]`).
  Der Agent-Werkzeugaufruf hat `run_in_background` (Vorgabe true!) -- fuer
  Chats per Systemprompt-Zusatz auf Vordergrund lenken, sonst endet der Zug,
  bevor der Spezialist fertig ist.
- **Resume behaelt die Session-Id** (live geprueft: chat_fortsetzung.session_id
  == aktuelle_session). Ein Chat = eine Session-Id, stabil.
- **Sitzungsdateien**: Spiegel des Desktops `/var/lib/cockpit/sessions-desktop`
  (Syncthing), Server `~/.claude/projects` (das projects/ von `zweit` ist ein
  Link darauf). Subagenten-Verlaeufe in `<sitzung>/subagents/*.jsonl`.
  Feld `entrypoint`: `claude-desktop`/`cli` = Can selbst, `sdk-ts` =
  Cockpit-Agenten (Chats UND Worker), `sdk-cli` = `claude -p` (Loops).
  Der alte Chat-Index kannte NUR den Spiegel -- Chats aus dem Cockpit
  tauchten nie in der Liste auf.
- **Nutzungsguthaben**: `/api/oauth/usage` OHNE `skip_spend=1` liefert
  `extra_usage` und `spend`. Stand 24.09.: beide Konten `is_enabled:false`
  (haupt `user_disabled:true`, zweit `credits_ever_enabled:false`),
  `can_toggle:false`, `balance:null`, `spend.used.amount_minor:0`. Einschalten
  geht nur in claude.ai (Einstellungen -> Nutzung). Das Cockpit kann den
  Kontoschalter also NICHT umlegen -- es kann anzeigen und selbst
  entscheiden, ob es ein Konto im Limit weiter benutzt, wenn Guthaben aktiv
  ist. Genau so bauen, und in der Oberflaeche ehrlich sagen.
- **Nutzungswerte**: `/api/oauth/usage` liefert five_hour/seven_day als
  utilization 0-100 + resets_at (ISO), dazu `limits[]` (kind/percent/
  resets_at/is_active). Schon umgesetzt in src/kontenNutzung.ts.

## Schon erledigt (Branch `umbau-oberflaeche`, noch nicht verdrahtet)

- `src/einstellungen.ts`: Einstellungen mit Pruefung (reine Funktion
  `einstellungenPruefen`), Vorgaben, Modell-/Aufwand-/Berechtigungslisten.
  FEHLT: DB-Speicher + API + Tests.
- `src/nachrichten.ts`: EIN Normalisierer fuer Sitzungsdatei-Zeilen UND
  Live-SDK-Nachrichten -> {id, rolle, ts, bloecke[text|denken|werkzeug|
  ergebnis|bild|hinweis], modell, eltern}. Werkzeugergebnisse bleiben eigene
  Bloecke ({typ:'ergebnis', zu}), die Oberflaeche fuehrt sie zusammen.
  FEHLT: Tests.
- `src/nutzung.ts`: inkrementeller Tokenindex ueber alle Sitzungsdateien
  (entdoppelt ueber message.id+requestId, Byte-Versatz je Datei), Tag in
  Europe/Berlin, Auswertung je Tag/Modell/Projekt/Stunde. Lokal geprueft:
  168 Dateien in 1 s, danach 13 ms. FEHLT: Tests, Anbindung im Daemon.
- `src/chats.ts`: Index ueber Spiegel UND Server (eine Datei je Sitzung,
  neueste gewinnt), Spalten quelle/entrypoint (Index-Version 2, baut sich
  neu), Sichtbarkeitsfilter (nur Mensch-Sitzungen + Cockpit-Chats),
  Sortierung nach letzter Aktivitaet, `chatRegistrieren`, `verlaufLesen`.
- `rollen/`: neue Spezialisten planer, coder (Entwickler), pruefer, reviewer,
  fehlersucher, rechercheur, gestalter, admin (Server-Admin), doku; kommunikator
  entfernt. Neue Kopffelder `symbol`, `farbe`, `einsatz` (wann nutzen und
  wann NICHT -> wird die Subagenten-`description`).
  `src/rollen.ts`: `agentDefinitionen(ausgeschaltet)` -> SDK-`agents`.
  FEHLT: Orchestrator muss `modell: inherit` aufloesen (sonst geht 'inherit'
  als Modellname an die SDK), Tests, Oberflaeche nimmt Farben aus /api/rollen
  statt hart kodiert (graph.js, lauf.js, vault.js, zentrale.js).

## Zielbild

### Navigation (Seitenleiste links, am Handy als Schublade) -- ohne Doppelungen

| Bereich | Inhalt | Ersetzt |
|---|---|---|
| **Chats** (Start) | Liste aller Chats + Chat-Ansicht | Chats-Tab, Lauf-Tab fuer Einzelchats, Zentrale-Gespraech |
| **Aufgaben** | Was laeuft gerade: je Chat/Team-Auftrag die Agenten, ihr Status, aktuelle Taetigkeit, **To-do-Liste**, Subagenten; Team-Auftrag starten (einfaches Formular); abgeschlossene Auftraege | Lauf-Tab (Graph/Log), Zentrale-Agenten, Zentrale-Auftrag |
| **Nutzung** | Heatmap, Statistik, Konten mit Limits (5h/Woche, Reset), Guthaben, Prognosen | Zentrale-Nutzungsfenster, Server-Tab-Konten, Kopfzeilen-Pills |
| **Server** | Auslastung beider Server | Zentrale-Serverlast |
| **Notizen** | Obsidian-Vault durchsuchen und lesen (statt 3D-Kugel) | Vault-Tab, Wissenskern |
| **Terminal** | Befehle mit Freigabe (bisher Konsole) | Konsole |
| **Einstellungen** | Allgemein, Modell & Denken, Berechtigungen, Spezialisten, Konten-Vorzug, Sprache/Stimme, Team-Vorgaben | Kopfzeilen-Auswahl Stimme |

Die Zentrale (HUD-Dashboard) faellt weg -- jede ihrer Kacheln lebt genau in
EINEM Bereich oben. Die Kopfzeile schrumpft auf das Noetigste (Verbindung,
evtl. ein kleiner Limit-Indikator, der zur Nutzung verlinkt -- keine zweite
Anzeige derselben Zahlen).

### Chat (das Herzstueck, Bedienung wie Claude Desktop)

- Seitenleiste: "Neuer Chat", Suche, Chats gruppiert (Heute, Gestern, Letzte
  7 Tage, Aelter), je Chat Titel + Projekt + laufend-Punkt.
- Verlauf zentriert (max ~780 px): Nutzer-Nachricht als Blase, Antwort als
  **Markdown** (Ueberschriften, Listen, Tabellen, Code mit Hervorhebung und
  Kopieren-Knopf). Markdown sicher rendern (HTML escapen/sanitizen -- Modelltext
  ist nicht vertrauenswuerdig). Bibliotheken als Dateien nach web/vendor
  (z. B. marked + DOMPurify + highlight.js aus npm), kein Build-Schritt.
- Werkzeuge kompakt, aufklappbar: Bash (Befehl + Ausgabe), Read (Datei),
  Edit/Write/MultiEdit (**Diff**-Ansicht), Grep/Glob, WebSearch/WebFetch,
  **TodoWrite als Checkliste**, **Agent/Task als Spezialisten-Karte**
  (Symbol+Farbe der Rolle aus /api/rollen, Auftrag, Ergebnis, live die
  letzte Taetigkeit des Subagenten ueber `eltern`), Denken eingeklappt.
- Freigaben inline: Erlauben / Immer erlauben (Sitzung) / Ablehnen.
  AskUserQuestion als Auswahlkarte (Optionen + "Andere"), ExitPlanMode als
  Plan mit "Umsetzen (Aenderungen automatisch)", "Umsetzen (nachfragen)",
  "Weiter planen".
- Live: Text Wort fuer Wort (includePartialMessages; Deltas nur per WS,
  NICHT in die DB), "Claude arbeitet"-Anzeige, Stopp-Knopf.
- Eingabe: Textfeld (Enter sendet, Shift+Enter Zeile), Projektordner-Wahl
  (Favoriten, zuletzt benutzte, Ordner durchsuchen ueber API), Modell,
  Denkaufwand, Berechtigungsmodus, Mikrofon (vorhandenes /api/hoeren).
- Kopf: Titel, Ordner, verwendetes Konto/Modell, Tokens/Kosten des Chats.
- Kontowechsel bei Limit bleibt (Supervisor), im Chat als ruhiger Hinweis.

### Spezialisten und To-do-Listen

- Chats bekommen `agents: agentDefinitionen(rollenAus)` -- Claude delegiert
  selbst, wenn die `einsatz`-Beschreibung passt. Einstellungen: Spezialisten
  an/aus, einzeln abschaltbar, Modell je Rolle sichtbar.
- Systemprompt-Zusatz fuer Chats (append ans claude_code-Preset): (a) bei
  jeder Aufgabe mit mehr als einem Schritt zuerst eine To-do-Liste mit
  TodoWrite anlegen und aktuell halten; (b) Spezialisten im Vordergrund
  (run_in_background: false) rufen; (c) Planer nur bei komplexen Vorhaben;
  (d) Cans Vault-Hinweis wie bisher.
- **Kein eigener To-do-Agent**: jeder Agent fuehrt seine eigene Liste
  (TodoWrite) -- das ist genauer und kostet nichts extra. Der Aufgaben-Bereich
  sammelt alle Listen (Begruendung fuer Can im Logbuch festhalten).
- Server: letzte TodoWrite-Eingabe je (runId, agentId) aus den Ereignissen
  (Supervisor sieht tool_use), Endpunkt `/api/aufgaben`: laufende und
  kuerzliche Chats/Team-Auftraege mit Agenten, Status, letzter Taetigkeit,
  To-dos, Subagenten. Live-Aktualisierung per WS.
- Orchestrator: Rollenliste aus `einsatz`; Regel "bei komplexen Auftraegen
  zuerst AN-ROLLE: planer"; `inherit` -> workerModell. Optional ein Feld
  `AUFGABEN:` (Checkliste des Orchestrators) im Antwortformat -- nur wenn der
  Parser (src/protokoll.ts, Tests!) sauber mitkommt; sonst die Liste aus dem
  Verlauf ableiten.
- Team-Auftrag-Formular ohne Syntax: Auftrag, Ordner, (aufklappbar) Runden,
  Parallel, Modelle; Spezialisten waehlt der Orchestrator.

### Nutzung & Statistik

- Heatmap 53 Wochen x 7 Tage (GitHub-Stil), Stufen nach Quantilen der Tage
  mit Nutzung, oberste Stufe **leuchtet** (Glow), Tooltip: Datum, Tokens,
  Antworten, Sitzungen. Summe = Eingabe + Ausgabe + Cache-Schreiben (ohne
  Cache-Lesen -- sonst >90 % Rauschen); Cache-Lesen separat im Detail.
- Kennzahlen: heute / 7 Tage / 30 Tage, Serie aktiver Tage, aktivster Tag,
  Tageszeit-Verteilung (stunden), Top-Projekte, Modelle.
- Konten: je Konto 5h- und Wochenbalken mit Reset-Zeit, gesperrt/als
  naechstes, Vorzug setzen, Prognose "Wochenlimit reicht bei diesem Tempo
  bis ..." (aus Verlauf der Messungen).
- Guthaben: je Konto Status aus `extra_usage`/`spend` (aktiv? verbraucht?
  Grenze?), Hinweis wie man es in claude.ai einschaltet, Cockpit-Schalter
  "Guthaben nutzen, wenn ein Konto im Limit ist" (steuert, ob das Balancing
  ein Konto im Limit weiter nimmt, wenn dessen Guthaben aktiv ist) plus
  eigene Obergrenze in EUR/USD; Prognose "reicht bei diesem Tempo noch X Tage".
- Rueckblick ("was habe ich alles gemacht"): Liste der Tage mit Chats/
  Projekten/Auftraegen, Klick fuehrt zum Chat.

### Weitere sinnvolle Dinge (von mir vorgeschlagen, nach Wert sortiert)

1. Benachrichtigung, wenn ein Chat/Auftrag fertig ist oder eine Freigabe
   wartet (vorhandene Stimme + Browser-Notification am Handy/PWA).
2. Chat umbenennen, anheften, loeschen (nur Cockpit-Eintrag, nie die Datei
   des Desktops).
3. Tastenkuerzel (Strg+K neuer Chat/Suche, Esc stoppt).
4. Dateien/Bilder in den Chat ziehen (spaeter).

## Reihenfolge (jeder Schritt: Tests + Commit + Logbuch)

1. Branch vorbereiten: `nacht-optimierung` (Arbeit des alten Loops) in
   `umbau-oberflaeche` mergen, Konflikte sauber loesen, Tests gruen.
2. Backend fertig: Einstellungen (DB+API+Tests), nachrichten.ts-Tests,
   nutzung.ts-Tests + Daemon-Anbindung (`/api/nutzung`, Index alle 10 min +
   beim Start), Chat-API (neu/fortsetzen mit Modell/Aufwand/Modus/agents/
   settingSources/Live-Text, Freigaben mit immer/answers/Plan, Abbrechen),
   `/api/aufgaben`, `/api/verzeichnisse`, Guthaben in kontenNutzung,
   Rollen-Farben in /api/rollen. Alte Endpunkte erst entfernen, wenn die neue
   Oberflaeche sie nicht mehr braucht.
3. Oberflaeche: Grundgeruest (Seitenleiste, Router), Chat, Einstellungen,
   Nutzung, Aufgaben, Server, Notizen, Terminal -- jeweils mit
   Playwright-Pruefung bei 1280 und 375 px (playwright ist devDependency;
   Chromium lief auf dem Server schon).
4. Aufraeumen: Zentrale, Lauf-Graph, Wissenskern (kern.js), alte Tabs,
   verwaiste Endpunkte entfernen; README aktualisieren.
5. Ende-zu-Ende in der Testinstanz, inklusive **echter** kurzer Chats mit
   Haiku (billig): neuer Chat, Fortsetzen, Freigabe, Plan-Modus, ein
   Spezialist, Abbrechen, Kontowechsel-Anzeige.
6. Ausrollen (siehe Auftrag: ueber den Waechter, nicht selbst).

## Qualitaetsmassstab

- Bedienung ohne Erklaerung, Handy gleichwertig. Keine Doppelungen.
- Kein Fehler in der Browserkonsole, keine unbehandelte Ausnahme im Daemon.
- Jede neue Funktion mit Test; `npx tsc && npm test` vor jedem Commit gruen.
- Stil des Repos: deutsche Bezeichner und Kommentare (ae/oe/ue), Kommentare
  erklaeren das Warum.
