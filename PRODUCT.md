# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Ein einziger Nutzer: Can (15, Leipzig), Linux-Ricer (CachyOS, Hyprland, HyDE, wechselt gern Themes), FPV, Homelab, Roblox. Er nutzt das Cockpit gleich oft am Handy (Samsung S22 Ultra, Chrome, ca. 384 px breit) und am Rechner (MacBook als Safari-Web-App, PC als Tauri-App unter Hyprland). Oft ist er nur kurz am Handy und will in Sekunden sehen, ob er dran ist (Freigabe, Rückfrage) und was gerade läuft.

## Product Purpose

Eigene Oberfläche für Claude Code auf seinem Server: chatten, Spezialisten (Planer, Entwickler, Prüfer …) arbeiten lassen, Freigaben und Rückfragen beantworten, Autopilot-Läufe (Aufgaben) verfolgen, Limits/Guthaben (Nutzung), Server, Notizen (Obsidian-Spiegel), Terminal, Einstellungen. Erfolg: Can findet in einem Blick, was wichtig ist, und muss nicht suchen, scrollen oder raten.

## Positioning

Kein Claude-Desktop-Klon: sein eigenes Werkzeug, das sich wie sein Desktop anfühlt. Es zeigt Spezialisten, Autopilot und mehrere Konten, was die offizielle App nicht kann.

## Operating Context

Handy unterwegs und abends, Rechner am Schreibtisch. Lange Chats mit Hunderten Werkzeugaufrufen. Diktat per Mikro, Live-Vorschau von HTML-Entwürfen. Verbindung über Tailscale.

## Capabilities and Constraints

- Vanilla JS + CSS ohne Build-Schritt (`web/`), Bausteine `h()`/`symbol()` in `web/ui/dom.js`. Änderungen an `web/` wirken ohne Neustart.
- Keine externen Anfragen zur Laufzeit: Schriften selbst gehostet (OFL).
- UI-Texte Deutsch mit echten Umlauten.
- Ausdrücklich gewollt (26.09.): echte Anzeigen statt Zierde, eindeutige Zustände mit Text, Diktat-Ablauf wie abgenommen.

## Brand Commitments

- Richtung von Can gewählt (02.10.2026): „Hyprland-Rice“, also Graphit statt Lila-Grau, Panels wie Kacheln, Mono-Labels, eine kräftige Akzentfarbe, wählbar in den Einstellungen.
- Nur dunkles Thema (von Can gewählt).
- Was ihn am alten Look störte: wirkt generisch, zu blass (alles grau-lila), Chats unübersichtlich, am Handy zu eng und klein.

## Product Principles

1. Wann Can dran ist, sieht man sofort und überall.
2. Ergebnis vor Arbeitsschritten: Antworten lesen sich zuerst, Werkzeugarbeit tritt zurück.
3. Handy und Rechner sind gleichwertig.
4. Seins: anpassbar wie sein Rice, aber nie auf Kosten der Lesbarkeit.

## Accessibility & Inclusion

ADHS: wenig Rauschen, klare Hierarchie, keine Deko-Bewegung. Kontrast mindestens AA, Text eher AAA. `prefers-reduced-motion` beachten. Tippziele am Handy mindestens 44 px.
