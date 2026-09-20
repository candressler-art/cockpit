#!/usr/bin/env bash
# Installiert die gebaute Cockpit-App fuer den aktuellen Benutzer.
# Braucht kein Root: alles landet unter ~/.local.
#
# Kein `set -e`: jeder Schritt meldet sich selbst, und ein fehlender
# Icon-Pfad soll nicht die ganze Installation abbrechen.

WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINAER="$WURZEL/src-tauri/target/release/cockpit"
ZIEL="$HOME/.local/bin/cockpit"

if [ ! -x "$BINAER" ]; then
  echo "FEHLT: $BINAER"
  echo "Erst bauen:  cd $WURZEL && npx tauri build --no-bundle"
  exit 1
fi

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" \
         "$HOME/.local/share/icons/hicolor/512x512/apps"

install -m 755 "$BINAER" "$ZIEL" && echo "Binaer:   $ZIEL"

# Startet Wispr Flow (und ueber dessen Wrapper Obsidian) vor dem Cockpit.
# Gehoert ins Repo und nicht in eine Handaenderung an ~/.local/share/
# applications/cockpit.desktop: diese Datei wird unten neu geschrieben.
install -m 755 "$WURZEL/deploy/cockpit-start.sh" "$HOME/.local/bin/cockpit-start" \
  && echo "Wrapper:  $HOME/.local/bin/cockpit-start"

ICON="$WURZEL/src-tauri/icons/icon.png"
if [ -f "$ICON" ]; then
  install -m 644 "$ICON" "$HOME/.local/share/icons/hicolor/512x512/apps/cockpit.png" \
    && echo "Icon:     ~/.local/share/icons/hicolor/512x512/apps/cockpit.png"
else
  echo "Hinweis: Icon nicht gefunden, App startet trotzdem"
fi

# Der Startereintrag traegt die Daemon-Adresse fest ein. Ohne sie zeigt die App
# auf 127.0.0.1:8765, und wer keinen lokalen Daemon laufen hat, sieht beim
# Klick aufs Icon nur "Kein Daemon erreichbar". Andere Adresse waehlen:
#   COCKPIT_DAEMON=127.0.0.1:8765 ./deploy/installieren-desktop.sh
ADRESSE="${COCKPIT_DAEMON:-servertwo.tail9c8a2b.ts.net:8443}"
sed "s|@ADRESSE@|$ADRESSE|" "$WURZEL/deploy/cockpit.desktop" \
  > "$HOME/.local/share/applications/cockpit.desktop" \
  && chmod 644 "$HOME/.local/share/applications/cockpit.desktop" \
  && echo "Eintrag:  ~/.local/share/applications/cockpit.desktop  (Daemon: $ADRESSE)"

command -v update-desktop-database >/dev/null \
  && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null
command -v gtk-update-icon-cache >/dev/null \
  && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null

echo
echo "Fertig. Starten:"
echo "  ueber Startmenue/Icon                             (Daemon: $ADRESSE)"
echo "  cockpit-start                                    (mit Wispr Flow + Obsidian)"
echo "  cockpit                                          (nackt, ohne Kette)"
echo "  COCKPIT_DAEMON=servertwo.tail9c8a2b.ts.net:8443 cockpit   (Server im Tailnet)"
echo
echo "Hyprland-Keybind: dieses System nutzt die Lua-Konfiguration."
echo "In ~/.config/hypr/hyprland.lua ergaenzen:"
echo ""
echo "  hl.bind(\"SUPER + C\", hl.dsp.exec_cmd(\"env COCKPIT_DAEMON=$ADRESSE cockpit-start\"), {"
echo '      description = "[Utilities] Cockpit",'
echo '  })'
echo ""
echo "SUPER + / zeigt danach, was geladen ist." 
