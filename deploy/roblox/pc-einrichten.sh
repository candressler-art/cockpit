#!/usr/bin/env bash
# Richtet DEINEN PC (Linux) fuer das Roblox-Cockpit ein. Auf dem PC ausfuehren,
# nachdem deploy/roblox/einrichten.sh auf dem Server durchgelaufen ist:
#
#   ./deploy/roblox/pc-einrichten.sh
#
# Was danach geht:
#   - Aufwecken (Wake-on-LAN) und Herunterfahren aus dem Roblox-Cockpit,
#     fuer dich und deinen Freund (Bereich "PC"),
#   - Blender live aus dem Cockpit steuern (3D-Modellierer, blender-mcp),
#   - der Roblox-Vault als Ordner ~/Roblox-Vault (Obsidian, Modelle fuer Studio).
#
# Der Server bekommt KEINEN normalen Zugang zu diesem PC. Seine zwei
# Schluessel stehen hier in ~/.ssh/authorized_keys mit Einschraenkungen:
#   pc_aus      darf nur "sudo systemctl poweroff" ausloesen, sonst nichts,
#   pc_blender  darf nur eine Weiterleitung auf 127.0.0.1:9876 (Blender), keine Shell.
# Beide nur vom Server aus (from=...). Rueckgaengig: die zwei Zeilen mit
# "cockpit-roblox-" aus ~/.ssh/authorized_keys loeschen und
# /etc/sudoers.d/cockpit-pc-aus entfernen.
#
# Wiederholbar. Kein `set -e`: jeder Schritt meldet sich selbst.

set -u

SERVER="${COCKPIT_SERVER:-192.168.2.193}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")
VAULT_PC="$HOME/Roblox-Vault"
FEHLER=0

schritt() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()      { printf '   ok    %s\n' "$1"; }
warn()    { printf '   warn  %s\n' "$1"; }
fehlt()   { printf '   FEHLT %s\n' "$1"; FEHLER=$((FEHLER+1)); }
frage()   { local a; read -r -p "   $1 [j/N] " a; [ "$a" = j ] || [ "$a" = J ]; }

# --- 1. Server und Netz ----------------------------------------------------------
schritt "1/6  Server und Netzwerk dieses PCs"
if "${SSH[@]}" 'id roblox >/dev/null 2>&1 && test -f /home/roblox/.ssh/pc_aus.pub' 2>/dev/null; then
  ok "Server ist eingerichtet"
else
  fehlt "Server nicht bereit -- erst ./deploy/roblox/einrichten.sh"; exit 1
fi
ROUTE=$(ip -4 route get "$SERVER" 2>/dev/null)
DEV=$(printf '%s' "$ROUTE" | grep -oP 'dev \K\S+')
PC_IP=$(printf '%s' "$ROUTE" | grep -oP 'src \K[0-9.]+')
MAC=$(cat "/sys/class/net/$DEV/address" 2>/dev/null)
if [ -z "$DEV" ] || [ -z "$PC_IP" ] || [ -z "$MAC" ]; then
  fehlt "Netzwerkkarte zum Server nicht gefunden"; exit 1
fi
ok "Netzwerk: $DEV, IP $PC_IP, MAC $MAC"
if [ -d "/sys/class/net/$DEV/wireless" ]; then
  warn "$DEV ist WLAN -- Aufwecken klappt fast nur per Kabel. Herunterfahren und Blender gehen trotzdem."
fi
case "$PC_IP" in
  100.*) warn "Der Server wird ueber Tailscale erreicht, nicht im Heimnetz -- Aufwecken braucht dasselbe Heimnetz." ;;
esac

# --- 2. Wake-on-LAN ------------------------------------------------------------------
schritt "2/6  Aufwecken (Wake-on-LAN)"
if command -v nmcli >/dev/null && CON=$(nmcli -g GENERAL.CONNECTION device show "$DEV" 2>/dev/null) && [ -n "$CON" ]; then
  if [ "$(nmcli -g 802-3-ethernet.wake-on-lan connection show "$CON" 2>/dev/null)" = "magic" ]; then
    ok "schon an (NetworkManager, Verbindung '$CON')"
  elif sudo nmcli connection modify "$CON" 802-3-ethernet.wake-on-lan magic 2>/dev/null; then
    ok "eingeschaltet (NetworkManager, Verbindung '$CON')"
  else
    warn "konnte Wake-on-LAN fuer '$CON' nicht setzen"
  fi
elif command -v ethtool >/dev/null && sudo ethtool -s "$DEV" wol g 2>/dev/null; then
  warn "mit ethtool eingeschaltet -- gilt nur bis zum Neustart; dauerhaft z.B. per systemd-networkd (WakeOnLan=magic)"
else
  warn "Wake-on-LAN nicht gesetzt (weder nmcli noch ethtool)"
fi
echo "   Wichtig: Wake-on-LAN muss auch im BIOS/UEFI an sein (oft 'Wake on LAN' oder 'Power On By PCI-E')."

# --- 3. SSH-Server ----------------------------------------------------------------------
schritt "3/6  SSH-Server auf diesem PC"
DIENST=""
for d in sshd ssh; do systemctl list-unit-files "$d.service" >/dev/null 2>&1 && systemctl cat "$d.service" >/dev/null 2>&1 && { DIENST=$d; break; }; done
if [ -z "$DIENST" ]; then
  fehlt "kein SSH-Server installiert (Arch: sudo pacman -S openssh, Debian/Ubuntu: sudo apt install openssh-server), dann nochmal"
  exit 1
fi
if systemctl is-active --quiet "$DIENST"; then
  ok "$DIENST laeuft"
elif sudo systemctl enable --now "$DIENST" 2>/dev/null; then
  ok "$DIENST eingeschaltet"
else
  fehlt "$DIENST startet nicht"; exit 1
fi
if sudo sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
  warn "SSH erlaubt Passwoerter -- sicherer: PasswordAuthentication no in /etc/ssh/sshd_config"
fi

# --- 4. Schluessel des Servers mit Einschraenkung ------------------------------------
schritt "4/6  Zugang fuer den Server (nur Herunterfahren und Blender-Tunnel)"
PUB_AUS=$("${SSH[@]}" 'sudo cat /home/roblox/.ssh/pc_aus.pub' 2>/dev/null)
PUB_BLENDER=$("${SSH[@]}" 'sudo cat /home/roblox/.ssh/pc_blender.pub' 2>/dev/null)
if [ -z "$PUB_AUS" ] || [ -z "$PUB_BLENDER" ]; then
  fehlt "Schluessel des Servers nicht lesbar"; exit 1
fi
SYSTEMCTL=$(command -v systemctl)
install -d -m 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
# Alte Eintraege dieses Skripts ersetzen, nichts anderes anfassen.
grep -v 'cockpit-roblox-pc_' "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.neu"
{
  echo "from=\"$SERVER\",restrict,command=\"sudo -n $SYSTEMCTL poweroff\" $PUB_AUS"
  echo "from=\"$SERVER\",restrict,port-forwarding,permitopen=\"127.0.0.1:9876\",command=\"echo nur Tunnel\" $PUB_BLENDER"
} >> "$HOME/.ssh/authorized_keys.neu"
mv "$HOME/.ssh/authorized_keys.neu" "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
ok "zwei eingeschraenkte Schluessel eingetragen (nur von $SERVER)"
SUDOERS=$(mktemp)
echo "$USER ALL=(root) NOPASSWD: $SYSTEMCTL poweroff" > "$SUDOERS"
if sudo visudo -cf "$SUDOERS" >/dev/null && sudo install -m 440 -o root -g root "$SUDOERS" /etc/sudoers.d/cockpit-pc-aus; then
  ok "Herunterfahren ohne Passwort erlaubt -- nur 'systemctl poweroff'"
else
  fehlt "sudoers-Regel nicht gesetzt"
fi
rm -f "$SUDOERS"

# Server: PC eintragen, Netzsperre fuer genau diesen PC oeffnen, Dienste neu.
if printf 'COCKPIT_PC_MAC=%s\nCOCKPIT_PC_HOST=%s\nCOCKPIT_PC_NUTZER=%s\n' "$MAC" "$PC_IP" "$USER" |
     "${SSH[@]}" 'sudo tee /etc/cockpit-roblox/umgebung >/dev/null' &&
   "${SSH[@]}" 'sudo bash /opt/cockpit/deploy/roblox/netz-anwenden.sh >/dev/null && sudo systemctl enable cockpit-roblox-blender >/dev/null 2>&1 && sudo systemctl restart cockpit-roblox cockpit-roblox-blender'; then
  ok "Server kennt den PC ($PC_IP), Bereich PC im Roblox-Cockpit ist an"
else
  fehlt "PC auf dem Server nicht eingetragen"
fi
# Gegenprobe vom Server aus: der Schluessel fuer Blender darf KEINE Befehle.
if "${SSH[@]}" "sudo -u roblox ssh -i /home/roblox/.ssh/pc_blender -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/roblox/.ssh/known_hosts_pc $USER@$PC_IP id" 2>/dev/null | grep -q 'uid='; then
  fehlt "Blender-Schluessel kann Befehle ausfuehren -- Einschraenkung greift nicht"
else
  ok "Gegenprobe: Blender-Schluessel fuehrt keine Befehle aus"
fi

# --- 5. Blender ---------------------------------------------------------------------------
schritt "5/6  Blender mit blender-mcp"
cat <<'HINWEIS'
   Achtung: Wenn Blender mit dem Cockpit verbunden ist, kann Claude dort
   Python ausfuehren -- auf DIESEM PC, mit den Rechten von Blender. Deshalb
   am besten Blender als Flatpak, das nur ~/Roblox-Vault sehen darf (nicht
   dein Home mit SSH-Schluesseln). Und nur verbinden, wenn ihr modelliert.
HINWEIS
ADDON_ZIEL="$HOME/Downloads/blender-mcp-addon.py"
if command -v flatpak >/dev/null && frage "Blender als Flatpak mit eingeschraenktem Dateizugriff einrichten?"; then
  flatpak install -y --user flathub org.blender.Blender >/dev/null 2>&1 || flatpak install -y flathub org.blender.Blender >/dev/null 2>&1
  mkdir -p "$VAULT_PC"
  if flatpak override --user --nofilesystem=host --nofilesystem=home --filesystem="$VAULT_PC" org.blender.Blender; then
    ok "Flatpak-Blender sieht nur noch $VAULT_PC"
  else
    fehlt "Flatpak-Einschraenkung nicht gesetzt"
  fi
  # Ins eigene Verzeichnis der App: das sieht auch das eingeschraenkte Blender.
  ADDON_ZIEL="$HOME/.var/app/org.blender.Blender/blender-mcp-addon.py"
  mkdir -p "$(dirname "$ADDON_ZIEL")"
else
  warn "kein Flatpak -- Blender hat dann vollen Zugriff auf dein Home, solange es verbunden ist"
fi
if curl -fsSL -o "$ADDON_ZIEL" https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py; then
  ok "Addon geladen: $ADDON_ZIEL"
else
  fehlt "Addon nicht geladen (https://github.com/ahujasid/blender-mcp, Datei addon.py)"
fi
cat <<HINWEIS
   In Blender einmalig: Edit > Preferences > Add-ons > (Pfeil oben rechts)
   "Install from Disk" > $ADDON_ZIEL > Haken bei "Interface: Blender MCP".
   Zum Arbeiten: Blender oeffnen, Taste N, Reiter "BlenderMCP",
   "Connect to Claude" klicken. Danach kann der 3D-Modellierer loslegen.
HINWEIS

# --- 6. Vault ---------------------------------------------------------------------------------
schritt "6/6  Roblox-Vault als ~/Roblox-Vault"
SERVER_ID=$("${SSH[@]}" 'sudo -u roblox -H /home/roblox/.local/bin/vault-teilen --id' 2>/dev/null)
if [ -z "$SERVER_ID" ]; then
  fehlt "Syncthing auf dem Server antwortet nicht"
elif ! command -v syncthing >/dev/null; then
  warn "Syncthing ist hier nicht installiert. Installieren, starten, dann nochmal -- oder von Hand:"
  echo "         Geraet hinzufuegen: $SERVER_ID (servertwo-roblox), Ordner 'Roblox-Vault' nach $VAULT_PC annehmen"
else
  EIGENE_ID=$(syncthing cli show system 2>/dev/null | grep -oP '"myID":\s*"\K[^"]+')
  if [ -z "$EIGENE_ID" ]; then
    warn "Syncthing laeuft hier nicht -- starten (z.B. systemctl --user enable --now syncthing), dann nochmal"
  else
    syncthing cli config devices add --device-id "$SERVER_ID" --name servertwo-roblox 2>/dev/null
    # Ordner vom Server automatisch annehmen; landet unter dem Standardpfad mit dem Namen "Roblox-Vault".
    syncthing cli config devices "$SERVER_ID" auto-accept-folders set true 2>/dev/null
    if "${SSH[@]}" "sudo -u roblox -H /home/roblox/.local/bin/vault-teilen $EIGENE_ID $(hostname)" | sed 's/^/        /'; then
      ok "Vault geteilt -- erscheint gleich als Ordner 'Roblox-Vault' (Standard: ~/Roblox-Vault)"
    else
      fehlt "Vault nicht geteilt"
    fi
  fi
fi
echo "   In Obsidian: 'Ordner als Vault oeffnen' > $VAULT_PC"

echo
if [ "$FEHLER" -eq 0 ]; then echo "Fertig, keine Fehler."; else echo "$FEHLER Schritt(e) fehlgeschlagen -- oben nachsehen."; fi
exit "$FEHLER"
