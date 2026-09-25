# Umbau-Logbuch (Branch `umbau-oberflaeche`)

## Zusammenfassung fuer Can

- **Stand:** Schritt 1 (Merge) erledigt, Schritt 2 (Backend) in Arbeit.
- **Fertig:** Einstellungen in der DB + `GET/POST /api/einstellungen`;
  Tests fuer den Nachrichten-Normalisierer; Nutzungsindex im Daemon
  (beim Start + alle 10 min) + `GET /api/nutzung?tage=` mit Kennzahlen.
- **Du musst pruefen:** noch nichts (keine Oberflaeche geaendert).
- **Offen:** siehe "Naechste Schritte".
- **Entscheidungen fuer dich:** keine bisher.

## Naechste Schritte (Plan Schritt 2, Reihenfolge)

1. Rollen: `modell: inherit` im Orchestrator aufloesen, Tests fuer
   `agentDefinitionen`, `/api/rollen` mit symbol/farbe/einsatz.
2. `/api/verzeichnisse` (Ordner durchsuchen, Favoriten, zuletzt benutzt).
3. Chat-API: neu/fortsetzen mit Modell/Aufwand/Modus/agents/
   settingSources/Live-Text, Freigaben (immer/answers/Plan), Abbrechen.
4. `/api/aufgaben` (TodoWrite je runId/agentId), Guthaben in kontenNutzung.
5. Danach Schritt 3 (Oberflaeche).

## Durchgaenge

- **D1** (24.9.): npm install, Merge nacht-optimierung, Einstellungen DB+API,
  Normalisierer-Tests, Nutzung angebunden -- vom Sitzungslimit mitten im
  Nutzungs-Commit abgebrochen, Logbuch fehlte noch.
- **D2**: sofort Sitzungslimit, nichts getan.
- **D3** (25.9. 02:21): Nutzung-Arbeit aus D1 geprueft (36/36) und
  committet, nacht-optimierung erneut gemergt (Konflikt nur Testliste in
  package.json), Logbuch angelegt.
