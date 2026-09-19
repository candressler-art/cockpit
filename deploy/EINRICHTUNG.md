# Cockpit auf serverone einrichten

Reihenfolge einhalten — Schritt 2 braucht einen Browser und ist der einzige,
der nicht ferngesteuert laufen kann.

## 1. Vorher prüfen: kein API-Schlüssel in der Umgebung

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'echo "${ANTHROPIC_API_KEY:-nicht gesetzt}"'
```

Steht dort ein Schlüssel, überstimmt er das Abo-Login, und jeder Lauf wird pro
Token abgerechnet statt gegen das Abo. Das muss vorher weg.

## 2. Claude Code auf dem Server anmelden

Auf dem Server ist die CLI installiert, aber es gibt dort kein `~/.claude`.
`setup-token` braucht einmalig einen Browser — der Server hat keinen, also
läuft der Befehl dort und die URL wird hier geöffnet.

```bash
ssh -t -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'claude setup-token'
```

Die angezeigte URL im Browser des Desktops öffnen, bestätigen, das ausgegebene
Token kopieren. Es ist etwa ein Jahr gültig.

Das Token gehört in eine Datei, nicht in eine Unit und nicht in den Chat:

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'sudo install -d -m 755 /etc/cockpit && sudo install -m 600 -o claude -g claude /dev/null /etc/cockpit/umgebung'
```

Dann den Inhalt hineinschreiben — die eine Zeile
`CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…` — am besten über eine lokale Datei:

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'sudo tee /etc/cockpit/umgebung > /dev/null' < ~/cockpit-token.txt
```

Die lokale Datei danach löschen.

**Bekannte Grenze:** Läuft das Token ab, gibt es einen 401 ohne automatischen
Ausweg (Issues #50743, #79685). Dann muss `setup-token` erneut interaktiv
laufen. Der Daemon meldet den Fall, statt still zu sterben.

## 3. Code auf den Server bringen

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'sudo install -d -o claude -g claude /opt/cockpit'
rsync -a --delete --exclude node_modules --exclude .git --exclude '*.db*' \
  -e 'ssh -i ~/.ssh/id_ed25519_claude' ~/projekte/cockpit/ claude@192.168.2.192:/opt/cockpit/
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'cd /opt/cockpit && npm ci --omit=dev && npm run build'
```

Node auf dem Server ist v22.23.2 — `node:sqlite` ist ab 22.5 verfügbar, das passt.

## 4. Dienst einrichten

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'sudo cp /opt/cockpit/deploy/cockpit.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now cockpit'
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'systemctl status cockpit --no-pager | head -15'
```

## 5. Über Tailscale erreichbar machen

Der Daemon bindet auf `127.0.0.1`. Nach außen kommt er nur über Tailscale —
kein Port steht im LAN offen, und die `docker-lan-guard`-Regeln bleiben
unberührt.

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'sudo tailscale serve --bg 8765'
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'sudo tailscale serve status'
```

Danach erreichbar unter `https://serverone.tail9c8a2b.ts.net` — vom Desktop,
vom Handy, von überall im Tailnet. **Kein `funnel`**: das würde den Dienst ins
offene Internet stellen.

Die Zertifikate von Tailscale gelten 90 Tage und werden automatisch erneuert,
solange `serve` läuft.

## 6. Desktop-App auf den Server zeigen lassen

```bash
COCKPIT_DAEMON=serverone.tail9c8a2b.ts.net cockpit
```

Ohne die Variable verbindet sich die App auf `127.0.0.1:8765`, also auf einen
lokal laufenden Daemon.

## Prüfen, dass es trägt

```bash
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'curl -s localhost:8765/api/gesundheit'
ssh -i ~/.ssh/id_ed25519_claude claude@192.168.2.192 'journalctl -u cockpit -n 30 --no-pager'
```

Vom Desktop aus, gegen den Tailnet-Namen:

```bash
curl -s https://serverone.tail9c8a2b.ts.net/api/gesundheit
```

Der dritte Test ist der eigentliche: ein Lauf starten, den Rechner zuklappen,
und vom Handy aus eine Freigabe erteilen.
