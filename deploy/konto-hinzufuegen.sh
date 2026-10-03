#!/usr/bin/env bash
# Legt auf servertwo ein zusaetzliches Claude-Code-Konto an und meldet es an.
#
# Aufruf:  ./deploy/konto-hinzufuegen.sh <name>
#
# <name> ist ein freier Bezeichner (z.B. "zweit") -- er wird zum
# Verzeichnisnamen unter /home/claude/.claude-konten/ und taucht so in
# /api/konten und im Server-Tab auf. Das Hauptkonto ('haupt',
# /home/claude/.claude) bleibt davon unberuehrt.
#
# Kein `set -e`: jeder Schritt meldet sich selbst, ein Fehlschlag soll sagen,
# woran es lag, statt wortlos abzubrechen. Kein Passwort und kein Token wird
# hier je ausgegeben -- die Anmeldung laeuft interaktiv im eigenen Terminal
# ueber `claude auth login`, genau wie in server-einrichten.sh.

set -u

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "Aufruf: $0 <name>   (z.B. $0 zweit)"
  exit 2
fi
if ! printf '%s' "$NAME" | grep -qE '^[a-z0-9][a-z0-9_-]*$'; then
  echo "Ungueltiger Name '$NAME' -- nur a-z, 0-9, '-' und '_', muss mit einem Zeichen beginnen."
  exit 2
fi
if [ "$NAME" = "haupt" ]; then
  echo "'haupt' ist das Hauptkonto (/home/claude/.claude) und kein gueltiger Name fuer ein Zusatzkonto."
  exit 2
fi

# Linux und macOS: perl statt grep -P, open statt xdg-open.
. "$(dirname "${BASH_SOURCE[0]}")/hilfen.sh"

SERVER="${COCKPIT_SERVER:-192.168.2.193}"
KEY="${COCKPIT_SSH_KEY:-$HOME/.ssh/id_ed25519_claude}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "claude@$SERVER")
KONTEN_WURZEL="${COCKPIT_KONTEN_DIR:-/home/claude/.claude-konten}"
KONTO_DIR="$KONTEN_WURZEL/$NAME"
HAUPT_PROJECTS="/home/claude/.claude/projects"
HAUPT_GEDAECHTNIS="/home/claude/.claude/agent-memory"
FEHLER=0

schritt() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()      { printf '   ok    %s\n' "$1"; }
warn()    { printf '   warn  %s\n' "$1"; }
fehlt()   { printf '   FEHLT %s\n' "$1"; FEHLER=$((FEHLER+1)); }

# --- 1. Erreichbarkeit -------------------------------------------------------
schritt "1/5  Server erreichbar"
if "${SSH[@]}" true 2>/dev/null; then
  ok "SSH als claude@$SERVER"
else
  fehlt "SSH zu claude@$SERVER nicht moeglich (Key: $KEY)"
  echo; echo "Abbruch: ohne SSH geht nichts weiter."; exit 1
fi

# --- 2. Konto-Verzeichnis anlegen --------------------------------------------
schritt "2/5  Konto-Verzeichnis $KONTO_DIR"
if "${SSH[@]}" "test -d '$KONTO_DIR'" 2>/dev/null; then
  ok "existiert schon, wird weiterverwendet"
else
  if "${SSH[@]}" "install -d -m 700 -o claude -g claude '$KONTO_DIR'" 2>/dev/null; then
    ok "angelegt (700, claude:claude)"
  else
    fehlt "Verzeichnis konnte nicht angelegt werden"
    exit 1
  fi
fi

# Sessions mit dem Hauptkonto teilen: `resume` sucht die Session unter
# <CLAUDE_CONFIG_DIR>/projects/<projektschluessel>/<sessionId>.jsonl, und der
# Projektschluessel haengt am Arbeitsverzeichnis, nicht am Konto. Zeigt
# projects/ dieses Kontos auf dasselbe Verzeichnis wie beim Hauptkonto, findet
# ein Kontowechsel mitten im Lauf dieselbe Datei wieder. Das Cockpit setzt bei
# einem Kontowechsel automatisch resume ein -- ohne diesen Symlink liefe der
# fortgesetzte Agent unter dem Zusatzkonto ins Leere.
#
# Nicht auf dem Server verifiziert, ob `claude auth login` einen bestehenden
# Symlink an dieser Stelle unangetastet laesst -- nur lokal geprueft, dass die
# CLI projects/ unter einem frisch gesetzten CLAUDE_CONFIG_DIR selbst anlegt,
# wenn dort noch nichts liegt. Schlaegt der Login-Schritt unten mit einer
# Meldung zu projects/ fehl, ist das der erste Verdaechtige.
if "${SSH[@]}" "test -L '$KONTO_DIR/projects'" 2>/dev/null; then
  ok "projects/ ist schon verlinkt"
elif "${SSH[@]}" "test -e '$KONTO_DIR/projects'" 2>/dev/null; then
  warn "$KONTO_DIR/projects existiert schon und ist KEIN Symlink -- von Hand pruefen, nicht automatisch ueberschrieben"
else
  if "${SSH[@]}" "ln -s '$HAUPT_PROJECTS' '$KONTO_DIR/projects'" 2>/dev/null; then
    ok "projects/ -> $HAUPT_PROJECTS verlinkt"
  else
    fehlt "Symlink fuer projects/ konnte nicht angelegt werden"
  fi
fi

# Aus demselben Grund das Gedaechtnis der Spezialisten: die CLI legt es unter
# <CLAUDE_CONFIG_DIR>/agent-memory/<rolle>/ ab. Ohne den Symlink lernte jeder
# Spezialist pro Konto getrennt und wuesste unter diesem Konto nichts von dem,
# was er unter 'haupt' gelernt hat (src/gedaechtnis.ts).
if "${SSH[@]}" "test -L '$KONTO_DIR/agent-memory'" 2>/dev/null; then
  ok "agent-memory/ ist schon verlinkt"
elif "${SSH[@]}" "test -e '$KONTO_DIR/agent-memory'" 2>/dev/null; then
  warn "$KONTO_DIR/agent-memory existiert schon und ist KEIN Symlink -- Inhalt von Hand nach $HAUPT_GEDAECHTNIS uebernehmen"
else
  if "${SSH[@]}" "mkdir -p '$HAUPT_GEDAECHTNIS' && ln -s '$HAUPT_GEDAECHTNIS' '$KONTO_DIR/agent-memory'" 2>/dev/null; then
    ok "agent-memory/ -> $HAUPT_GEDAECHTNIS verlinkt"
  else
    fehlt "Symlink fuer agent-memory/ konnte nicht angelegt werden"
  fi
fi

# Die Skills der Spezialisten (rollen/*.md, Feld skills) liegen unter 'haupt'.
# Findet die CLI einen davon unter diesem Konto nicht, fehlt er dem
# Spezialisten still. Je Skill ein Link: skills/synced gehoert dem Konto selbst.
HAUPT_SKILLS="/home/claude/.claude/skills"
if "${SSH[@]}" "mkdir -p '$KONTO_DIR/skills' && for s in '$HAUPT_SKILLS'/*/; do s=\${s%/}; n=\${s##*/}; [ \"\$n\" = synced ] || [ -e '$KONTO_DIR/skills/'\"\$n\" ] || ln -s \"\$s\" '$KONTO_DIR/skills/'\"\$n\"; done" 2>/dev/null; then
  ok "skills/ -> Skills aus $HAUPT_SKILLS verlinkt"
else
  fehlt "Skills konnten nicht verlinkt werden"
fi

# --- 3. Kein API-Schluessel im Weg ------------------------------------------
schritt "3/5  Kein ANTHROPIC_API_KEY im Weg"
if "${SSH[@]}" '[ -z "$ANTHROPIC_API_KEY" ]' 2>/dev/null; then
  ok "nicht gesetzt"
else
  fehlt "ANTHROPIC_API_KEY ist auf dem Server gesetzt -- erst entfernen, sonst zahlt dieses Konto pro Token"
fi

# --- 4. Anmeldung -------------------------------------------------------------
schritt "4/5  Anmeldung fuer Konto '$NAME'"
if "${SSH[@]}" "CLAUDE_CONFIG_DIR='$KONTO_DIR' claude auth status 2>/dev/null | grep -q '\"loggedIn\": true'"; then
  ok "Konto '$NAME' ist bereits angemeldet, ueberspringe"
else
  cat <<HINWEIS
   Die Anmeldeseite oeffnet sich gleich in deinem Browser -- fuer das Konto
   '$NAME'. Bitte dort mit DIESEM Konto anmelden, nicht mit dem Hauptkonto.

     1. dort anmelden
     2. die Seite zeigt danach einen kurzen CODE
     3. diesen CODE hier ins Terminal einfuegen und Enter

   Ins Terminal gehoert der CODE von der Webseite -- nicht die URL.

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

  ssh -t -i "$KEY" "claude@$SERVER" "CLAUDE_CONFIG_DIR='$KONTO_DIR' claude auth login" 2>&1 | tee "$SPIEGEL"
  wait "$OEFFNER" 2>/dev/null
  rm -f "$SPIEGEL"

  if "${SSH[@]}" "CLAUDE_CONFIG_DIR='$KONTO_DIR' claude auth status 2>/dev/null | grep -q '\"loggedIn\": true'"; then
    ok "angemeldet"
  else
    fehlt "Anmeldung hat nicht geklappt"
    exit 1
  fi
fi

# Rechte nach der Anmeldung nochmal durchsetzen -- `claude auth login` legt
# Dateien mit seiner eigenen Vorgabe an, und .credentials.json soll wie beim
# Hauptkonto nicht gruppen- oder weltlesbar sein.
"${SSH[@]}" "chmod -R go-rwx '$KONTO_DIR'" 2>/dev/null

# --- 5. Gegenprobe: dieselbe E-Mail wie ein vorhandenes Konto? --------------
schritt "5/5  Gegenprobe gegen vorhandene Konten"
STATUS=$("${SSH[@]}" "CLAUDE_CONFIG_DIR='$KONTO_DIR' claude auth status 2>/dev/null")
NEUE_EMAIL=$(printf '%s' "$STATUS" | json_feld email)
NEUES_ABO=$(printf '%s' "$STATUS" | json_feld subscriptionType)

if [ -z "$NEUE_EMAIL" ]; then
  warn "E-Mail des neuen Kontos nicht ermittelbar -- claude auth status lieferte kein 'email'-Feld"
else
  ok "Konto '$NAME': $NEUE_EMAIL${NEUES_ABO:+ ($NEUES_ABO)}"
fi

HAUPT_EMAIL=$("${SSH[@]}" "claude auth status 2>/dev/null" | json_feld email)
DOPPELT=0
if [ -n "$NEUE_EMAIL" ] && [ "$NEUE_EMAIL" = "$HAUPT_EMAIL" ]; then
  warn "Dieselbe E-Mail wie das Hauptkonto ($HAUPT_EMAIL) -- das bringt keine zusaetzliche Kapazitaet, beide teilen sich ein Limit"
  DOPPELT=1
fi
for VERZ in $("${SSH[@]}" "ls -1 '$KONTEN_WURZEL' 2>/dev/null"); do
  [ "$VERZ" = "$NAME" ] && continue
  ANDERE_EMAIL=$("${SSH[@]}" "CLAUDE_CONFIG_DIR='$KONTEN_WURZEL/$VERZ' claude auth status 2>/dev/null" | json_feld email)
  if [ -n "$NEUE_EMAIL" ] && [ "$NEUE_EMAIL" = "$ANDERE_EMAIL" ]; then
    warn "Dieselbe E-Mail wie Konto '$VERZ' -- vermutlich aus Versehen doppelt angemeldet"
    DOPPELT=1
  fi
done
[ "$DOPPELT" -eq 0 ] && [ -n "$NEUE_EMAIL" ] && ok "keine Ueberschneidung mit anderen Konten"

echo
if [ "$FEHLER" -eq 0 ]; then
  echo "Fertig, keine Fehler. Konto '$NAME' sollte jetzt unter /api/konten auftauchen --"
  echo "kein Neustart des Daemons noetig, die Liste wird bei jedem Aufruf neu gelesen."
else
  echo "$FEHLER Schritt(e) fehlgeschlagen -- oben nachsehen."
fi
exit "$FEHLER"
