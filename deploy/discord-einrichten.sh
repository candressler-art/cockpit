#!/usr/bin/env bash
# Traegt die Discord-Zugangsdaten auf servertwo ein und startet den Dienst neu.
# Kein `set -e`: jeder Schritt meldet sich selbst.
#
# Token und IDs werden verborgen eingelesen und ueber stdin uebertragen -- sie
# stehen damit weder im Terminalverlauf noch in der Prozessliste des Servers.

SERVER="${COCKPIT_SERVER:-192.168.2.193}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")

echo "Anleitung: deploy/DISCORD.md"
echo

printf 'Bot-Token (verborgen):        '; read -rs TOKEN; echo
printf 'Kanal-ID:                     '; read -r KANAL
printf 'Deine Benutzer-ID (leer=alle): '; read -r BENUTZER
printf 'Arbeitsverzeichnis fuer !lauf: '; read -r CWD

[ -z "$TOKEN" ] && { echo "Kein Token, nichts geaendert."; exit 1; }
[ -z "$KANAL" ] && { echo "Keine Kanal-ID, nichts geaendert."; exit 1; }

case "$TOKEN" in
  *.*.*) : ;;  # Bot-Token bestehen aus drei durch Punkte getrennten Teilen
  *) echo "Warnung: das sieht nicht wie ein Bot-Token aus."
     printf 'Trotzdem eintragen? [j/N] '; read -r JA
     [ "$JA" = "j" ] || { echo "Abgebrochen."; exit 1; } ;;
esac

if [ -n "$CWD" ] && ! "${SSH[@]}" "[ -d '$CWD' ]"; then
  echo "Warnung: $CWD existiert auf dem Server nicht."
  printf 'Trotzdem eintragen? [j/N] '; read -r JA
  [ "$JA" = "j" ] || { echo "Abgebrochen."; exit 1; }
fi

# Bestehende Datei ohne die Discord-Zeilen uebernehmen, dann neu anhaengen --
# so bleibt ein eventuell vorhandenes Token erhalten.
{
  "${SSH[@]}" 'sudo cat /etc/cockpit/umgebung 2>/dev/null | grep -v "^COCKPIT_DISCORD_"'
  printf 'COCKPIT_DISCORD_TOKEN=%s\n' "$TOKEN"
  printf 'COCKPIT_DISCORD_KANAL=%s\n' "$KANAL"
  [ -n "$BENUTZER" ] && printf 'COCKPIT_DISCORD_BENUTZER=%s\n' "$BENUTZER"
  [ -n "$CWD" ] && printf 'COCKPIT_DISCORD_CWD=%s\n' "$CWD"
} | "${SSH[@]}" 'sudo install -d -m 755 /etc/cockpit && sudo tee /etc/cockpit/umgebung >/dev/null && sudo chown claude:claude /etc/cockpit/umgebung && sudo chmod 600 /etc/cockpit/umgebung'
unset TOKEN

echo "Eingetragen. Dienst neu starten..."
"${SSH[@]}" 'sudo systemctl restart cockpit' && sleep 5

echo
echo "Protokoll:"
"${SSH[@]}" 'journalctl -u cockpit -n 12 --no-pager | grep -E "cockpit|discord" | tail -6' | sed 's/^/  /'
echo
if "${SSH[@]}" 'journalctl -u cockpit -n 30 --no-pager | grep -q "\[discord\] verbunden"'; then
  echo "Discord ist verbunden. Probier im Kanal:  !status"
else
  echo "Discord meldet sich noch nicht verbunden -- Protokoll oben ansehen."
fi
