# Roblox-Cockpit einrichten

Eine zweite Instanz des Cockpits auf servertwo, angemeldet mit **Konto 2**, nur
für Roblox-Spiele. Ihr nutzt sie zu zweit (du und dein Freund), beide mit vollem
Zugriff. Sie funktioniert wie das Haupt-Cockpit (Chats, Modelle, Freigaben,
Spezialisten, Team-Aufträge, Nutzung, Sprache), mit diesen Unterschieden:

| | Haupt-Cockpit | Roblox-Cockpit |
|---|---|---|
| Adresse | `https://servertwo.tail9c8a2b.ts.net:8443` | `https://servertwo.tail9c8a2b.ts.net:10000` |
| Linux-Benutzer | `claude` | `roblox` |
| Konto | Hauptkonto (+ Zusatzkonten) | nur Konto 2 |
| Bereiche | alle | ohne Notizen, Terminal, Server |
| Arbeitsordner | überall | nur `~/spiele/` (je Spiel ein Rojo-Projekt) |
| Spezialisten | `rollen/` | `varianten/roblox/rollen/` (Luau, Rojo, Exploit-Prüfung) |
| Desktop-Sessions, Vault | sichtbar | nicht vorhanden |

Gesteuert wird das über `COCKPIT_VARIANTE=roblox` (`src/variante.ts`,
`varianten/roblox/`). Ohne die Variable bleibt alles wie bisher.

## Warum ein eigener Benutzer

Das Cockpit hat keine Anmeldung. Bisher ist es nur deshalb geschützt, weil im
Tailnet nur du bist. Ein Agent im Roblox-Cockpit kann Befehle auf dem Server
ausführen. Liefe er als `claude`, könnte er die Anmeldung deines Hauptkontos
lesen, deinen Vault, deine SSH-Schlüssel, und per `curl` an das Haupt-Cockpit
auf `127.0.0.1:8765` einen Chat mit „Alles erlauben“ starten.

Deshalb drei Schichten:

1. **Benutzer `roblox`**: eigenes Home, kein sudo, nicht in der docker-Gruppe;
   `/home/claude`, `/var/lib/cockpit` und `/etc/cockpit` sind für ihn zu.
2. **systemd** (`cockpit-roblox.service`): blendet die übrigen Home-Verzeichnisse,
   `/var/lib/cockpit`, `/etc/cockpit` und `/opt/stacks` aus und setzt das
   System schreibgeschützt.
3. **Netzsperre** (`netz.nft`): `roblox` darf ins Internet, aber nicht ins
   Heimnetz, nicht ins Tailnet und auf dem Server nur an Sprache (Piper,
   Whisper, Vosk), das eigene Cockpit und den eigenen Rojo.

Das Einrichtungsskript prüft am Ende, dass all das wirklich gesperrt ist.

## 1. Ausrollen

Vom Desktop aus:

```bash
./deploy/server-einrichten.sh          # aktueller Code nach /opt/cockpit
./deploy/roblox/einrichten.sh          # Benutzer, Konto 2, Rojo, Dienst, Tailscale
```

Bei der Anmeldung (Schritt 5) **mit Konto 2 anmelden**, nicht mit dem
Hauptkonto. Das Skript bricht ab, wenn es dieselbe E-Mail wie das Hauptkonto
sieht.

### Konto 2 im Haupt-Cockpit abschalten?

Bisher nutzt das Haupt-Cockpit Konto 2 als Zusatzkonto (Balancing). Die
Anmeldung im Roblox-Cockpit ist eine eigene, beide funktionieren nebeneinander.
Das Haupt-Cockpit würde Konto 2 aber weiter mitbenutzen und damit euer
gemeinsames Kontingent verbrauchen, ohne dass dein Freund es sieht. Abschalten:

```bash
./deploy/roblox/einrichten.sh --aus-haupt <name>   # <name> wie unter ~/.claude-konten/
```

Das verschiebt das Konto nach `~/.claude-konten-aus/` und löscht dort nur die
Anmeldung. Zurück geht es mit `deploy/konto-hinzufuegen.sh <name>`.

## 2. Tailscale: Freund nur auf zwei Ports

Teilst du servertwo mit deinem Freund, sieht er ohne weitere Regel **alle**
Ports, also auch dein Haupt-Cockpit (8443). Deshalb zuerst die Policy, dann
teilen.

In der Tailscale-Admin-Konsole unter **Access controls** die Regeln so
anpassen (die IP gibt das Skript am Ende aus, oder `tailscale ip -4` auf
servertwo):

```jsonc
"acls": [
  // Deine eigenen Geräte: alles wie bisher.
  { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] },
  // Wer per Freigabe dazukommt: nur Roblox-Cockpit und Rojo auf servertwo.
  { "action": "accept", "src": ["autogroup:shared"], "dst": ["100.x.y.z:10000,34872"] },
],
```

Steht dort noch die Vorgabe-Regel mit `"src": ["*"]`, muss sie weg: `*`
schließt geteilte Nutzer mit ein. Hast du getaggte Geräte (`tag:…`), die
untereinander reden, brauchen die ihre eigene Regel. `autogroup:member`
umfasst nur Geräte von Personen.

Danach: **Machines → servertwo → Share…** und deinen Freund per E-Mail
einladen. Er installiert Tailscale, nimmt die Einladung an und öffnet
`https://servertwo.tail9c8a2b.ts.net:10000`.

Gegenprobe von seinem Rechner: `https://servertwo.tail9c8a2b.ts.net:8443`
darf **nicht** laden.

## 3. Roblox Studio verbinden (Rojo)

Einmalig je PC:

1. In Roblox Studio das **Rojo**-Plugin installieren (Creator Store, Autor
   „Rojo“). Die Plugin-Version muss zur Rojo-Version auf dem Server passen
   (`rojo --version`, gleiche Hauptversion, z.B. 7.x).
2. Tailscale muss auf dem PC laufen.

Für jedes Spiel:

1. Im Roblox-Cockpit sagen, an welchem Spiel ihr arbeitet. Claude startet
   dann `rojo-sync ~/spiele/<spiel>`.
2. In Studio einen leeren Ort öffnen (Baseplate), im Rojo-Plugin als Adresse
   `servertwo.tail9c8a2b.ts.net` und Port `34872` eintragen, **Connect**.
3. Ab jetzt landet jede Änderung, die Claude speichert, sofort in Studio.

Es gibt nur **einen** Sync gleichzeitig. Wollt ihr parallel an zwei
verschiedenen Spielen arbeiten, verbindet sich nur eins live; das andere
lässt sich mit `rojo build` als `.rbxlx` bauen. Die Datei liegt dann auf dem
Server, und Claude kann sagen, wo.

Was Rojo nicht abdeckt (Terrain, frei gebaute Modelle, Studio-Einstellungen),
baut ihr in Studio selbst. Damit das beim nächsten Sync nicht verloren geht,
gehört es nicht in die Ordner, die Rojo verwaltet.

## Betrieb

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 'journalctl -u cockpit-roblox -f'   # Logs
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 'sudo systemctl restart cockpit-roblox'
```

Nach jedem `./deploy/server-einrichten.sh` läuft das Roblox-Cockpit noch mit
dem alten Code weiter, bis es neu startet. Am einfachsten
`./deploy/roblox/einrichten.sh` erneut laufen lassen: es ist wiederholbar und
startet den Dienst neu.

Das Roblox-Cockpit bekommt weniger CPU-Gewicht als das Haupt-Cockpit und
höchstens 3 GB Speicher (`cockpit-roblox.service`), damit ein ausufernder
Lauf servertwo nicht lahmlegt.
