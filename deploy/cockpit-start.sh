#!/bin/bash
# Startet Wispr Flow vor dem Cockpit -- damit sofort diktiert werden kann,
# ohne die App erst von Hand zu suchen.
#
# Die Kette ist zweistufig: dieser Wrapper holt Wispr Flow, und Wispr Flow
# holt seinerseits ueber ~/.local/bin/wispr-flow-mit-obsidian das Obsidian
# dazu. Hier wird Obsidian deshalb bewusst NICHT noch einmal angefasst.
#
# Wird von installieren-desktop.sh nach ~/.local/bin/cockpit-start gelegt;
# der Desktop-Eintrag ruft diesen Wrapper statt der nackten Binary auf.
WISPR_WRAPPER="$HOME/.local/bin/wispr-flow-mit-obsidian"

# Prozess-Check statt Fenster-Check: Wispr Flow laeuft absichtlich ohne
# sichtbares Fenster (der Boot-Autostart schliesst sie weg). Ein Fenster-Check
# wuerde es deshalb fuer tot halten und bei jedem Start ein zweites
# hochziehen.
if ! pgrep -x wispr-flow >/dev/null 2>&1; then
  if [ -x "$WISPR_WRAPPER" ]; then
    "$WISPR_WRAPPER" >/dev/null 2>&1 &
  else
    /usr/bin/wispr-flow >/dev/null 2>&1 &
  fi

  # Nur auf den Prozess warten (max 10s), nicht auf ein Fenster. Das Cockpit
  # muss nicht warten, bis Wispr bereit ist -- es soll nur nicht davor da
  # sein und den Fokus klauen. Laeuft der Deckel ab, wird fortgefahren:
  # lieber Cockpit ohne Wispr als gar kein Cockpit.
  for _ in $(seq 1 20); do
    pgrep -x wispr-flow >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

exec "$HOME/.local/bin/cockpit" "$@"
