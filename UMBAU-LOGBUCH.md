# Umbau-Logbuch (Branch `umbau-oberflaeche`)

## Zusammenfassung fuer Can

- **Stand:** Schritte 1-4 erledigt: alle Bereiche gebaut (Chat,
  Aufgaben, Nutzung, Server, Notizen, Terminal, Einstellungen), alte
  Oberflaeche entfernt, README neu. Offen: Schritt 5 (Ende-zu-Ende mit Haiku).
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
  - *Notizen zeigen jetzt Notiztext* (bisher gingen bewusst nur Titel und
    Verweise ueber die API). Dein Wunsch "durchsuchen und lesen" geht nicht
    anders; erreichbar nur im Tailnet, und der Chat-Agent liest den Vault
    ohnehin. Gelesen wird nur, was als Notiz gelistet ist (.md unter dem
    Vault, keine Punktordner, keine Symlinks nach draussen).
  - *Server-Verlauf nur im Speicher* (1 h, je 20 s): nach einem Neustart
    beginnt die Kurve neu -- keine 180 DB-Zeilen je Stunde und Host.
  - *Terminal bleibt ohne "immer erlauben"* und ohne interaktive Shell
    (wie bisher, Begruendung in konsole.ts); neu ist nur ein Verlauf der
    letzten 30 Befehle im Daemon.
  - *Sprachgespraech der Zentrale entfernt* (`/api/gespraech`, werkzeugloser
    Antwort-Agent mit Vorlesen): laut Plan geht es im Chat auf; dort gibt es
    Diktieren ins Eingabefeld. Vorgelesen werden nur noch Freigaben/Fragen.
    Faellt dir das Vorlesen von Antworten ab, waere "Antwort vorlesen" im
    Chat der Weg (Piper ist ja da).
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
- `GET /api/system` zusaetzlich `verlauf {host: [{t, cpu, ram}]}` (1 h).
- `GET /api/notizen?q=` -> `{da, anzahl, notizen:[{id, titel, ordner,
  tags, geaendert, stelle}]}` (max. 50, ohne q die neuesten);
  `GET /api/notizen/lesen?id=` -> `{..., text, verweise, rueckverweise}`
  (404 unbekannt). Modul `src/notizen.ts`.
- `GET /api/konsole` -> `{eintraege}` (letzte 30 Befehle, letzter Stand).
- Gebaut in `src/chatOptionen.ts`, `src/freigaben.ts`, `src/aufgaben.ts`.

## Neue Oberflaeche (Aufbau)

- `web/index.html` + `web/stil.css` + `web/app.js` (Router `#/chat/<id>`,
  `#/<bereich>`, Seitenleiste/Schublade, Fuss mit Verbindung + Limit).
- `web/ui/`: `dom.js` (h(), Symbole, api(), Formate), `markdown.js`,
  `chat.js`, `eingabe.js` (Ordner/Modell/Denken/Modus, Diktieren),
  `werkzeuge.js` (Werkzeug-Zeilen, Diff, To-do, Spezialisten-Karte),
  `diff.js`, `chatliste.js`, `einstellungen.js`, `nutzung.js`,
  `aufgaben.js`, `freigabekarten.js` (Chat + Aufgaben), `server.js`,
  `notizen.js` (Route `#/notizen/<id>`), `terminal.js`;
  Stil der Bereiche in `web/bereiche.css`. Bereiche: in `app.js` `BEREICHE` eintragen,
  `bauen()` -> `{el, zeigen(param), verbergen()}`.
- Vendor-Dateien: `node scripts/vendor.mjs` (kein Build-Schritt).
- Browserpruefung: `node scripts/oberflaeche-pruefen.mjs [url] [ansichten]`
  (1280/375, Konsolenfehler, Ueberbreite, Bilder nach nachtschicht-bilder/).
  Ansichten `aufgaben-voll/-team/-fehler` mit `scripts/aufgaben-attrappe.mjs`.
  Eigene Playwright-Skripte muessen in `scripts/` liegen (sonst findet node
  playwright nicht) -- danach loeschen.

## Naechste Schritte

1. Schritt 5 Ende-zu-Ende mit Haiku (hoechstens 15 Zuege!): neuer Chat,
   Fortsetzen, Freigabe, Plan-Modus, Spezialist, Abbrechen,
   Kontowechsel-Anzeige; dabei Chat-Karten und Aufgaben (To-do, Spezialist)
   echt ansehen, Guthaben-Form pruefen.
2. Danach Ausrollen anfordern (`.umbau-ausrollen`).

## Durchgaenge

- **D1-D3** (24./25.9.): npm install, Merge nacht-optimierung,
  Einstellungen DB+API, Nutzung, Rollen, `/api/verzeichnisse` (D2 ohne
  Ergebnis: Sitzungslimit).
- **D4**: Chat-API, Freigaben, Live-Deltas, `/api/aufgaben`, Guthaben.
  Hinweis: in der Testinstanz steht der entrypoint neuer Chats als
  `sdk-cli` (erbt CLAUDE_CODE_ENTRYPOINT aus meiner Shell) -- live nicht.
- **D5**: Geruest + Chat-Ansicht; Kontowechsel-Fehler gefunden/behoben.
  Testkonten heissen `zweit`/`dritt` (`haupt` = CLAUDE_CONFIG_DIR).
- **D6**: Einstellungen + Nutzung; Stimmstufe wurde nie geladen (behoben).
  Testkonten tragen kuenstliche Messwerte in /tmp/umbau/cockpit.db.
- **D7**: Aufgaben; CSS-Variablen in h() kamen nie an (behoben).
- **D8** (25.9. ~05:00): Bereich Server begonnen, vom Sitzungslimit
  unterbrochen (nicht committet).
- **D9** (25.9. 07:21): nacht-optimierung ohne neue Commits. Server aus D8
  fertig (Kurve erst ab 3 Min. Verlauf, Ausrichtung), **Notizen** und
  **Terminal** gebaut, jeweils mit Tests; Playwright alle 52 Ansichten
  1280/375 ohne Befund (inkl. echtem Terminal-Ablauf mit Neuladen).
- **D10** (25.9. 07:35): Schritt 4: alte Oberflaeche, three.js,
  `/api/gespraech`, `/api/vault/graph` (+Index), `POST /api/lauf`,
  `chatLesen` entfernt (`/api/laeufe` bleibt: ausrollen.sh nutzt es); README
  neu. Playwright 52 Ansichten ohne Befund.
