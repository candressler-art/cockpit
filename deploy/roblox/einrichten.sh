#!/usr/bin/env bash
# Richtet auf servertwo das Roblox-Cockpit ein: eine zweite Instanz des
# Cockpits als eigener Benutzer 'roblox', angemeldet mit Konto 2, nur fuer
# Roblox-Spiele (varianten/roblox/). Siehe deploy/roblox/EINRICHTUNG.md.
#
# Aufruf (vom Desktop aus, wie server-einrichten.sh):
#
#   ./deploy/server-einrichten.sh            # zuerst: aktueller Code nach /opt/cockpit
#   ./deploy/roblox/einrichten.sh            # dann das hier
#   ./deploy/roblox/einrichten.sh --aus-haupt zweit
#                                            # ... und Konto 'zweit' im Haupt-Cockpit abschalten
#
# Wiederholbar: jeder Schritt prueft, ob er schon erledigt ist.
#
# Kein `set -e`: jeder Schritt meldet sich selbst, und ein Fehlschlag soll
# sagen, woran es lag, statt wortlos abzubrechen. Kein Token wird je
# ausgegeben -- die Anmeldung laeuft interaktiv ueber `claude auth login`.

set -u

AUS_HAUPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --aus-haupt) AUS_HAUPT="${2:-}"; shift 2 ;;
    -h|--help) sed -n 2,14p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Angabe: $1 (siehe --help)"; exit 2 ;;
  esac
done
if [ -n "$AUS_HAUPT" ] && ! printf '%s' "$AUS_HAUPT" | grep -qE '^[a-z0-9][a-z0-9_-]*$'; then
  echo "Ungueltiger Kontoname '$AUS_HAUPT'"; exit 2
fi

SERVER="${COCKPIT_SERVER:-192.168.2.193}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")
# Alles, was als 'roblox' laufen soll. -H setzt HOME, cd vermeidet
# "could not change directory" aus /home/claude.
ALS_ROBLOX='cd /home/roblox && sudo -u roblox -H'
COCKPIT_PORT=8766
COCKPIT_TS_PORT=10000
ROJO_LOKAL_PORT=34873
ROJO_TS_PORT=34872
FEHLER=0

schritt() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()      { printf '   ok    %s\n' "$1"; }
warn()    { printf '   warn  %s\n' "$1"; }
fehlt()   { printf '   FEHLT %s\n' "$1"; FEHLER=$((FEHLER+1)); }

# --- 1. Voraussetzungen ------------------------------------------------------
schritt "1/9  Server und Code"
if "${SSH[@]}" true 2>/dev/null; then
  ok "SSH als claude@$SERVER"
else
  fehlt "SSH zu claude@$SERVER nicht moeglich (Key: $KEY)"; exit 1
fi
if "${SSH[@]}" 'test -f /opt/cockpit/varianten/roblox/variante.json && test -f /opt/cockpit/dist/variante.js'; then
  ok "/opt/cockpit kennt die Roblox-Variante"
else
  fehlt "/opt/cockpit ist zu alt -- erst ./deploy/server-einrichten.sh laufen lassen"; exit 1
fi
if "${SSH[@]}" 'command -v nft >/dev/null'; then
  ok "nft vorhanden"
else
  fehlt "nft fehlt -- auf dem Server 'sudo apt install nftables'"; exit 1
fi
"${SSH[@]}" 'command -v unzip >/dev/null' || "${SSH[@]}" 'sudo apt-get install -y unzip >/dev/null 2>&1' || warn "unzip fehlt (fuer Rojo noetig)"

# --- 2. Haupt-Cockpit abschotten --------------------------------------------
schritt "2/9  Haupt-Cockpit vor dem neuen Benutzer verschliessen"
# Ubuntu legt Home-Verzeichnisse je nach Version mit 755 an, und
# StateDirectory= hat /var/lib/cockpit mit 755 erzeugt -- dort liegen der
# Vault-Spiegel, die Desktop-Sessions und die Datenbank.
if "${SSH[@]}" 'sudo chmod 750 /home/claude && sudo chmod 750 /var/lib/cockpit' 2>/dev/null; then
  ok "/home/claude und /var/lib/cockpit nur noch fuer claude (750)"
else
  fehlt "Rechte konnten nicht gesetzt werden"
fi
if "${SSH[@]}" 'test -d /etc/cockpit && sudo chown root:claude /etc/cockpit && sudo chmod 750 /etc/cockpit; true'; then ok "/etc/cockpit nur fuer root und claude"; fi

# --- 3. Benutzer ---------------------------------------------------------------
schritt "3/9  Benutzer 'roblox'"
if "${SSH[@]}" 'id roblox >/dev/null 2>&1'; then
  ok "existiert schon"
else
  # Bewusst in keiner Gruppe: nicht sudo, nicht docker (docker = root).
  if "${SSH[@]}" 'sudo useradd --create-home --shell /bin/bash --user-group roblox' 2>/dev/null; then
    ok "angelegt"
  else
    fehlt "useradd fehlgeschlagen"; exit 1
  fi
fi
GRUPPEN=$("${SSH[@]}" 'id -nG roblox' 2>/dev/null)
if [ "$GRUPPEN" = "roblox" ]; then
  ok "nur in Gruppe 'roblox'"
else
  warn "roblox ist in weiteren Gruppen: $GRUPPEN -- sudo/docker waeren ein Weg heraus"
fi
"${SSH[@]}" "sudo chmod 750 /home/roblox && $ALS_ROBLOX mkdir -p /home/roblox/spiele /home/roblox/.local/bin" 2>/dev/null &&
  ok "/home/roblox (750), ~/spiele" || fehlt "Verzeichnisse in /home/roblox"
"${SSH[@]}" "$ALS_ROBLOX git config --global user.name 'Roblox-Cockpit' && $ALS_ROBLOX git config --global user.email 'roblox@servertwo' && $ALS_ROBLOX git config --global init.defaultBranch main" 2>/dev/null &&
  ok "git eingerichtet" || warn "git-Einstellungen nicht gesetzt"

# --- 4. Claude Code fuer 'roblox' ---------------------------------------------
schritt "4/9  Claude Code fuer 'roblox'"
# Eigene Installation: die von 'claude' liegt in /home/claude und ist fuer
# 'roblox' (zu Recht) nicht mehr lesbar.
if "${SSH[@]}" "$ALS_ROBLOX test -x /home/roblox/.local/bin/claude"; then
  ok "schon installiert"
elif "${SSH[@]}" "$ALS_ROBLOX bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1"; then
  ok "installiert nach /home/roblox/.local/bin/claude"
else
  fehlt "Installation fehlgeschlagen (auf dem Server: sudo -u roblox -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash')"
fi

# --- 5. Anmeldung mit Konto 2 ------------------------------------------------
schritt "5/9  Anmeldung mit Konto 2"
CLAUDE_R='/home/roblox/.local/bin/claude'
if "${SSH[@]}" "$ALS_ROBLOX $CLAUDE_R auth status 2>/dev/null | grep -q '\"loggedIn\": true'"; then
  ok "schon angemeldet"
else
  cat <<'HINWEIS'
   Die Anmeldeseite oeffnet sich gleich in deinem Browser.
   Bitte dort mit KONTO 2 anmelden -- nicht mit dem Hauptkonto.

     1. dort anmelden
     2. die Seite zeigt danach einen kurzen CODE
     3. diesen CODE hier ins Terminal einfuegen und Enter

HINWEIS
  SPIEGEL="$(mktemp)"
  (
    for _ in $(seq 1 60); do
      URL=$(grep -aoP '\x1b\]8;[^;]*;\Khttps://claude\.com/[^\x07\x1b]+' "$SPIEGEL" 2>/dev/null | head -1)
      [ -z "$URL" ] && URL=$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g' "$SPIEGEL" 2>/dev/null |
            tr -d '\r' | awk '/^https:\/\/claude\.com\//{f=1} f&&NF{printf "%s",$0} f&&!NF{exit}')
      if [ -n "$URL" ]; then
        command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 &
        printf '\n   [Anmeldeseite im Browser geoeffnet -- Code von dort holen]\n' > /dev/tty
        break
      fi
      sleep 0.5
    done
  ) &
  OEFFNER=$!
  ssh -t -i "$KEY" "claude@$SERVER" "$ALS_ROBLOX $CLAUDE_R auth login" 2>&1 | tee "$SPIEGEL"
  wait "$OEFFNER" 2>/dev/null
  rm -f "$SPIEGEL"
  if "${SSH[@]}" "$ALS_ROBLOX $CLAUDE_R auth status 2>/dev/null | grep -q '\"loggedIn\": true'"; then
    ok "angemeldet"
  else
    fehlt "Anmeldung hat nicht geklappt"; exit 1
  fi
fi
"${SSH[@]}" "sudo chmod -R go-rwx /home/roblox/.claude" 2>/dev/null
R_EMAIL=$("${SSH[@]}" "$ALS_ROBLOX $CLAUDE_R auth status 2>/dev/null" | grep -oP '"email":\s*"\K[^"]+')
H_EMAIL=$("${SSH[@]}" 'claude auth status 2>/dev/null' | grep -oP '"email":\s*"\K[^"]+')
if [ -n "$R_EMAIL" ] && [ "$R_EMAIL" = "$H_EMAIL" ]; then
  fehlt "Roblox-Cockpit ist mit dem HAUPTKONTO ($H_EMAIL) angemeldet -- auf dem Server 'sudo -u roblox -H $CLAUDE_R auth logout' und Skript erneut starten"
  exit 1
fi
ok "Roblox-Cockpit nutzt ${R_EMAIL:-(E-Mail unbekannt)}"

# --- 6. Konto 2 im Haupt-Cockpit abschalten (optional) -----------------------
schritt "6/9  Konto 2 im Haupt-Cockpit"
if [ -z "$AUS_HAUPT" ]; then
  ok "unveraendert (mit --aus-haupt <name> abschalten)"
else
  ALT="/home/claude/.claude-konten/$AUS_HAUPT"
  if ! "${SSH[@]}" "test -d '$ALT'"; then
    ok "'$AUS_HAUPT' gibt es im Haupt-Cockpit nicht (mehr)"
  else
    A_EMAIL=$("${SSH[@]}" "CLAUDE_CONFIG_DIR='$ALT' claude auth status 2>/dev/null" | grep -oP '"email":\s*"\K[^"]+')
    echo "   Konto '$AUS_HAUPT' im Haupt-Cockpit: ${A_EMAIL:-unbekannt}"
    if [ -n "$R_EMAIL" ] && [ "$A_EMAIL" != "$R_EMAIL" ]; then
      warn "das ist NICHT das Konto des Roblox-Cockpits ($R_EMAIL) -- nichts geaendert"
    else
      # Verschieben statt loeschen: konten.ts sieht nur ~/.claude-konten/, das
      # Konto ist damit aus dem Balancing. Die Anmeldung selbst wird entfernt,
      # damit kein unbenutztes Token herumliegt. projects/ und agent-memory/
      # sind dort nur Symlinks auf das Hauptkonto -- mv nimmt die Links mit,
      # nicht deren Ziel.
      if "${SSH[@]}" "mkdir -p /home/claude/.claude-konten-aus && mv '$ALT' /home/claude/.claude-konten-aus/ && rm -f '/home/claude/.claude-konten-aus/$AUS_HAUPT/.credentials.json'"; then
        ok "'$AUS_HAUPT' abgeschaltet (liegt jetzt in ~/.claude-konten-aus/, ohne Anmeldung)"
      else
        fehlt "Verschieben fehlgeschlagen"
      fi
    fi
  fi
fi

# --- 7. Rojo -----------------------------------------------------------------
schritt "7/9  Rojo und rojo-sync"
if "${SSH[@]}" "$ALS_ROBLOX test -x /home/roblox/.local/bin/rojo"; then
  ok "rojo schon installiert ($("${SSH[@]}" "$ALS_ROBLOX /home/roblox/.local/bin/rojo --version" 2>/dev/null))"
else
  ARCH=$("${SSH[@]}" 'uname -m')
  ZIP=$(curl -fsSL https://api.github.com/repos/rojo-rbx/rojo/releases/latest |
        grep -oP '"browser_download_url":\s*"\K[^"]+linux-'"$ARCH"'\.zip' | head -1)
  if [ -z "$ZIP" ]; then
    fehlt "kein Rojo-Download fuer linux-$ARCH gefunden"
  elif "${SSH[@]}" "$ALS_ROBLOX bash -c 'cd /tmp && curl -fsSL -o rojo.zip \"$ZIP\" && unzip -o -q rojo.zip rojo -d /home/roblox/.local/bin && chmod +x /home/roblox/.local/bin/rojo && rm rojo.zip'"; then
    ok "rojo installiert ($("${SSH[@]}" "$ALS_ROBLOX /home/roblox/.local/bin/rojo --version" 2>/dev/null))"
  else
    fehlt "rojo-Installation fehlgeschlagen"
  fi
fi
TS_NAME=$("${SSH[@]}" 'tailscale status --json 2>/dev/null | grep -oP "\"DNSName\":\s*\"\K[^\"]+" | head -1' 2>/dev/null | sed 's/\.$//')
TS_IP=$("${SSH[@]}" 'tailscale ip -4 2>/dev/null | head -1')
if "${SSH[@]}" "sudo install -m 755 -o roblox -g roblox /opt/cockpit/varianten/roblox/bin/rojo-sync /home/roblox/.local/bin/rojo-sync && echo '${TS_NAME:-servertwo}' | sudo -u roblox tee /home/roblox/.rojo-host >/dev/null"; then
  ok "rojo-sync installiert (Studio verbindet mit ${TS_NAME:-servertwo}:$ROJO_TS_PORT)"
else
  fehlt "rojo-sync nicht installiert"
fi

# --- 8. Netzsperre und Dienst ---------------------------------------------------
schritt "8/9  Netzsperre und systemd-Units"
if "${SSH[@]}" 'sudo install -d -m 755 /etc/cockpit-roblox && sudo install -m 644 /opt/cockpit/deploy/roblox/netz.nft /etc/cockpit-roblox/netz.nft && sudo nft -c -f /etc/cockpit-roblox/netz.nft'; then
  ok "Regeln geprueft"
else
  fehlt "netz.nft laesst sich nicht laden"; exit 1
fi
if "${SSH[@]}" 'sudo cp /opt/cockpit/deploy/roblox/cockpit-roblox-netz.service /opt/cockpit/deploy/roblox/cockpit-roblox.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable cockpit-roblox-netz cockpit-roblox >/dev/null 2>&1 && sudo systemctl restart cockpit-roblox-netz && sudo systemctl restart cockpit-roblox' 2>/dev/null; then
  sleep 3
  if "${SSH[@]}" 'systemctl is-active --quiet cockpit-roblox'; then
    ok "cockpit-roblox.service laeuft"
  else
    fehlt "Unit installiert, laeuft aber nicht"
    "${SSH[@]}" 'journalctl -u cockpit-roblox -n 15 --no-pager' 2>/dev/null | sed 's/^/        /'
  fi
else
  fehlt "Units konnten nicht eingerichtet werden"
fi

# --- 9. Tailscale ---------------------------------------------------------------
schritt "9/9  Tailscale"
if "${SSH[@]}" "sudo tailscale serve --bg --https=$COCKPIT_TS_PORT http://127.0.0.1:$COCKPIT_PORT" >/dev/null 2>&1; then
  ok "Cockpit: https://${TS_NAME:-servertwo}:$COCKPIT_TS_PORT"
else
  fehlt "tailscale serve fuer das Cockpit (manuell: sudo tailscale serve --bg --https=$COCKPIT_TS_PORT http://127.0.0.1:$COCKPIT_PORT)"
fi
if "${SSH[@]}" "sudo tailscale serve --bg --tcp=$ROJO_TS_PORT tcp://127.0.0.1:$ROJO_LOKAL_PORT" >/dev/null 2>&1; then
  ok "Rojo: ${TS_NAME:-servertwo} Port $ROJO_TS_PORT"
else
  fehlt "tailscale serve fuer Rojo (manuell: sudo tailscale serve --bg --tcp=$ROJO_TS_PORT tcp://127.0.0.1:$ROJO_LOKAL_PORT)"
fi

# --- Probe -----------------------------------------------------------------------
schritt "Probe: was 'roblox' NICHT darf"
# Jede Zeile muss scheitern. Gelingt eine, ist die Trennung undicht.
probe() {
  local was="$1" befehl="$2"
  if "${SSH[@]}" "$ALS_ROBLOX bash -c '$befehl' >/dev/null 2>&1"; then
    fehlt "roblox kann: $was"
  else
    ok "gesperrt: $was"
  fi
}
probe "Haupt-Cockpit (127.0.0.1:8765)" "curl -sf -m 3 http://127.0.0.1:8765/api/gesundheit"
probe "/home/claude lesen" "ls /home/claude"
probe "Vault-Spiegel lesen" "ls /var/lib/cockpit/vault"
probe "Heimnetz (Router)" "curl -s -m 3 -o /dev/null http://192.168.2.1"
probe "sudo" "sudo -n true"
probe "docker" "docker ps"
# Ohne -f: jede HTTP-Antwort (auch 404) heisst, die Verbindung steht.
if "${SSH[@]}" "$ALS_ROBLOX curl -s -m 5 -o /dev/null https://api.anthropic.com"; then
  ok "Internet geht (api.anthropic.com)"
else
  fehlt "roblox erreicht api.anthropic.com nicht -- Agenten koennen so nicht arbeiten"
fi
if "${SSH[@]}" "curl -sf -m 5 localhost:$COCKPIT_PORT/api/variante" | grep -q '"roblox"'; then
  ok "Roblox-Cockpit antwortet als Variante 'roblox'"
else
  fehlt "Roblox-Cockpit antwortet nicht auf localhost:$COCKPIT_PORT"
fi

echo
if [ "$FEHLER" -eq 0 ]; then
  echo "Fertig, keine Fehler."
else
  echo "$FEHLER Schritt(e) fehlgeschlagen -- oben nachsehen."
fi
cat <<WEITER

Noch von Hand (siehe deploy/roblox/EINRICHTUNG.md):
  1. Tailscale-Policy: Freunde nur auf ${TS_IP:-<IP von servertwo>}:$COCKPIT_TS_PORT und :$ROJO_TS_PORT
  2. servertwo mit dem Freund teilen (Tailscale-Admin -> Machines -> servertwo -> Share)
  3. In Roblox Studio das Rojo-Plugin installieren und mit ${TS_NAME:-servertwo} Port $ROJO_TS_PORT verbinden

Roblox-Cockpit: https://${TS_NAME:-servertwo}:$COCKPIT_TS_PORT
Logs:           ssh -i $KEY claude@$SERVER 'journalctl -u cockpit-roblox -f'
WEITER
exit "$FEHLER"
