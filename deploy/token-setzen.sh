#!/usr/bin/env bash
# Nimmt ein bereits erzeugtes OAuth-Token entgegen und legt es auf serverone ab.
#
# Fuer den Fall, dass `claude setup-token` schon separat gelaufen ist und das
# Token im Terminal steht. Kein `set -e`: jeder Schritt meldet sich selbst.
#
# Das Token wird verborgen eingelesen und ueber stdin uebertragen -- es steht
# damit weder im Terminalverlauf noch in der Prozessliste des Servers.

SERVER="${COCKPIT_SERVER:-192.168.2.192}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")

printf 'Token einfuegen (bleibt verborgen), dann Enter: '
read -rs TOKEN
echo

if [ -z "$TOKEN" ]; then
  echo "Kein Token eingegeben, nichts geaendert."
  exit 1
fi

# Grobe Plausibilitaet, damit ein versehentlich kopierter Code nicht
# stillschweigend als Token landet.
case "$TOKEN" in
  sk-ant-oat*) : ;;
  *) echo "Warnung: das sieht nicht wie ein OAuth-Token aus (erwartet: sk-ant-oat...)."
     printf 'Trotzdem schreiben? [j/N] '
     read -r JA
     [ "$JA" = "j" ] || { echo "Abgebrochen."; exit 1; } ;;
esac

if printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" |
     "${SSH[@]}" 'sudo install -d -m 755 /etc/cockpit && sudo tee /etc/cockpit/umgebung >/dev/null && sudo chown claude:claude /etc/cockpit/umgebung && sudo chmod 600 /etc/cockpit/umgebung'; then
  echo "Token geschrieben: /etc/cockpit/umgebung (600 claude:claude)"
else
  echo "FEHLER beim Schreiben."
  unset TOKEN
  exit 1
fi
unset TOKEN

echo "Dienst neu starten, damit er die Anmeldung sieht..."
"${SSH[@]}" 'sudo systemctl restart cockpit' && sleep 3

echo
echo "Probe:"
"${SSH[@]}" 'systemctl is-active cockpit' | sed 's/^/  Dienst: /'
"${SSH[@]}" 'sudo -u claude env CLAUDE_CODE_OAUTH_TOKEN="$(grep -oP "CLAUDE_CODE_OAUTH_TOKEN=\K.*" /etc/cockpit/umgebung)" claude auth status 2>/dev/null | grep -E "loggedIn|subscriptionType|email"' | sed 's/^/  /'
