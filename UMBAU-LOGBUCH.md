# Umbau-Logbuch (Branch `umbau-oberflaeche`)

## Zusammenfassung fuer Can

- **Stand:** Schritte 1 und 2 erledigt. Schritt 3 (Oberflaeche) laeuft:
  Geruest, **Chat, Einstellungen, Nutzung, Aufgaben fertig**; Server,
  Notizen, Terminal sind noch Platzhalter.
- **Fertig (Backend):** Einstellungen in der DB + API; Nutzungsindex +
  `/api/nutzung`; Rollen (`inherit`, Planer-Regel); `/api/verzeichnisse`;
  **Chat-API** (neuer Chat, Weiterschreiben mit Modell/Aufwand/Modus,
  Spezialisten als Subagenten, CLAUDE.md/Skills laden, Live-Text, Freigaben
  mit "immer erlauben", Antworten auf Rueckfragen, Plan annehmen);
  **`/api/aufgaben`** (To-do-Listen und Spezialisten aller Agenten);
  **Nutzungsguthaben** in `/api/konten` (nur Anzeige).
- **Du musst pruefen:** noch nichts (nicht ausgerollt).
- **Team-Auftraege jetzt ohne Discord bedienbar:** Fragen des
  Orchestrators ("Fall B") und Freigaben der Worker beantwortet man im
  Bereich Aufgaben; die Team-Vorgaben der Einstellungen gelten wirklich
  (vorher fest 10 Runden / 1 parallel).
- **Fehler gefunden und behoben (betraf live):** scheiterte bei einem NEUEN
  Chat das erste Konto vor der ersten Zeile (z.B. Anmeldefehler), endete der
  Kontowechsel mit "No conversation found". Jetzt startet das naechste Konto
  frisch mit derselben Session-Id (Commit c26f983).
- **Entscheidungen, die ich getroffen habe:**
  - *Kein eigener To-do-Agent*: jeder Agent fuehrt seine Liste selbst mit
    TodoWrite (Chat-Systemprompt verlangt das), der Aufgaben-Bereich sammelt
    sie nur ein -- genauer und ohne Extrakosten.
  - *"Immer erlauben" gilt nur fuer die laufende Sitzung*: die SDK schlaegt
    Regeln fuer `localSettings` vor; ich schreibe das Ziel auf `session` um,
    damit ein Klick im Cockpit keine `.claude/settings.local.json` im Projekt
    aendert (die auch deine CLI am PC betreffen wuerde).
  - *Plan annehmen* erlaubt nur "Aenderungen automatisch" oder "nachfragen",
    nie "Alles erlauben".
  - *Konten-Vorzug steht in der Nutzung*, nicht in den Einstellungen: dort
    sieht man die Limits, nach denen man waehlt (Einstellungen verlinken
    nur dorthin -- keine Doppelung).
  - *Stimme bleibt je Geraet* (localStorage), alles andere liegt im Daemon.
  - *Wochenprognose linear* (Anteil / vergangene Zeit im Fenster), erst ab
    6 h nach Fensterbeginn -- vorher ist das Tempo Zufall.
  - *Guthaben: noch kein Cockpit-Schalter* "Guthaben nutzen, wenn im Limit"
    (Plan) -- das griffe ins Balancing ein, und die echte Form der Antwort
    ist ungeprueft. Erst nach dem Ende-zu-Ende-Test entscheiden. Ebenso
    offen: Prognose "Guthaben reicht noch X Tage" (braucht Verlauf).
  - *Freigaben von Chats* entscheidet man im Chat (Aufgaben verlinkt
    dorthin), nur Team-Worker direkt in Aufgaben -- keine Doppelung.
  - *Haiku bekommt keinen Denkaufwand* (effort) -- kennt keine Stufen.
  - *Guthaben*: eigene stuendliche Abfrage ohne `skip_spend`, der erprobte
    10-Minuten-Nutzungspuls bleibt, wie er ist. Mit echten Konten noch
    ungeprueft (Form nur aus der Stichprobe vom 24.9. bekannt) -> beim
    Ende-zu-Ende-Test ansehen.

## Neue API (fuer die Oberflaeche, Schritt 3)

- `POST /api/chats` `{text, cwd?, modell?, aufwand?, berechtigung?}` ->
  `202 {id, laufId, cwd, startSeq}`; Id = Session-Id, sofort nutzbar.
  Nach dem ersten Zug WS `chats {id}` (Index aktualisiert).
- `POST /api/chats/:id/weiter` `{text, modell?, aufwand?, berechtigung?}`.
- Verfolgen: WS `ereignis`/`agent` bzw. `GET /api/lauf/<laufId>?seit=`;
  Live-Text: WS `delta {runId, agentId, eltern, art:'text'|'denken', text, neu}`.
- `POST /api/freigabe` `{id, erlaubt, immer?, antworten?:{Frage:Antwort},
  modus?:'acceptEdits'|'default', nachricht?}`; Anfragen tragen
  `immerMoeglich`.
- Abbrechen: `POST /api/abbrechen {runId, agentId:'chat'}` (bestand).
- `GET /api/aufgaben` -> `{laeufe:[{runId, chatId, titel, laeuft,
  agenten:[{..., todos, letzteTaetigkeit, spezialisten:[...]}]}]}`; WS
  `aufgaben {runId}` bei Aenderung.
- `GET /api/konten` hat jetzt `guthaben: {konto: {aktiv, stand, ...}}`,
  je Konto `fuenfStundenResetAm`, `siebenTageResetAm` (ms) und
  `wochePrognose {reicht, leerAm}`.
- `/api/aufgaben` je Lauf zusaetzlich `team {runde, stand, frage}|null`,
  `freigaben` (offene, nur laufende). `POST /api/orchestrator/antwort
  {runId, text}` (404 laeuft nicht, 409 wartet nicht).
- `GET /api/nutzung/tag?tag=JJJJ-MM-TT` -> Sitzungen des Tages mit `chat
  {id, titel}` (auch ueber Fortsetzungen).
- Gebaut in `src/chatOptionen.ts`, `src/freigaben.ts`, `src/aufgaben.ts`.

## Neue Oberflaeche (Aufbau)

- `web/index.html` + `web/stil.css` + `web/app.js` (Router `#/chat/<id>`,
  `#/<bereich>`, Seitenleiste/Schublade, Fuss mit Verbindung + Limit).
- `web/ui/`: `dom.js` (h(), Symbole, api(), Formate), `markdown.js`,
  `chat.js`, `eingabe.js` (Ordner/Modell/Denken/Modus, Diktieren),
  `werkzeuge.js` (Werkzeug-Zeilen, Diff, To-do, Spezialisten-Karte),
  `diff.js`, `chatliste.js`, `einstellungen.js`, `nutzung.js`,
  `aufgaben.js`, `freigabekarten.js` (Chat + Aufgaben);
  Stil der Bereiche in `web/bereiche.css`. Bereiche: in `app.js` `BEREICHE` eintragen,
  `bauen()` -> `{el, zeigen(param), verbergen()}`.
- Vendor-Dateien: `node scripts/vendor.mjs` (kein Build-Schritt).
- Browserpruefung: `node scripts/oberflaeche-pruefen.mjs [url] [ansichten]`
  (1280/375, Konsolenfehler, Ueberbreite, Bilder nach nachtschicht-bilder/).
  Ansichten `aufgaben-voll/-team/-fehler` mit `scripts/aufgaben-attrappe.mjs`.
  Eigene Playwright-Skripte muessen in `scripts/` liegen (sonst findet node
  playwright nicht) -- danach loeschen.
- Alte Oberflaeche (`web/tabs/*`, `kern.js`, `graph.js`, `zeitachse.js`,
  `hud.css`, `tabs.js`, `sprachpegel.js`?) ist nicht mehr eingebunden ->
  Schritt 4 loeschen. `chatLesen` in chats.ts ist tot (nur noch Tests).

## Naechste Schritte

1. Bereiche bauen: Server, Notizen (Suche/Lesen statt 3D), Terminal
   (Konsole). Vorlage: `nutzung.js`/`aufgaben.js` (laden/zeichnen,
   Fehlerbox, Pollen nur sichtbar). Alte Umsetzung: `web/tabs/*.js`.
2. Chat-Karten fuer Freigabe/Rueckfrage/Plan/Spezialist sind nur ohne echte
   Daten geprueft -> in Schritt 5 mit Haiku echt ansehen; ebenso Aufgaben
   mit echtem Chat (To-do, Spezialist) und einem kleinen Team-Auftrag.
3. Schritt 4 Aufraeumen, README; Schritt 5 Ende-zu-Ende mit Haiku.

## Durchgaenge

- **D1** (24.9.): npm install, Merge nacht-optimierung, Einstellungen DB+API,
  Normalisierer-Tests, Nutzung angebunden -- vom Sitzungslimit mitten im
  Nutzungs-Commit abgebrochen, Logbuch fehlte noch.
- **D2**: sofort Sitzungslimit, nichts getan.
- **D3** (25.9. 02:21): Nutzung-Arbeit aus D1 committet, nacht-optimierung
  erneut gemergt, Logbuch angelegt, Rollen-Tests, `/api/verzeichnisse`.
- **D4** (25.9. 02:25): nacht-optimierung ohne neue Commits. Chat-API,
  Freigaben, Live-Deltas, `/api/aufgaben`, Guthaben -- mit Tests
  (freigaben/aufgaben/db/konten), in der Testinstanz per curl geprueft
  (feste Session-Id kommt an, Weiterschreiben mit bypassPermissions/effort
  nimmt die CLI an). Hinweis: in meiner Testumgebung steht der entrypoint
  neuer Chats als `sdk-cli`, weil die Instanz CLAUDE_CODE_ENTRYPOINT aus
  meiner Shell erbt -- live (systemd) nicht der Fall.
  Die Kopie der Live-DB fuer einen Probelauf war per Regel gesperrt --
  ausgelassen.
- **D5** (25.9. 02:36): nacht-optimierung ohne neue Commits. Ereignisse
  tragen normalisierte `nachricht`, GET /api/chats/:id im vollen Format.
  Neues Geruest + Chat-Ansicht, Playwright 1280/375 ohne Befund. Senden mit
  Attrappen-Konten geprueft (Anmeldefehler, Kontowechsel) -> Kontowechsel-
  Fehler gefunden und behoben. Testkonten heissen jetzt `zweit`/`dritt`
  (`haupt` ist CLAUDE_CONFIG_DIR, Namensgleichheit verwirrte die Liste).
- **D6** (25.9. 02:56): nacht-optimierung ohne neue Commits. Backend:
  Reset-Zeiten + Wochenprognose in /api/konten, /api/nutzung/tag (Tests).
  Bereiche **Einstellungen** und **Nutzung** gebaut, Playwright 1280/375
  ohne Befund (auch Fehler-/Leerzustand, Bedienung der Schalter). Stimmstufe
  wurde in der neuen Oberflaeche nie geladen -> behoben. Rollen- und
  Auswahltexte mit echten Umlauten; Symbol des Fehlersuchers (⌖ fehlte in
  Schriften) -> ✱. Hilfsskript fuer hohe Bilder: `scripts/.lang-tmp.mjs`
  (nicht im Repo). Testkonten tragen kuenstliche Messwerte in
  /tmp/umbau/cockpit.db.
- **D7** (25.9. 03:10): nacht-optimierung ohne neue Commits. Bereich
  **Aufgaben** (Laeufe, Agenten, To-do, Spezialisten, Team-Formular,
  Orchestrator-Frage, Worker-Freigaben) + Backend dazu (Tests).
  Playwright 1280/375 mit Attrappe: Eingaben/Fokus ueberleben das
  5-s-Nachladen, Freigabe sendet richtig, keine Konsolenfehler. Gefunden:
  CSS-Variablen in h() kamen nie an (Rollenfarben fehlten ueberall);
  Titel eines Team-Auftrags war in Runde 1 der Worker-Name.
