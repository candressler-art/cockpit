#!/usr/bin/env bash
# Richtet das Cockpit auf servertwo ein.
#
# Kein `set -e`: jeder Schritt meldet sich selbst, und ein Fehlschlag soll
# sagen, woran es lag, statt wortlos abzubrechen.
#
# Du musst genau zweimal etwas tun: eine URL im Browser oeffnen und den
# Code einfuegen, danach das ausgegebene Token einfuegen. Alles andere laeuft
# hier durch. Das Token wird dabei nie angezeigt und landet direkt in einer
# Datei mit Rechten 600 auf dem Server.

SERVER="${COCKPIT_SERVER:-192.168.2.193}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")
WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEHLER=0

schritt() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()      { printf '   ok    %s\n' "$1"; }
warn()    { printf '   warn  %s\n' "$1"; }
fehlt()   { printf '   FEHLT %s\n' "$1"; FEHLER=$((FEHLER+1)); }

# --- 1. Erreichbarkeit -------------------------------------------------------
schritt "1/7  Server erreichbar"
if "${SSH[@]}" true 2>/dev/null; then
  ok "SSH als claude@$SERVER"
else
  fehlt "SSH zu claude@$SERVER nicht moeglich (Key: $KEY)"
  echo; echo "Abbruch: ohne SSH geht nichts weiter."; exit 1
fi

# --- 2. Kein API-Schluessel in der Umgebung ---------------------------------
schritt "2/7  Kein ANTHROPIC_API_KEY im Weg"
# Ein gesetzter API-Schluessel ueberstimmt das Abo-Login. Jeder Lauf wuerde
# dann pro Token abgerechnet statt gegen das Abo -- der teuerste stille Fehler,
# den dieses Setup haben kann.
if "${SSH[@]}" '[ -z "$ANTHROPIC_API_KEY" ]' 2>/dev/null; then
  ok "nicht gesetzt"
else
  fehlt "ANTHROPIC_API_KEY ist auf dem Server gesetzt -- erst entfernen"
  echo; echo "Abbruch: sonst zahlst du pro Token statt gegen das Abo."; exit 1
fi

# --- 3. Anmeldung ------------------------------------------------------------
schritt "3/7  Anmeldung auf dem Server"
# `claude auth login` statt `claude setup-token`.
#
# setup-token gibt das Token zum Abschreiben aus -- und genau daran ist es
# zweimal gescheitert: die CLI baut die Anzeige schrittweise auf und maskiert
# sie teilweise, sodass aus dem Terminalstrom zwar etwas Token-foermiges zu
# holen ist, aber nicht das echte. Beide Male meldete der Server 401, beim
# zweiten Mal bei formal einwandfreien 113 Zeichen.
#
# auth login legt die Anmeldung direkt in ~/.claude/.credentials.json auf dem
# Server ab. Es gibt nichts zu kopieren, nichts zu uebertragen und nichts, was
# unterwegs abgeschnitten werden kann.
if "${SSH[@]}" 'claude auth status 2>/dev/null | grep -q "\"loggedIn\": true"'; then
  ok "Server ist bereits angemeldet, ueberspringe"
else
  cat <<'HINWEIS'
   Die Anmeldeseite oeffnet sich gleich in deinem Browser.

     1. dort anmelden
     2. die Seite zeigt danach einen kurzen CODE
     3. diesen CODE hier ins Terminal einfuegen und Enter

   Ins Terminal gehoert der CODE von der Webseite -- nicht die URL.

HINWEIS

  SPIEGEL="$(mktemp)"
  (
    # Sobald die URL im Strom auftaucht, lokal oeffnen. Die CLI laeuft auf dem
    # Server und kann dort keinen Browser starten.
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

  ssh -t -i "$KEY" "claude@$SERVER" 'claude auth login' 2>&1 | tee "$SPIEGEL"
  wait "$OEFFNER" 2>/dev/null
  rm -f "$SPIEGEL"

  if "${SSH[@]}" 'claude auth status 2>/dev/null | grep -q "\"loggedIn\": true"'; then
    ok "angemeldet"
    "${SSH[@]}" 'claude auth status 2>/dev/null | grep -E "email|subscriptionType"' | sed 's/^/        /'
  else
    fehlt "Anmeldung hat nicht geklappt"
    exit 1
  fi
fi

# --- 4. Code ausrollen -------------------------------------------------------
schritt "4/7  Code nach /opt/cockpit"
# Hier bauen, nicht dort: tsc ist eine Dev-Abhaengigkeit, und auf dem Server
# sollen nur Laufzeitpakete liegen. Das fertige dist/ faehrt mit.
if (cd "$WURZEL" && npm run build >/dev/null 2>&1); then
  ok "lokal gebaut"
else
  fehlt "lokaler Build fehlgeschlagen -- erst hier reparieren"
  exit 1
fi
"${SSH[@]}" 'sudo install -d -o claude -g claude /opt/cockpit' 2>/dev/null
# Uebertragung per tar statt rsync: rsync ist auf dem Server nicht installiert,
# und tar gibt es ueberall. Der Preis ist, dass jedes Mal alles uebertragen
# wird -- bei diesem Projekt sind das ein paar hundert Kilobyte.
if tar czf - -C "$WURZEL" \
     --exclude=node_modules --exclude=.git --exclude=src-tauri/target \
     --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' . 2>/dev/null |
   "${SSH[@]}" 'rm -rf /opt/cockpit/src /opt/cockpit/web /opt/cockpit/deploy /opt/cockpit/dist /opt/cockpit/rollen && tar xzf - -C /opt/cockpit'; then
  ok "uebertragen (tar)"
else
  fehlt "Uebertragung fehlgeschlagen"
fi

# --- 5. Laufzeitabhaengigkeiten ---------------------------------------------
schritt "5/7  Laufzeitabhaengigkeiten auf dem Server"
if "${SSH[@]}" 'cd /opt/cockpit && npm ci --omit=dev --silent >/dev/null 2>&1'; then
  ok "installiert"
else
  fehlt "npm ci fehlgeschlagen"
fi
# node:sqlite gibt es erst ab 22.5 -- ohne das startet der Daemon nicht.
V=$("${SSH[@]}" 'node --version' 2>/dev/null)
if "${SSH[@]}" 'node -e "require(\"node:sqlite\")" 2>/dev/null'; then
  ok "node:sqlite vorhanden (${V:-?})"
else
  fehlt "node:sqlite fehlt -- Node auf dem Server ist ${V:-unbekannt}, noetig >= v22.5"
fi

# --- 6. Dienst ---------------------------------------------------------------
schritt "6/7  systemd-Unit"
if "${SSH[@]}" 'sudo cp /opt/cockpit/deploy/cockpit.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now cockpit' 2>/dev/null; then
  sleep 3
  if "${SSH[@]}" 'systemctl is-active --quiet cockpit'; then
    ok "cockpit.service laeuft"
  else
    fehlt "Unit installiert, laeuft aber nicht"
    "${SSH[@]}" 'journalctl -u cockpit -n 15 --no-pager' 2>/dev/null | sed 's/^/        /'
  fi
else
  fehlt "Unit konnte nicht eingerichtet werden"
fi

# --- 7. Tailscale ------------------------------------------------------------
schritt "7/7  Ueber Tailscale erreichbar machen"
# serve, nicht funnel: funnel stellt den Dienst ins offene Internet.
if "${SSH[@]}" 'sudo tailscale serve --bg --https=8443 8765' >/dev/null 2>&1; then
  NAME=$("${SSH[@]}" 'tailscale status --json 2>/dev/null | grep -oP "\"DNSName\":\s*\"\K[^\"]+" | head -1' 2>/dev/null | sed 's/\.$//')
  ok "tailscale serve aktiv${NAME:+ -- https://$NAME}"
else
  warn "tailscale serve nicht eingerichtet (manuell: sudo tailscale serve --bg --https=8443 8765)"
fi

# --- Probe -------------------------------------------------------------------
schritt "Probe"
if "${SSH[@]}" 'curl -sf --max-time 5 localhost:8765/api/gesundheit >/dev/null'; then
  ok "Daemon antwortet auf dem Server"
else
  fehlt "Daemon antwortet nicht"
fi

# Der eigentliche Test: traegt das Token? Form und Laenge sagen darueber
# nichts -- ein abgeschnittenes Token sieht richtig aus und liefert 401.
# Kostet einen winzigen Aufruf, erspart aber eine spaetere Fehlersuche am
# falschen Ende.
ANTWORT=$("${SSH[@]}" 'cd /tmp && timeout 60 claude -p "Antworte nur mit OK" --output-format json 2>&1' 2>/dev/null)
if printf '%s' "$ANTWORT" | grep -q '"is_error":false'; then
  ok "Anmeldung traegt -- Testaufruf beantwortet"
elif printf '%s' "$ANTWORT" | grep -qi '401\|invalid'; then
  fehlt "Anmeldung wird abgelehnt (401) -- auf dem Server `claude auth logout` und Skript erneut starten"
else
  warn "Testaufruf unklar: $(printf '%s' "$ANTWORT" | head -c 160)"
fi

echo
if [ "$FEHLER" -eq 0 ]; then
  echo "Fertig, keine Fehler."
  echo
  echo "App gegen den Server starten:"
  echo "  COCKPIT_DAEMON=${NAME:-servertwo.tail9c8a2b.ts.net:8443} cockpit-start"
  echo
  echo "Logs ansehen:"
  echo "  ssh -i $KEY claude@$SERVER 'journalctl -u cockpit -f'"
else
  echo "$FEHLER Schritt(e) fehlgeschlagen -- oben nachsehen."
fi
exit "$FEHLER"
