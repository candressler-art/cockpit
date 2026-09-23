# Stacks auf servertwo

Diese Dateien liegen auf dem Server unter `/opt/stacks/<name>/docker-compose.yml`
und stehen hier, damit nachvollziehbar bleibt, was dort laeuft und warum.

| Stack | Zweck | Port |
|---|---|---|
| `piper.yml` | Sprachausgabe (Wyoming-Protokoll) fuer `/api/sprechen` | 127.0.0.1:10200 |
| `whisper.yml` | Spracherkennung (Wyoming-Protokoll) fuer `/api/hoeren` | 127.0.0.1:10300 |
| `syncthing.yml` | holt Obsidian-Vault und Claude-Code-Sessions vom Desktop | 127.0.0.1:8384 |

Der Browser der Agenten hat bewusst KEINEN Stack: er laeuft je Sitzung als
eigener Container ueber `docker run --rm -i` und ist in `src/mcp.ts`
beschrieben. Der erste Versuch war ein Dauercontainer mit HTTP-Endpunkt --
der Playwright-Server antwortet darauf mit 403 (Schutz gegen DNS-Rebinding),
und die CLI meldete ihn als "needs authentication". Zwei Testlaeufe sind
genau daran mit einem Blocker stehengeblieben. Ueber stdio faellt das weg:
kein Port, keine Herkunftspruefung, keine Autorisierung.

## Warum alle nur auf 127.0.0.1 hoeren

Nach aussen geht ausschliesslich das Cockpit selbst, und zwar ueber
`tailscale serve` auf Port 8443. Piper, Whisper und Syncthing sind Zulieferer
des Daemons und brauchen keinen eigenen Weg dorthin. Die Syncthing-Oberflaeche
kann Ordnerpfade aendern -- sie gehoert erst recht nicht ins Netz.

## Einen Stack ausrollen

Es gibt dafuer (Stand heute) kein Skript -- `server-einrichten.sh` rollt nur
den Cockpit-Daemon selbst aus, keine Stacks. Ein neuer Stack (z.B. beim
erstmaligen Aufsetzen von `whisper.yml`) geht von Hand:

    ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 \
      "sudo mkdir -p /opt/stacks/whisper/data"
    ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 \
      "sudo tee /opt/stacks/whisper/docker-compose.yml >/dev/null" < deploy/stacks/whisper.yml
    ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.193 \
      "cd /opt/stacks/whisper && sudo docker compose up -d"

Das Bild ist rund 1 GB gross und muss beim ersten Start ausserdem das Modell
laden -- der erste `docker compose up -d` dauert deshalb spuerbar laenger als
jeder Neustart danach.

Erreichbar wird die Syncthing-Oberflaeche bei Bedarf ueber einen Tunnel:

    ssh -i ~/.ssh/id_ed25519_claude -L 8384:127.0.0.1:8384 claude@192.168.2.193

## Syncthing: Richtung und Rechte

Beide Ordner laufen auf dem Server als `receiveonly`. Der Spiegel darf nie
zurueckschreiben -- das Original steht auf dem Desktop.

`PUID/PGID 1001` ist der Agent-Benutzer `claude`. Ohne das gehoerten die
empfangenen Dateien root, und der Daemon koennte sie nicht lesen. Genau
dieser Fehler steckt im aelteren Vault-Spiegel auf serverone: er liegt unter
`/home/can/vault` und ist fuer `claude` nicht lesbar.

Servertwo baut die Verbindung zum Desktop selbst auf (feste Tailnet-Adresse
`tcp://100.81.96.81:22000`), eingehend steht hier nichts offen.

| Ordner-ID | Desktop | servertwo |
|---|---|---|
| `huhdx-v5wvf` | `~/Downloads/Claude` (sendreceive) | `/var/lib/cockpit/vault` |
| `cc-sessions` | `~/.claude/projects` (sendonly) | `/var/lib/cockpit/sessions-desktop` |
