# Umbau-Logbuch (Branch `umbau-oberflaeche`)

## Zusammenfassung fuer Can

- **Stand:** Schritte 1-6 erledigt: alle Bereiche gebaut (Chat,
  Aufgaben, Nutzung, Server, Notizen, Terminal, Einstellungen), alte
  Oberflaeche entfernt, README neu, Ende-zu-Ende mit echten Haiku-Zuegen
  bestanden (13 Zuege). **Ausgerollt am 25.9. 08:05** (c202fde, Dienst
  gesund, Sicherung `~/schleife/sicherung-20260925-080518`).
- **Live gesehen (D11, nur GET, alle POSTs im Browser blockiert):** alle
  7 Bereiche und ein echter Chat bei 1280 und 375 px, keine
  Konsolenfehler, keine Ueberbreite. Chatliste zeigt deine Desktop-Chats
  (Gruppen Gestern/Letzte 7 Tage, PC-Marke), Nutzung mit Jahresraster und
  Tagesliste, Server mit beiden Hosts (Beszel + lokal), Fuss "verbunden,
  zweit 56 %".
- **Fertig (Backend):** Einstellungen in der DB + API; Nutzungsindex +
  `/api/nutzung`; Rollen (`inherit`, Planer-Regel); `/api/verzeichnisse`;
  **Chat-API** (neuer Chat, Weiterschreiben mit Modell/Aufwand/Modus,
  Spezialisten als Subagenten, CLAUDE.md/Skills laden, Live-Text, Freigaben
  mit "immer erlauben", Antworten auf Rueckfragen, Plan annehmen);
  **`/api/aufgaben`** (To-do-Listen und Spezialisten aller Agenten);
  **Nutzungsguthaben** in `/api/konten` (nur Anzeige).
- **Neu seit dem Ausrollen (D11, noch nicht live):** Benachrichtigungen
  (Einstellungen > "Stimme und Benachrichtigungen", je Geraet einschalten):
  Chat fertig/Fehler, Freigabe, Rueckfrage, Plan, Team-Auftrag -- nur wenn
  du nicht ins Cockpit schaust; Klick oeffnet den Chat. Dazu "(1) Cockpit"
  im Tab-Titel. Chat-Titel ohne "# " am Anfang.
- **Du musst pruefen** (nach dem Ausrollen): Benachrichtigung am Handy
  (PWA, https -- hier nur ueber http/localhost testbar); ein echter Chat am Handy und
  am PC; Diktieren ueber ein echtes Mikrofon (nur mit WAV-Datei getestet);
  die Desktop-App zeigt dieselbe Oberflaeche (Huelle unveraendert, kein
  Neubau noetig -- src-tauri nicht angefasst).
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
  - *Guthaben: kein Cockpit-Schalter* "Guthaben nutzen, wenn im Limit"
    (Plan): die echte Antwort meldet `umschaltbar:false`, und es griffe ins
    Balancing ein. Einschalten geht in claude.ai (die Nutzung verlinkt das).
    Offen: Prognose "Guthaben reicht noch X Tage" (braucht Verlauf).
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
    10-Minuten-Nutzungspuls bleibt, wie er ist. Mit echtem Konto geprueft
    (D10, Form siehe Ende-zu-Ende).

## API

Alle Endpunkte und WebSocket-Nachrichten stehen jetzt in README.md
(Abschnitt REST). Module: `src/chatOptionen.ts`, `src/freigaben.ts`,
`src/aufgaben.ts` (inkl. TaskBuch), `src/notizen.ts`, `src/nachrichten.ts`.

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

1. (erledigt D11) Ausrollen geprueft und live angesehen.
2. "Weitere sinnvolle Dinge": Benachrichtigung erledigt (D11). Offen:
   Chat umbenennen/anheften/aus Liste entfernen (nur Cockpit-Eintrag, nie
   die Datei), Tastenkuerzel (Strg+K gibt es schon; Esc stoppt fehlt).
3. Danach erneut ausrollen (2. von 3), wenn sich genug gesammelt hat.

## Ende-zu-Ende (D10, echte Konten, Haiku)

- Instanz: `/tmp/umbau/e2e/start.sh` (ohne CLAUDE_*-Variablen der Shell,
  eigene DB/Spiegel unter /tmp/umbau/e2e, Port 8796), per Playwright durch
  die Oberflaeche gefahren. 13 von 15 erlaubten Zuegen verbraucht.
- Geprueft und gut: neuer Chat, Fortsetzen, Freigabe (Bash, Erlauben),
  Plan-Modus (Karte, Umsetzen), Spezialist (pruefer, Karte), Abbrechen,
  **echter Kontowechsel** (haupt im Wochenlimit -> zweit, Hinweis im Chat),
  To-do-Liste live, Rueckfrage-Karte, Aufgaben-Bereich mit Liste und
  Spezialist, Team-Auftrag (Haiku, 1 Runde) mit Worker-Freigabe in Aufgaben.
- Guthaben echt: `{aktiv:false, umschaltbar:false, vomNutzerAus:false,
  jemalsAktiv:false, stand:null, verbraucht:0, waehrung:'USD'}` -> Anzeige
  "Guthaben aus" stimmt. Schalter bleibt weggelassen (siehe oben).
- Gefunden und behoben: Frage nach Kontowechsel doppelt; Modus blieb nach
  "Plan umsetzen" auf "Nur planen"; **TodoWrite gibt es in der CLI nicht
  mehr** (TaskCreate/TaskUpdate) -> Chat und Aufgaben zeigten keine Liste;
  Anhalten blieb auf "arbeitet" haengen und hiess "Fehler"; angehaltene
  Fragen ohne Kennzeichen; Handy-Eingabeleiste brach bei langem Pfad um;
  "Wartet auf deine Freigabe" bei einer Rueckfrage.
- Nicht erzwungen: ein Kontowechsel mitten im Zug (kam echt am Zuganfang).
- Hinweis: Plan-Modus legt Plaene im Konto-Verzeichnis ab
  (`<config>/plans/`), normales CLI-Verhalten.

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
  Danach Schritt 5 (Ende-zu-Ende, 13 Zuege, 7 Funde behoben, siehe oben);
  Playwright 52 Ansichten ohne Befund; Ausrollen angefordert (1. von 3).
- **D11** (25.9. 08:06): Ausrollen erfolgreich, live angesehen (s.o.).
  Chat-Titel ohne Markdown-Zeichen (Index-Version 3 baut einmal neu),
  Benachrichtigungen (`web/benachrichtigen.js`, Logik `web/ui/meldungen.js`
  mit Test, Klick im `sw.js`). Playwright 52 Ansichten ok.
