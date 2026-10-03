#!/usr/bin/env bash
# Syncthing fuer den Roblox-Vault einrichten (Teil von einrichten.sh).
#
# Laeuft als 'roblox':  sudo -u roblox -H bash /opt/cockpit/deploy/roblox/syncthing-einrichten.sh <phase>
#   vorher   Konfiguration erzeugen und anpassen (Dienst laeuft noch nicht)
#   nachher  Vault-Ordner anlegen (Dienst laeuft)

set -eu
ST=/usr/bin/syncthing
HEIM=/home/roblox/.config/syncthing
VAULT=/home/roblox/vault
cli() { "$ST" cli --home="$HEIM" "$@"; }

case "${1:-}" in
  vorher)
    mkdir -p "$VAULT"
    if [ ! -f "$HEIM/config.xml" ]; then
      "$ST" generate --home="$HEIM" >/dev/null
      # Kein Standardordner ~/Sync -- geteilt wird nur der Vault.
      sed -i '/<folder id="default"/,/<\/folder>/d' "$HEIM/config.xml"
      # Nur jetzt steht ausschliesslich das eigene Geraet drin: Namen setzen,
      # sonst heisst der Server in euren Syncthing-Listen nur "servertwo".
      sed -i 's|<device id="\([A-Z0-9-]*\)" name="[^"]*"|<device id="\1" name="servertwo-roblox"|' "$HEIM/config.xml"
    fi
    # Neben dem Syncthing-Container des Haupt-Cockpits: andere Ports. Keine
    # Suche im Heimnetz (die Netzsperre laesst sie ohnehin nicht durch),
    # Verbindungen ueber globale Suche und Relays.
    sed -i \
      -e 's|<address>127.0.0.1:[0-9]\+</address>|<address>127.0.0.1:8385</address>|' \
      -e 's|<listenAddress>default</listenAddress>|<listenAddress>tcp://:22001</listenAddress><listenAddress>quic://:22001</listenAddress><listenAddress>dynamic+https://relays.syncthing.net/endpoint</listenAddress>|' \
      -e 's|<localAnnounceEnabled>true</localAnnounceEnabled>|<localAnnounceEnabled>false</localAnnounceEnabled>|' \
      "$HEIM/config.xml"
    ;;
  nachher)
    for _ in $(seq 1 20); do cli show system >/dev/null 2>&1 && break; sleep 1; done
    if cli config folders list 2>/dev/null | grep -qx roblox-vault; then
      echo "Vault-Ordner schon eingerichtet"
    else
      cli config folders add --id roblox-vault --label Roblox-Vault --path "$VAULT"
      echo "Vault-Ordner eingerichtet"
    fi
    ;;
  *) echo "Aufruf: $0 vorher|nachher"; exit 2 ;;
esac
