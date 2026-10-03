#!/usr/bin/env bash
# Netzsperre fuer 'roblox' (netz.nft) nach /etc/cockpit-roblox/ bringen und
# laden -- mit der Ausnahme fuer den PC, falls einer in
# /etc/cockpit-roblox/umgebung steht (COCKPIT_PC_HOST, von pc-einrichten.sh).
#
# Laeuft als root auf servertwo:  sudo bash /opt/cockpit/deploy/roblox/netz-anwenden.sh
# Aufgerufen von einrichten.sh und pc-einrichten.sh.

set -eu
QUELLE=/opt/cockpit/deploy/roblox/netz.nft
ZIEL=/etc/cockpit-roblox/netz.nft
install -d -m 755 /etc/cockpit-roblox
# Nur eine nackte IPv4-Adresse: alles andere hat in einer nft-Regel nichts zu suchen.
PC=$(grep -oP '^COCKPIT_PC_HOST=\K[0-9]{1,3}(\.[0-9]{1,3}){3}$' /etc/cockpit-roblox/umgebung 2>/dev/null || true)
if [ -n "$PC" ]; then
  sed "s|# PC-AUSNAHME|ip daddr $PC tcp dport 22 accept|" "$QUELLE" > "$ZIEL.neu"
else
  cp "$QUELLE" "$ZIEL.neu"
fi
nft -c -f "$ZIEL.neu"
mv "$ZIEL.neu" "$ZIEL"
chmod 644 "$ZIEL"
# Laeuft die Sperre schon, sofort neu laden (die Tabelle wird dabei ersetzt).
if systemctl is-active --quiet cockpit-roblox-netz; then nft -f "$ZIEL"; fi
echo "Netzsperre geprueft${PC:+, PC $PC erlaubt (SSH)}"
