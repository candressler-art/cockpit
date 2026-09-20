# Discord einrichten

Der Bot verbindet sich **ausgehend** zum Discord-Gateway. Der Daemon braucht
dafür keinen offenen Port und bleibt im Tailnet unerreichbar wie zuvor. Dein
Handy braucht kein VPN — nur die Discord-App.

## Was Discord kann und was nicht

Discord erlaubt 2000 Zeichen je Nachricht und rund fünf Nachrichten pro Sekunde
und Kanal. Ein Live-Log mit mehreren parallelen Workern sprengt das binnen
Sekunden. Deshalb geht hierher nur, was eine Handlung verlangt oder den Zustand
ändert:

| Was | Wohin |
|---|---|
| Lauf beginnt | Nachricht im Kanal, darunter ein eigener Thread |
| Rundenbeginn, gewählter Fall, Blocker | in den Thread |
| Freigabe nötig | Nachricht mit den Knöpfen **Erlauben** / **Ablehnen** |
| Entscheidung nötig (Fall B) | eigene Nachricht, du antwortest per Reply |
| Lauf endet | Zusammenfassung mit Verbrauch |
| Fehler, abgelaufene Anmeldung | Warnung im Kanal |

Der vollständige Ereignisstrom bleibt in der App und in der Datenbank.

## Bot anlegen

1. <https://discord.com/developers/applications> → **New Application**, Namen
   vergeben (z. B. `Cockpit`).
2. Links **Bot** → **Reset Token** → Token kopieren. Er wird nur einmal
   angezeigt.
3. Auf derselben Seite **Message Content Intent** einschalten. Ohne ihn kommen
   deine Antworten auf Entscheidungsfragen leer an.
4. Links **OAuth2** → **URL Generator** → Scope `bot`. Diese sieben
   Berechtigungen anhaken:

   | Berechtigung | wofür |
   |---|---|
   | Kanäle ansehen | überhaupt in den Kanal sehen |
   | Nachrichten senden | Status und Fragen |
   | **Links einbetten** | **ohne das erscheint keine einzige formatierte Nachricht — kommentarlos** |
   | Nachrichtenverlauf anzeigen | Antworten per Reply zuordnen |
   | Reaktionen hinzufügen | Bestätigung, dass eine Antwort ankam |
   | Öffentliche Threads erstellen | ein Thread je Lauf |
   | Nachrichten in Threads senden | Protokollschritte dorthin |

   Das entspricht `permissions=309237730368`. Die erzeugte URL öffnen und den
   Bot auf deinen Server einladen.
5. In Discord die Kanal-ID holen: Einstellungen → Erweitert →
   Entwicklermodus an, dann Rechtsklick auf den Kanal → **Kanal-ID kopieren**.

## Auf dem Server eintragen

Die Werte gehören in `/etc/cockpit/umgebung` (600, `claude:claude`) — nicht in
die Unit und nicht in den Chat:

```
COCKPIT_DISCORD_TOKEN=...
COCKPIT_DISCORD_KANAL=...
COCKPIT_DISCORD_BENUTZER=<deine Discord-Benutzer-ID>
COCKPIT_DISCORD_CWD=/home/claude/projekte/…
```

`COCKPIT_DISCORD_BENUTZER` ist eine Kommaliste. Ist sie leer, darf **jeder im
Kanal** Läufe starten und Freigaben erteilen — auf einem privaten Server
vertretbar, sonst nicht. Deine eigene ID bekommst du per Rechtsklick auf dich
selbst → **Benutzer-ID kopieren**.

`COCKPIT_DISCORD_CWD` begrenzt, in welchem Verzeichnis ein per Discord
gestarteter Lauf arbeitet. Absichtlich nicht über die Nachricht wählbar.

Eintragen und neu starten mit:

```bash
~/projekte/cockpit/deploy/discord-einrichten.sh
```

## Bedienung

| Eingabe | Wirkung |
|---|---|
| `!lauf <Auftrag>` | startet einen Orchestrator-Lauf im konfigurierten Verzeichnis |
| `!status` | die letzten fünf Läufe mit Zustand und Verbrauch |
| `!stop` | bricht den zuletzt gestarteten Lauf ab |
| `!stop <run-id>` | bricht einen bestimmten Lauf ab |
| Knopf **Erlauben** / **Ablehnen** | entscheidet eine Freigabe |
| Reply auf eine Frage | beantwortet Fall B, der Lauf läuft weiter |

Bewusst keine Slash-Befehle: die müssen registriert werden, brauchen zusätzliche
Rechte und bringen hier nichts, was ein Präfix nicht auch leistet.

## Der wichtigste Teil

Bei Fall B **wartet** der Lauf jetzt auf deine Antwort, bis zu acht Stunden —
er bricht nicht mehr ab. Das ist der Grund, warum unbeaufsichtigtes Arbeiten
überhaupt funktioniert: Eine Frage hält den Lauf an, sie beendet ihn nicht.
Deine Antwort geht zusammen mit der Frage als nächster Auftrag an den Worker,
damit ihm der Zusammenhang nicht fehlt.
