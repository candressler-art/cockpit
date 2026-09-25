# Umbau-Logbuch (Branch `umbau-oberflaeche`)

## Zusammenfassung fuer Can

- **Stand:** Schritt 1 (Merge) und Schritt 2 (Backend) erledigt. Als
  Naechstes Schritt 3 (Oberflaeche).
- **Fertig (Backend):** Einstellungen in der DB + API; Nutzungsindex +
  `/api/nutzung`; Rollen (`inherit`, Planer-Regel); `/api/verzeichnisse`;
  **Chat-API** (neuer Chat, Weiterschreiben mit Modell/Aufwand/Modus,
  Spezialisten als Subagenten, CLAUDE.md/Skills laden, Live-Text, Freigaben
  mit "immer erlauben", Antworten auf Rueckfragen, Plan annehmen);
  **`/api/aufgaben`** (To-do-Listen und Spezialisten aller Agenten);
  **Nutzungsguthaben** in `/api/konten` (nur Anzeige).
- **Du musst pruefen:** noch nichts (keine Oberflaeche geaendert).
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
- `GET /api/konten` hat jetzt `guthaben: {konto: {aktiv, stand, ...}}`.
- Gebaut in `src/chatOptionen.ts`, `src/freigaben.ts`, `src/aufgaben.ts`.

## Naechste Schritte

1. Schritt 3: Grundgeruest (Seitenleiste, Router), dann Chat (Markdown mit
   marked+DOMPurify+highlight.js nach web/vendor), Einstellungen, Nutzung,
   Aufgaben, Server, Notizen, Terminal -- je Playwright 1280/375 px.
2. Schritt 4 Aufraeumen, README; Schritt 5 Ende-zu-Ende mit Haiku.

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
