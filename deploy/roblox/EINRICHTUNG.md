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
| Bereiche | alle | ohne Terminal und Server, dafür **PC** (aufwecken/herunterfahren) |
| Arbeitsordner | überall | nur `~/spiele/` (je Spiel ein Rojo-Projekt) |
| Spezialisten | `rollen/` | `varianten/roblox/rollen/` (Luau, Rojo, Exploit-Prüfung, 3D-Modellierer mit Blender) |
| Vault | dein Vault, nur lesend | eigener **Roblox-Vault**, Claude schreibt hinein; per Syncthing in Obsidian |
| Desktop-Sessions | sichtbar | nicht vorhanden |

## Worauf Konto 2 Zugriff hat

| Darf | Darf nicht |
|---|---|
| Spiele unter `/home/roblox/spiele`, den Roblox-Vault `/home/roblox/vault` | `/home/claude`, deine SSH-Schlüssel, die Anmeldung deines Hauptkontos |
| das Internet (Anthropic, Roblox-Doku, Pakete, Syncthing-Relays) | dein Vault, deine Chats, dein Haupt-Cockpit (auch nicht über `127.0.0.1:8765`) |
| Sprache (Piper, Whisper, Vosk) auf dem Server | Heimnetz, andere Geräte im Tailnet, Docker, sudo |
| auf deinem PC: **nur** Herunterfahren und den Blender-Tunnel (je ein eigener, eingeschränkter Schlüssel) | auf deinem PC eine Shell, Dateien, andere Ports |
| Blender auf deinem PC, **solange es verbunden ist** (siehe unten) | die eigene Cockpit-API (sonst könnte ein Agent den PC ausschalten) |

Dein Freund bekommt nie Passwort oder Zugangsschlüssel von Konto 2, er arbeitet
nur über das Cockpit. Dein Haupt-Cockpit nutzt Konto 2 nur, wenn du den
Schalter umlegst (siehe unten).

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
   Whisper, Vosk), den eigenen Rojo, das eigene Syncthing und den
   Blender-Tunnel. Einzige Ausnahme im Heimnetz: SSH zu deinem PC (für
   Herunterfahren und Blender) und das Wake-on-LAN-Paket.

Das Einrichtungsskript prüft am Ende, dass all das wirklich gesperrt ist.

## 1. Ausrollen

### Vom Mac aus

Die beiden Server-Skripte laufen auch auf dem Mac. Nur `pc-einrichten.sh`
gehört auf den Linux-Desktop (Schritt 4), weil es genau den Rechner
einrichtet, auf dem es läuft.

Einmalig auf dem Mac:

```bash
xcode-select --install                 # git, falls noch nicht da
brew install node                      # Node 22 oder neuer (node --version)
git clone https://github.com/candressler-art/cockpit.git ~/cockpit
cd ~/cockpit && git checkout claude/nifty-wozniak-6o2fls
```

Der Mac braucht denselben SSH-Schlüssel wie der Desktop, um auf servertwo zu
kommen. Am einfachsten vom Desktop kopieren:

```bash
# am Mac, Desktop-Adresse anpassen:
scp <du>@<desktop>:.ssh/id_ed25519_claude ~/.ssh/ && chmod 600 ~/.ssh/id_ed25519_claude
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 true && echo "SSH geht"
```

Die Skripte sprechen den Server unter `192.168.2.193` an, also im Heimnetz.
Bist du unterwegs, mit Tailscale auf dem Mac:
`export COCKPIT_SERVER=servertwo.tail9c8a2b.ts.net`.

Danach wie unten, im Ordner `~/cockpit`. Das Anmeldefenster öffnet sich auf
dem Mac im Standardbrowser.

### Die Skripte

```bash
./deploy/server-einrichten.sh          # aktueller Code nach /opt/cockpit
./deploy/roblox/einrichten.sh          # Benutzer, Konto 2, Rojo, Dienst, Tailscale
```

Bei der Anmeldung (Schritt 5) **mit Konto 2 anmelden**, nicht mit dem
Hauptkonto. Das Skript bricht ab, wenn es dieselbe E-Mail wie das Hauptkonto
sieht.

### Konto 2 im Haupt-Cockpit: nur per Schalter

Bisher nutzt das Haupt-Cockpit Konto 2 als Zusatzkonto (Balancing). Findet
das Skript Konto 2 dort (gleiche E-Mail), markiert es das Konto als
**geteilt** (Datei `cockpit-geteilt` im Kontoverzeichnis). Ab dann nimmt das
Haupt-Cockpit Konto 2 **standardmäßig nicht mehr**, auch nicht, wenn das
Hauptkonto im Limit ist, und auch nicht über „Bevorzugen“.

Brauchst du Konto 2 doch einmal im Haupt-Cockpit: **Nutzung → Karte des
Kontos → „Auch in diesem Cockpit nutzen“** einschalten. Zurück geht es mit
demselben Schalter. Die Anmeldung bleibt dabei bestehen; die beiden
Anmeldungen (Haupt-Cockpit und Roblox-Cockpit) sind unabhängig voneinander.

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

## 3. So kommt ihr ins Roblox-Cockpit

Auf jedem Gerät muss Tailscale laufen (beim Freund: mit angenommener Freigabe).

- **Browser** (PC und Handy): `https://servertwo.tail9c8a2b.ts.net:10000`
- **Als App aufs Handy**: Seite öffnen → „Zum Startbildschirm hinzufügen“
  (iPhone: Teilen-Knopf → „Zum Home-Bildschirm“). Sie heißt „Roblox-Cockpit“.
- **Deine Desktop-App**: `COCKPIT_DAEMON=servertwo.tail9c8a2b.ts.net:10000 cockpit-start`

### Benachrichtigungen aufs Handy

Das Cockpit meldet sich, wenn Claude fertig ist, eine Freigabe oder Frage
wartet, ein Team-Auftrag endet, und wenn jemand den PC weckt oder
herunterfährt, auch wenn die App zu ist (z.B. in der Schule):

1. Roblox-Cockpit als App auf den Startbildschirm (beim iPhone geht Push
   nur so).
2. In der App: **Einstellungen → Benachrichtigungen** einschalten und
   erlauben.

Die Meldungen laufen über Apple bzw. Google, also auch ohne Heimnetz. Antippen
öffnet das Cockpit, dafür muss Tailscale auf dem Handy an sein. Alle, die
Benachrichtigungen eingeschaltet haben, bekommen alle Meldungen des
Roblox-Cockpits.

## 4. Deinen PC einrichten (Aufwecken, Herunterfahren, Blender, Vault)

Am **Linux-Desktop** (nicht am Mac), nachdem `einrichten.sh` durch ist:

```bash
cd ~/projekte/cockpit && git fetch && git checkout claude/nifty-wozniak-6o2fls
./deploy/roblox/pc-einrichten.sh
```

Sitzt du am Mac, geht es auch per SSH auf den Desktop, das Skript fragt
zwischendurch nach deinem sudo-Passwort:
`ssh -t <du>@<desktop> 'cd ~/projekte/cockpit && ./deploy/roblox/pc-einrichten.sh'`

Das Skript:

- schaltet **Wake-on-LAN** an. Im BIOS/UEFI muss es zusätzlich an sein, und
  der PC muss per Kabel im selben Heimnetz hängen wie servertwo.
- trägt zwei **eingeschränkte Schlüssel** des Servers in
  `~/.ssh/authorized_keys` ein: einer darf nur `systemctl poweroff`, der
  andere nur die Weiterleitung zu Blender (keine Shell). Beide nur von
  servertwo aus. Dazu kommt eine sudo-Regel, die genau `systemctl poweroff`
  ohne Passwort erlaubt.
- meldet den PC beim Server an. Danach erscheint im Roblox-Cockpit der
  Bereich **PC** mit „Aufwecken“ und „Herunterfahren“, für dich und deinen
  Freund. Wer schaltet, löst beim anderen eine Benachrichtigung aus.
- richtet Blender mit dem **blender-mcp**-Addon ein (siehe unten).
- teilt den **Roblox-Vault** per Syncthing nach `~/Roblox-Vault`.

Rückgängig: die zwei Zeilen mit `cockpit-roblox-` aus
`~/.ssh/authorized_keys` löschen, `/etc/sudoers.d/cockpit-pc-aus` entfernen.

### Blender (3D-Modellierer)

Der Spezialist **3D-Modellierer** steuert Blender live auf deinem PC: Szene
ansehen, Python in Blender ausführen, Viewport-Bildschirmfoto. Fertige
Objekte exportiert er als FBX nach `~/Roblox-Vault/Modelle/<spiel>/`. Über den
Vault landen sie auch beim Freund; in Studio: **Datei → Import 3D**.

Zum Arbeiten: PC an (notfalls im Cockpit aufwecken), Blender öffnen, Taste
**N** → Reiter **BlenderMCP** → **Connect to Claude**.

**Wichtig:** Solange Blender verbunden ist, kann Claude dort beliebigen
Python-Code ausführen, also auf deinem PC mit den Rechten von Blender. Wer
im Roblox-Cockpit schreibt, also auch dein Freund, kann Claude dazu bringen.
Deshalb bietet `pc-einrichten.sh` Blender als **Flatpak** an, das nur
`~/Roblox-Vault` sieht und nicht dein Home mit SSH-Schlüsseln und Vault.
Verbinde Blender nur, wenn ihr gerade modelliert, und trenne danach.

Roblox Studio unter Linux läuft über [Vinegar](https://vinegarhq.org)
(Flatpak `org.vinegarhq.Vinegar`).

### Roblox-Vault in Obsidian

Claude hält im Roblox-Vault alles fest: je Spiel eine Notiz mit Idee, Stand
und offenen Punkten, Entscheidungen, Anleitungen. Ihr seht ihn

- im Cockpit unter **Notizen**,
- in Obsidian: **Ordner als Vault öffnen → `~/Roblox-Vault`**.

Für den PC und das Handy deines Freundes: Er installiert Syncthing (Android:
„Syncthing-Fork“; iPhone: „Möbius Sync“), schickt dir seine Geräte-ID, und
du gibst den Vault frei, oder er bittet Claude im Roblox-Cockpit darum:

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 \
  'sudo -u roblox -H /home/roblox/.local/bin/vault-teilen <GERÄTE-ID> freund-handy'
```

Er nimmt dann in Syncthing das Gerät „servertwo-roblox“ und den Ordner
„Roblox-Vault“ an. Die Verbindung läuft über die Syncthing-Relays, verschlüsselt,
ohne Heimnetz oder Tailnet.

## 5. Roblox Studio verbinden (Rojo)

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
# Blender-Tunnel und Vault-Syncthing:
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 'journalctl -u cockpit-roblox-blender -u cockpit-roblox-syncthing -n 30'
```

Nach jedem `./deploy/server-einrichten.sh` läuft das Roblox-Cockpit noch mit
dem alten Code weiter, bis es neu startet. Am einfachsten
`./deploy/roblox/einrichten.sh` erneut laufen lassen: es ist wiederholbar und
startet den Dienst neu.

Das Roblox-Cockpit bekommt weniger CPU-Gewicht als das Haupt-Cockpit und
höchstens 3 GB Speicher (`cockpit-roblox.service`), damit ein ausufernder
Lauf servertwo nicht lahmlegt.
