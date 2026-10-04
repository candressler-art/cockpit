#!/usr/bin/env bash
# Zweites Konto (das des Freundes) ins Roblox-Cockpit holen, mit Obergrenzen.
# Auf servertwo als Benutzer claude aus einer normalen SSH-Sitzung starten
# (braucht sudo, also nicht aus dem Cockpit):
#   bash /opt/cockpit/deploy/roblox/freund-konto.sh [5h-Prozent] [Wochen-Prozent]
# Der Freund meldet sich waehrenddessen mit SEINEM Browser an und nennt den Code.
set -euo pipefail
FUENF="${1:-70}"; WOCHE="${2:-60}"
NAME=freund
DIR=/home/roblox/.claude-konten
ALS_ROBLOX=(sudo -u roblox -H env -C / )
CLI=/home/roblox/.local/bin/claude

echo "1/4  Ordner fuer das Konto"
"${ALS_ROBLOX[@]}" install -d -m 700 "$DIR" "$DIR/$NAME"

echo "2/4  Anmeldung -- der Freund oeffnet die Adresse unten, meldet sich an und nennt den Code"
"${ALS_ROBLOX[@]}" env CLAUDE_CONFIG_DIR="$DIR/$NAME" "$CLI" auth login
MAIL=$("${ALS_ROBLOX[@]}" env CLAUDE_CONFIG_DIR="$DIR/$NAME" "$CLI" auth status 2>/dev/null | grep -oP '"email":\s*"\K[^"]+' || true)
HAUPT=$("${ALS_ROBLOX[@]}" "$CLI" auth status 2>/dev/null | grep -oP '"email":\s*"\K[^"]+' || true)
[ -n "$MAIL" ] || { echo "FEHLER: Anmeldung nicht erkannt"; exit 1; }
[ "$MAIL" != "$HAUPT" ] || { echo "FEHLER: das ist dasselbe Konto wie Konto 2 ($HAUPT)"; exit 1; }
sudo chmod -R go-rwx "$DIR"
echo "     angemeldet als $MAIL"

echo "3/4  Roblox-Cockpit auf den Konten-Ordner umstellen"
sudo sed -i "s|^Environment=COCKPIT_KONTEN_DIR=.*|Environment=COCKPIT_KONTEN_DIR=$DIR|" /etc/systemd/system/cockpit-roblox.service
sudo systemctl daemon-reload
sudo systemctl restart cockpit-roblox
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:8766/api/konten >/dev/null && break; sleep 1; done

echo "4/4  Obergrenzen $FUENF % (5 Std.) / $WOCHE % (Woche)"
curl -sf -XPOST http://127.0.0.1:8766/api/konten/grenze -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"fuenf\":$FUENF,\"woche\":$WOCHE}" | grep -oP '"name":"[^"]+"|"grenze":\{[^}]*\}' | paste -sd' '
echo "Fertig. Nutzung im Roblox-Cockpit zeigt jetzt beide Konten."
