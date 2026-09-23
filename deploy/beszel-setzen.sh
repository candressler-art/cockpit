#!/usr/bin/env bash
# Traegt die Beszel-Zugangsdaten fuer das Cockpit in /etc/cockpit/umgebung
# ein, damit die Serverlast-Ansicht BEIDE Maschinen zeigt (servertwo UND
# serverone), nicht nur den eigenen Host per /proc.
#
# Stil wie deploy/token-setzen.sh: kein `set -e`, jeder Schritt meldet sich
# selbst. Anders als dort wird hier aber nicht die ganze Datei ersetzt,
# sondern nur die drei BESZEL_*-Zeilen darin gesetzt bzw. ausgetauscht --
# ein schon eingetragenes CLAUDE_CODE_OAUTH_TOKEN (token-setzen.sh) oder ein
# CLAUDE_CODE_OAUTH_TOKEN aus server-einrichten.sh darf dabei nicht
# verlorengehen.
#
# EMPFEHLUNG, bevor du dieses Skript ausfuehrst: leg im Beszel-Hub einen
# EIGENEN, NUR LESENDEN Benutzer fuer das Cockpit an, statt Cans eigenes
# Admin-Login hier einzutragen (Beszel-Oberflaeche -> Einstellungen ->
# Benutzer -> neuer Benutzer, KEIN Superuser). Das Cockpit braucht nur
# Leserechte auf die Collection "systems"; ein Leck dieser Zugangsdaten
# (die Datei liegt auf dem Server, nicht hier) kostet dann keinen
# Admin-Zugriff auf den Hub.
#
# Passwoerter kommen nicht in den Chat -- dieses Skript liest das
# Beszel-Passwort deshalb selbst und verborgen ein (read -rs). Du fuehrst es
# selbst aus, niemand sonst.

SERVER="${COCKPIT_SERVER:-192.168.2.193}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")
ENV_DATEI=/etc/cockpit/umgebung

echo "Der Beszel-Hub laeuft auf servertwo selbst (Port 8090) -- Vorgabe ist"
echo "deshalb localhost, nicht der Tailnet-Name."
printf 'BESZEL_URL [http://127.0.0.1:8090]: '
read -r URL
URL="${URL:-http://127.0.0.1:8090}"

printf 'BESZEL_USER (Benutzername oder E-Mail des NUR-LESENDEN Kontos): '
read -r BENUTZER
if [ -z "$BENUTZER" ]; then
  echo "Kein Benutzer eingegeben, nichts geaendert."
  exit 1
fi

printf 'BESZEL_PASS (bleibt verborgen), dann Enter: '
read -rs PASSWORT
echo
if [ -z "$PASSWORT" ]; then
  echo "Kein Passwort eingegeben, nichts geaendert."
  exit 1
fi

echo
echo "== 1/4  Server erreichbar =="
if "${SSH[@]}" true 2>/dev/null; then
  echo "   ok    SSH als claude@$SERVER"
else
  echo "   FEHLT SSH zu claude@$SERVER nicht moeglich (Key: $KEY)"
  exit 1
fi

echo "== 2/4  $ENV_DATEI lesen, BESZEL_*-Zeilen ersetzen, Rest erhalten =="
BESTAND=$("${SSH[@]}" "sudo cat '$ENV_DATEI' 2>/dev/null")
OHNE_BESZEL=$(printf '%s\n' "$BESTAND" | grep -vE '^BESZEL_(URL|USER|PASS)=')
NEUER_INHALT=$(printf '%s\nBESZEL_URL=%s\nBESZEL_USER=%s\nBESZEL_PASS=%s\n' \
  "$OHNE_BESZEL" "$URL" "$BENUTZER" "$PASSWORT")

if printf '%s\n' "$NEUER_INHALT" |
     "${SSH[@]}" "sudo install -d -m 755 /etc/cockpit && sudo tee '$ENV_DATEI' >/dev/null && sudo chown claude:claude '$ENV_DATEI' && sudo chmod 600 '$ENV_DATEI'"; then
  echo "   ok    $ENV_DATEI geschrieben (600 claude:claude), andere Zeilen erhalten"
else
  echo "   FEHLT Schreiben fehlgeschlagen"
  unset PASSWORT NEUER_INHALT OHNE_BESZEL BESTAND
  exit 1
fi
unset PASSWORT NEUER_INHALT OHNE_BESZEL BESTAND

echo "== 3/4  Dienst neu starten, damit er die Zugangsdaten sieht =="
"${SSH[@]}" 'sudo systemctl restart cockpit' && sleep 3
"${SSH[@]}" 'systemctl is-active cockpit' | sed 's/^/   Dienst: /'

echo "== 4/4  Probe: liefert /api/system jetzt zwei Systeme? =="
ANTWORT=$("${SSH[@]}" 'curl -s --max-time 5 localhost:8765/api/system' 2>/dev/null)
ANZAHL=$(printf '%s' "$ANTWORT" | grep -oE '"name":"[^"]*"' | wc -l | tr -d ' ')
if [ "${ANZAHL:-0}" -ge 2 ]; then
  echo "   ok    $ANZAHL Systeme gemeldet"
  printf '%s' "$ANTWORT" | grep -oE '"name":"[^"]*"' | sed 's/^/         /'
elif [ "${ANZAHL:-0}" -eq 1 ]; then
  echo "   warn  nur 1 System gemeldet -- ist serverone im Beszel-Hub ueberhaupt als"
  echo "         System eingetragen (mit laufendem Beszel-Agenten, der sich dort"
  echo "         meldet)? Ohne das kann auch eine richtige Anmeldung nur eins zeigen."
else
  echo "   FEHLT keine Systeme gemeldet -- vermutlich Anmeldung abgelehnt."
  echo "         Nachsehen (ohne Passwort in der Befehlszeile):"
  echo "         ssh -i $KEY claude@$SERVER 'journalctl -u cockpit -n 30 --no-pager | grep -i beszel'"
fi

echo
echo "Fertig. Im Server-Tab und in der Zentrale sollten jetzt beide Server stehen."
