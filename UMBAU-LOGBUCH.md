# Umbau-Logbuch (Branch `umbau-oberflaeche`)

## Zusammenfassung fuer Can

- **Stand:** Schritte 1-6 erledigt: alle Bereiche gebaut (Chat,
  Aufgaben, Nutzung, Server, Notizen, Terminal, Einstellungen), alte
  Oberflaeche entfernt, README neu, Ende-zu-Ende mit echten Haiku-Zuegen
  bestanden (14 Zuege). **Umbau abgeschlossen (D14).** Ausgerollt am
  25.9. 08:05 (c202fde) und nochmals **08:38 (cb3c993, Stand von D13)**,
  Dienst gesund, Sicherungen `~/schleife/sicherung-20260925-080518` und
  `~/schleife/sicherung-20260925-083805`. Live ist jetzt alles unten
  Beschriebene.
- **Fertig (Backend):** Einstellungen in der DB + API; Nutzungsindex +
  `/api/nutzung`; Rollen (`inherit`, Planer-Regel); `/api/verzeichnisse`;
  **Chat-API** (neuer Chat, Weiterschreiben mit Modell/Aufwand/Modus,
  Spezialisten als Subagenten, CLAUDE.md/Skills laden, Live-Text, Freigaben
  mit "immer erlauben", Antworten auf Rueckfragen, Plan annehmen);
  **`/api/aufgaben`** (To-do-Listen und Spezialisten aller Agenten);
  **Nutzungsguthaben** in `/api/konten` (nur Anzeige).
- **Neu im 2. Ausrollen (D11-D13, live seit 08:38):** Benachrichtigungen
  (Einstellungen > "Stimme und Benachrichtigungen", je Geraet einschalten):
  Chat fertig/Fehler, Freigabe, Rueckfrage, Plan, Team-Auftrag -- nur wenn
  du nicht ins Cockpit schaust; Klick oeffnet den Chat. Dazu "(1) Cockpit"
  im Tab-Titel. Chat-Titel ohne "# " am Anfang.
  **Chats umbenennen, anheften, aus der Liste nehmen** (D12): "…" am
  Eintrag (Maus: bei Hover; Handy: immer sichtbar). Nur der
  Cockpit-Eintrag, die Sitzungsdatei bleibt; "Rueckgaengig" direkt in der
  Liste; ein ausgeblendeter Chat kommt zurueck, sobald darin
  weitergeschrieben wird (z.B. am PC). Umbenannte Titel findet die Suche.
  **Dateien und Bilder anhaengen** (D13): Bueroklammer in der Eingabe,
  hineinziehen oder einfuegen (Strg+V, z.B. Bildschirmfoto), bis 10 Dateien
  je 20 MB. Liegen auf dem Server unter `/var/lib/cockpit/anhaenge/<Datum>/`
  (nach 30 Tagen weg); Claude liest sie mit Read ohne Freigabe, sonst
  nichts ohne Freigabe. Bilder erscheinen als Vorschau in deiner Blase.
- **Live gesehen (D14, nur GET, POSTs im Browser blockiert):** alle 7
  Bereiche bei 1280 und 375 px ohne Konsolenfehler/Ueberbreite; das
  "…"-Menue der Chatliste (Anheften/Umbenennen/Aus der Liste nehmen) auch
  in der Handy-Schublade; Bueroklammer in der Eingabe; Einstellungen mit
  "Benachrichtigungen" (headless: "Im Browser blockiert", erwartungsgemaess).
- **Tastenkuerzel:** Strg+K Chatsuche, Esc haelt einen laufenden Chat an,
  Esc schliesst Menue/Umbenennen.
- **Am PC zu tun:** nichts zu bauen (src-tauri nie angefasst).
- **Du musst pruefen:** Benachrichtigung am Handy
  (PWA, https -- hier nur ueber http/localhost testbar); ein echter Chat am Handy und
  am PC; Diktieren ueber ein echtes Mikrofon (nur mit WAV-Datei getestet);
  ein Anhang ueber dein Tailnet (falls ein Proxy davorsitzt, darf er
  20 MB Koerper nicht abweisen -- lokal getestet, nicht ueber den Proxy);
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
  - *Anhaenge als Datei + Pfad statt Bild-Block*: der Prompt geht als Text
    an die SDK (und wird beim Kontowechsel neu gebaut); Read zeigt dem
    Modell Bilder/PDFs genauso. Vorteil: Anhaenge ueberstehen Kontowechsel
    und bleiben in der Sitzung am PC nachvollziehbar.
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

Keine. Plan (Schritte 1-6, weitere Dinge 1-4) erledigt, `.umbau-fertig`
gesetzt. Moegliche spaetere Idee: Prognose "Guthaben reicht noch X Tage"
(braucht Verlauf; Guthaben ist bei dir ohnehin aus).

## Ende-zu-Ende (D10, echte Konten, Haiku)

- Instanz: `/tmp/umbau/e2e/start.sh` (ohne CLAUDE_*-Variablen der Shell,
  eigene DB/Spiegel unter /tmp/umbau/e2e, Port 8796), per Playwright durch
  die Oberflaeche gefahren. 14 von 15 erlaubten Zuegen verbraucht (14.: Anhang in D13).
- Geprueft und gut: neuer Chat, Fortsetzen, Freigabe (Bash, Erlauben),
  Plan-Modus (Karte, Umsetzen), Spezialist (pruefer, Karte), Abbrechen,
  **echter Kontowechsel** (haupt im Wochenlimit -> zweit, Hinweis im Chat),
  To-do-Liste live, Rueckfrage-Karte, Aufgaben-Bereich mit Liste und
  Spezialist, Team-Auftrag (Haiku, 1 Runde) mit Worker-Freigabe in Aufgaben.
- Guthaben echt: `{aktiv:false, umschaltbar:false, vomNutzerAus:false,
  jemalsAktiv:false, stand:null, verbraucht:0, waehrung:'USD'}` -> Anzeige
  "Guthaben aus" stimmt. Schalter bleibt weggelassen (siehe oben).
- 7 Funde dabei behoben (Details in den Commits von D10).
- Nicht erzwungen: ein Kontowechsel mitten im Zug (kam echt am Zuganfang).

## Durchgaenge

- **D1-D10** (24./25.9.): Merge, Backend, alle Bereiche, Aufraeumen
  (Schritt 4), Ende-zu-Ende (Schritt 5), 1. Ausrollen angefordert.
  Testkonten `zweit`/`dritt` mit kuenstlichen Messwerten in
  /tmp/umbau/cockpit.db.
- **D11-D13** (25.9.): Benachrichtigungen, Chats umbenennen/anheften/
  ausblenden, Anhaenge (echter Haiku-Zug), je 52 Playwright-Ansichten ok,
  2. Ausrollen angefordert.
- **D14** (25.9. 08:39): nacht-optimierung ohne neue Commits. 2. Ausrollen
  erfolgreich, live angesehen (16 Ansichten ok, s.o.). Umbau abgeschlossen.
