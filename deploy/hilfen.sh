# Gemeinsame Helfer der Einrichtungsskripte (server-einrichten.sh,
# konto-hinzufuegen.sh, roblox/einrichten.sh). Die laufen auf dem Rechner, von
# dem aus eingerichtet wird -- Linux ODER macOS. Auf dem Mac gibt es kein
# `grep -P`, kein `\x1b` in sed und kein xdg-open; perl gibt es auf beiden.
# Nur fuer das, was LOKAL laeuft -- Befehle per SSH laufen ohnehin auf dem Server.

# Ein Textfeld aus JSON auf stdin, z.B.:  ... | json_feld email
json_feld() {
  perl -ne 'if (/"'"$1"'":\s*"([^"]+)"/) { print "$1\n"; exit }'
}

# Download-Adresse aus einer GitHub-Release-Antwort auf stdin, deren Name auf $1 endet.
release_url() {
  perl -ne 'if (m{"browser_download_url":\s*"([^"]+\Q'"$1"'\E)"}) { print "$1\n"; exit }'
}

# Adresse im Browser oeffnen: xdg-open (Linux) oder open (macOS).
url_oeffnen() {
  if command -v xdg-open >/dev/null; then xdg-open "$1"
  elif command -v open >/dev/null; then open "$1"
  fi
}

# Anmeldeadresse aus dem Mitschnitt von `claude auth login`: zuerst der
# Hyperlink (OSC 8), sonst die URL im Klartext, ueber mehrere Zeilen umbrochen.
anmelde_url() {
  local u
  u=$(perl -ne 'if (/\e\]8;[^;]*;(https:\/\/claude\.com\/[^\a\e]+)/) { print "$1"; exit }' "$1" 2>/dev/null)
  [ -z "$u" ] && u=$(perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g; s/\e\][^\a]*\a//g; s/\r//g' "$1" 2>/dev/null |
    awk '/^https:\/\/claude\.com\//{f=1} f&&NF{printf "%s",$0} f&&!NF{exit}')
  printf '%s' "$u"
}
