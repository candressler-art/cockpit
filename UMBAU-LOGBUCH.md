# Umbau-Logbuch (Branch `umbau-oberflaeche`)

## Zusammenfassung fuer Can

- **Stand:** Schritt 1 (Merge) erledigt, Schritt 2 (Backend) in Arbeit.
- **Fertig:** Einstellungen in der DB + `GET/POST /api/einstellungen`;
  Tests fuer den Nachrichten-Normalisierer; Nutzungsindex im Daemon
  (beim Start + alle 10 min) + `GET /api/nutzung?tage=` mit Kennzahlen;
  Rollen: `inherit` wird fuer Team-Worker zur Laufvorgabe, Orchestrator
  waehlt Rollen nach `einsatz` und schickt bei komplexen Auftraegen zuerst
  den Planer; `GET /api/verzeichnisse?pfad=&versteckte=1` (Ordnerwahl mit
  Favoriten + zuletzt benutzten). `/api/rollen` liefert symbol/farbe/einsatz
  schon (war vorhanden).
- **Du musst pruefen:** noch nichts (keine Oberflaeche geaendert).
- **Offen:** siehe "Naechste Schritte".
- **Entscheidungen fuer dich:** keine bisher.

## Naechste Schritte (Plan Schritt 2, Reihenfolge)

1. Chat-API: neu/fortsetzen mit Modell/Aufwand/Modus/agents/
   settingSources/Live-Text, Freigaben (immer/answers/Plan), Abbrechen.
   Einstieg: `src/supervisor.ts` agentStarten (Optionen), daemon.ts
   `/api/chats/:id/weiter` und `/api/lauf`; Einstellungen liefern die Vorgaben.
2. `/api/aufgaben` (TodoWrite je runId/agentId), Guthaben in kontenNutzung.
3. Danach Schritt 3 (Oberflaeche).

## Durchgaenge

- **D1** (24.9.): npm install, Merge nacht-optimierung, Einstellungen DB+API,
  Normalisierer-Tests, Nutzung angebunden -- vom Sitzungslimit mitten im
  Nutzungs-Commit abgebrochen, Logbuch fehlte noch.
- **D2**: sofort Sitzungslimit, nichts getan.
- **D3** (25.9. 02:21): Nutzung-Arbeit aus D1 geprueft (36/36) und
  committet, nacht-optimierung erneut gemergt (Konflikt nur Testliste in
  package.json), Logbuch angelegt.
  Danach: Rollen-Tests (tests/rollen.test.mjs), /api/verzeichnisse
  (tests/verzeichnisse.test.mjs), beides in der Testinstanz per curl geprueft.
