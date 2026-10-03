#!/usr/bin/env bash
# Richtet auf servertwo das Roblox-Cockpit ein: eine zweite Instanz des
# Cockpits als eigener Benutzer 'roblox', angemeldet mit Konto 2, nur fuer
# Roblox-Spiele (varianten/roblox/). Siehe deploy/roblox/EINRICHTUNG.md.
#
# Aufruf (vom Desktop aus, wie server-einrichten.sh):
#
#   ./deploy/server-einrichten.sh            # zuerst: aktueller Code nach /opt/cockpit
#   ./deploy/roblox/einrichten.sh            # dann das hier
#
# Nutzt das Haupt-Cockpit Konto 2 bisher als Zusatzkonto, wird es dort als
# geteilt markiert: aus, bis du im Bereich Nutzung den Schalter umlegst.
#
# Wiederholbar: jeder Schritt prueft, ob er schon erledigt ist.
#
# Kein `set -e`: jeder Schritt meldet sich selbst, und ein Fehlschlag soll
# sagen, woran es lag, statt wortlos abzubrechen. Kein Token wird je
# ausgegeben -- die Anmeldung laeuft interaktiv ueber `claude auth login`.

set -u

case "${1:-}" in
  '') ;;
  -h|--help) sed -n 2,13p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unbekannte Angabe: $1 (siehe --help)"; exit 2 ;;
esac

# Linux und macOS: perl statt grep -P, open statt xdg-open.
. "$(dirname "${BASH_SOURCE[0]}")/../hilfen.sh"

SERVER="${COCKPIT_SERVER:-192.168.2.193}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")
# Alles, was als 'roblox' laufen soll. -H setzt HOME. cd / vermeidet
# "could not change directory": sudo behaelt das Arbeitsverzeichnis, und weder
# /home/claude (fuer roblox) noch /home/roblox (fuer claude) ist fremd lesbar.
ALS_ROBLOX='cd / && sudo -u roblox -H'
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
      URL=$(anmelde_url "$SPIEGEL")
      if [ -n "$URL" ]; then
        url_oeffnen "$URL" >/dev/null 2>&1 &
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
R_EMAIL=$("${SSH[@]}" "$ALS_ROBLOX $CLAUDE_R auth status 2>/dev/null" | json_feld email)
H_EMAIL=$("${SSH[@]}" 'claude auth status 2>/dev/null' | json_feld email)
if [ -n "$R_EMAIL" ] && [ "$R_EMAIL" = "$H_EMAIL" ]; then
  fehlt "Roblox-Cockpit ist mit dem HAUPTKONTO ($H_EMAIL) angemeldet -- auf dem Server 'sudo -u roblox -H $CLAUDE_R auth logout' und Skript erneut starten"
  exit 1
fi
ok "Roblox-Cockpit nutzt ${R_EMAIL:-(E-Mail unbekannt)}"

# --- 6. Konto 2 im Haupt-Cockpit als geteilt markieren -----------------------
schritt "6/9  Konto 2 im Haupt-Cockpit"
# Hat das Haupt-Cockpit dasselbe Konto als Zusatzkonto, bekommt es die Marke
# 'cockpit-geteilt' (src/konten.ts GETEILT_MARKE): dann nimmt das Haupt-Cockpit
# es nur noch, wenn im Bereich Nutzung der Schalter dafuer an ist. Die
# Anmeldung bleibt, ein Umlegen des Schalters reicht.
GEFUNDEN=0
for VERZ in $("${SSH[@]}" "ls -1 /home/claude/.claude-konten 2>/dev/null"); do
  A_EMAIL=$("${SSH[@]}" "CLAUDE_CONFIG_DIR='/home/claude/.claude-konten/$VERZ' claude auth status 2>/dev/null" | json_feld email)
  if [ -n "$R_EMAIL" ] && [ "$A_EMAIL" = "$R_EMAIL" ]; then
    GEFUNDEN=1
    if "${SSH[@]}" "touch '/home/claude/.claude-konten/$VERZ/cockpit-geteilt'"; then
      ok "'$VERZ' ($A_EMAIL) ist im Haupt-Cockpit jetzt geteilt: aus, bis du den Schalter unter Nutzung umlegst"
    else
      fehlt "Marke fuer '$VERZ' nicht gesetzt"
    fi
  fi
done
[ "$GEFUNDEN" -eq 0 ] && ok "Haupt-Cockpit hat Konto 2 nicht als Zusatzkonto -- nichts zu tun"

# --- 7. Rojo -----------------------------------------------------------------
schritt "7/9  Werkzeuge: Rojo, uv (Blender), Syncthing (Vault), Schluessel fuer den PC"
if "${SSH[@]}" "$ALS_ROBLOX test -x /home/roblox/.local/bin/rojo"; then
  ok "rojo schon installiert ($("${SSH[@]}" "$ALS_ROBLOX /home/roblox/.local/bin/rojo --version" 2>/dev/null))"
else
  ARCH=$("${SSH[@]}" 'uname -m')
  ZIP=$(curl -fsSL https://api.github.com/repos/rojo-rbx/rojo/releases/latest |
        release_url "linux-$ARCH.zip")
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
if "${SSH[@]}" "for h in rojo-sync vault-teilen; do sudo install -m 755 -o roblox -g roblox /opt/cockpit/varianten/roblox/bin/\$h /home/roblox/.local/bin/\$h || exit 1; done && echo '${TS_NAME:-servertwo}' | sudo -u roblox tee /home/roblox/.rojo-host >/dev/null"; then
  ok "rojo-sync und vault-teilen installiert (Studio verbindet mit ${TS_NAME:-servertwo}:$ROJO_TS_PORT)"
else
  fehlt "Helfer nicht installiert"
fi
# uv/uvx startet den Blender-MCP-Server (src/mcp.ts 'blender').
if "${SSH[@]}" "$ALS_ROBLOX test -x /home/roblox/.local/bin/uvx"; then
  ok "uv schon installiert"
elif "${SSH[@]}" "$ALS_ROBLOX bash -c 'curl -LsSf https://astral.sh/uv/install.sh | UV_NO_MODIFY_PATH=1 sh' >/dev/null 2>&1"; then
  ok "uv installiert"
else
  fehlt "uv-Installation fehlgeschlagen (ohne uv kein Blender)"
fi
if "${SSH[@]}" 'command -v syncthing >/dev/null || sudo apt-get install -y syncthing >/dev/null 2>&1'; then
  ok "Syncthing vorhanden ($("${SSH[@]}" 'syncthing --version' 2>/dev/null | cut -d' ' -f2))"
else
  fehlt "Syncthing nicht installiert (sudo apt install syncthing)"
fi
# Zwei Schluessel, je fuer genau eine Sache auf dem PC (pc-einrichten.sh traegt
# sie dort mit Einschraenkung ein): pc_aus faehrt herunter, pc_blender tunnelt.
if "${SSH[@]}" "$ALS_ROBLOX bash -c 'install -d -m 700 ~/.ssh && for k in pc_aus pc_blender pc_studio; do [ -f ~/.ssh/\$k ] || ssh-keygen -q -t ed25519 -N \"\" -C cockpit-roblox-\$k -f ~/.ssh/\$k || exit 1; done'"; then
  ok "Schluessel fuer den PC bereit (~roblox/.ssh/pc_aus, pc_blender, pc_studio)"
else
  fehlt "Schluessel fuer den PC nicht erzeugt"
fi

# --- 8. Netzsperre und Dienst ---------------------------------------------------
schritt "8/9  Netzsperre und systemd-Units"
# umgebung: PC-Angaben (pc-einrichten.sh). Anlegen, falls es sie noch nicht gibt.
"${SSH[@]}" 'sudo install -d -m 755 /etc/cockpit-roblox && { [ -f /etc/cockpit-roblox/umgebung ] || sudo install -m 644 /dev/null /etc/cockpit-roblox/umgebung; }'
if "${SSH[@]}" 'sudo bash /opt/cockpit/deploy/roblox/netz-anwenden.sh' | sed 's/^/        /'; then
  ok "Regeln geprueft"
else
  fehlt "netz.nft laesst sich nicht laden"; exit 1
fi
if "${SSH[@]}" "$ALS_ROBLOX bash /opt/cockpit/deploy/roblox/syncthing-einrichten.sh vorher"; then
  ok "Syncthing-Konfiguration fuer den Vault"
else
  fehlt "Syncthing-Konfiguration fehlgeschlagen"
fi
if "${SSH[@]}" 'cd /opt/cockpit/deploy/roblox && sudo cp cockpit-roblox-netz.service cockpit-roblox.service cockpit-roblox-syncthing.service cockpit-roblox-blender.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable cockpit-roblox-netz cockpit-roblox cockpit-roblox-syncthing >/dev/null 2>&1 && sudo systemctl restart cockpit-roblox-netz && sudo systemctl restart cockpit-roblox cockpit-roblox-syncthing' 2>/dev/null; then
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
if "${SSH[@]}" "$ALS_ROBLOX bash /opt/cockpit/deploy/roblox/syncthing-einrichten.sh nachher" | sed 's/^/        /'; then
  ok "Vault-Syncthing laeuft (Geraete-ID: $("${SSH[@]}" "$ALS_ROBLOX /home/roblox/.local/bin/vault-teilen --id" 2>/dev/null))"
else
  fehlt "Vault-Ordner in Syncthing nicht eingerichtet"
fi
# Blender-Tunnel nur, wenn ein PC eingetragen ist (pc-einrichten.sh).
if "${SSH[@]}" 'grep -q "^COCKPIT_PC_HOST=" /etc/cockpit-roblox/umgebung'; then
  "${SSH[@]}" 'sudo systemctl enable cockpit-roblox-blender >/dev/null 2>&1 && sudo systemctl restart cockpit-roblox-blender' &&
    ok "Blender-Tunnel zum PC aktiv (wartet, bis PC und Blender an sind)" || fehlt "Blender-Tunnel nicht gestartet"
else
  ok "noch kein PC eingetragen -- danach ./deploy/roblox/pc-einrichten.sh auf dem PC"
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
probe "eigene Cockpit-API (z.B. PC ausschalten)" "curl -sf -m 3 http://127.0.0.1:8766/api/variante"
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
  3. Auf deinem PC: ./deploy/roblox/pc-einrichten.sh (Aufwecken, Herunterfahren, Blender, Vault)
  4. In Roblox Studio das Rojo-Plugin installieren und mit ${TS_NAME:-servertwo} Port $ROJO_TS_PORT verbinden

Roblox-Cockpit: https://${TS_NAME:-servertwo}:$COCKPIT_TS_PORT
Logs:           ssh -i $KEY claude@$SERVER 'journalctl -u cockpit-roblox -f'
WEITER
exit "$FEHLER"
