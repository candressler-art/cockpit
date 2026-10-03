#!/usr/bin/env python3
"""Gefilterte Studio-MCP-Bruecke fuer das Roblox-Cockpit.

Laeuft auf Cans PC, gestartet vom erzwungenen Befehl studio-freund (Schluessel
pc_studio). Dahinter laeuft die echte Bruecke (mcp.bat in Vinegar), die ALLE
offenen Studios sieht -- auch Steal a Robot vom Autopilot. Der Filter laesst
nur durch, was zu den freigegebenen Orten gehoert:

- list_roblox_studios zeigt nur Studios mit freigegebener placeId,
- jedes andere Werkzeug nur mit einer studio_id eines solchen Studios,
- gesperrt: Werkzeuge, die Dateien auf dem PC lesen/schreiben oder beliebige
  Adressen abrufen (upload_image, store_image, http_get),
- dazu ein eigenes Werkzeug studio_oeffnen: oeffnet einen freigegebenen Ort in
  einem (weiteren) Studio.

Freigegebene Orte: ~/.config/studio-freund/orte.json
  {"orte": [{"name": "Spielname", "placeId": 123, "universeId": 456}]}
Die Datei schreibt nur Can (bzw. das Haupt-Cockpit), nie das Roblox-Cockpit.
Sie wird bei jeder Pruefung neu gelesen.

Protokoll: JSON-RPC, eine Nachricht pro Zeile, in beide Richtungen.
"""
import itertools
import json
import os
import re
import subprocess
import sys
import threading
import time

HOME = os.path.expanduser("~")
# Die beiden Umgebungsvariablen sind nur fuer den Test (tests/studioFilter.test.mjs);
# ueber den erzwungenen SSH-Befehl kann sie niemand setzen.
ORTE = os.environ.get("STUDIO_FILTER_ORTE") or os.path.join(HOME, ".config", "studio-freund", "orte.json")
WINE = os.path.join(HOME, ".local/share/vinegar/kombucha/bin/wine")
PREFIX = os.path.join(HOME, ".local/share/vinegar/prefixes/studio")
APPDATA = "Z:" + os.path.join(HOME, ".local/share/vinegar/appdata/Roblox").replace("/", "\\")

GESPERRT = {
    "upload_image": "liest Dateien vom PC",
    "store_image": "schreibt Dateien auf den PC",
    "http_get": "ruft beliebige Adressen aus dem Heimnetz ab",
}
EIGENES = {
    "name": "studio_oeffnen",
    "description": (
        "Oeffnet ein freigegebenes Spiel in Roblox Studio auf dem PC (falls es noch nicht offen ist). "
        "Danach list_roblox_studios wiederholen, bis es erscheint (Laden dauert bis zu 3 Minuten). "
        "Ohne placeId: das erste freigegebene Spiel. Liefert die Liste der freigegebenen Spiele."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {"placeId": {"type": "integer", "description": "placeId eines freigegebenen Spiels"}},
    },
}


def log(text):
    print(f"[studio-filter] {text}", file=sys.stderr, flush=True)


def orte_lesen():
    try:
        with open(ORTE, encoding="utf-8") as f:
            roh = json.load(f)
    except (OSError, ValueError):
        return []
    orte = []
    for o in roh.get("orte", []) if isinstance(roh, dict) else []:
        try:
            orte.append({"name": str(o.get("name", "")), "placeId": int(o["placeId"]), "universeId": int(o["universeId"])})
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return orte


# Die Bruecke liefert {"id": "...", "name": "<Spielname> (placeId: 123)"}. Den
# Spielnamen kann Luau aendern (game.Name), das angehaengte "(placeId: N)" am
# ENDE setzt Studio selbst -- deshalb zaehlt nur das letzte, am Ende verankert.
PLACE_IM_NAMEN = re.compile(r"\(placeId: (\d+)\)\s*$")


def place_von(studio):
    if not isinstance(studio, dict):
        return None
    m = PLACE_IM_NAMEN.search(str(studio.get("name", "")))
    return int(m.group(1)) if m else None


def studio_id_von(studio):
    for k in ("id", "studio_id", "studioId"):
        if k in studio:
            return str(studio[k])
    return None


def text_von(ergebnis):
    return "".join(c.get("text", "") for c in (ergebnis or {}).get("content", []) if isinstance(c, dict))


def ergebnis(text, fehler=False):
    return {"content": [{"type": "text", "text": text}], "isError": fehler}


class Filter:
    def __init__(self):
        env = dict(os.environ, WINEPREFIX=PREFIX)
        befehl = json.loads(os.environ["STUDIO_FILTER_BRUECKE"]) if os.environ.get("STUDIO_FILTER_BRUECKE") \
            else [WINE, "cmd", "/c", f"cd /d {APPDATA} && mcp.bat"]
        self.bruecke = subprocess.Popen(
            befehl,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
        )
        self.schreib_lock = threading.Lock()
        self.aus_lock = threading.Lock()
        # Antworten, die der Filter selbst erwartet: id -> [Event, Antwort]
        self.intern = {}
        # Anfragen des Cockpits, deren Antwort gefiltert werden muss: id -> Art
        self.offen = {}
        self.zaehler = itertools.count(1)

    # --- Schreiben ---
    def an_bruecke(self, msg):
        with self.schreib_lock:
            self.bruecke.stdin.write((json.dumps(msg) + "\n").encode())
            self.bruecke.stdin.flush()

    def an_cockpit(self, msg):
        with self.aus_lock:
            sys.stdout.write(json.dumps(msg) + "\n")
            sys.stdout.flush()

    # --- Studios, wie die Bruecke sie sieht (ungefiltert) ---
    def studios_roh(self, frist=30):
        mid = f"filter-{next(self.zaehler)}"
        warte = [threading.Event(), None]
        self.intern[mid] = warte
        self.an_bruecke({"jsonrpc": "2.0", "id": mid, "method": "tools/call",
                         "params": {"name": "list_roblox_studios", "arguments": {}}})
        warte[0].wait(frist)
        self.intern.pop(mid, None)
        try:
            return json.loads(text_von((warte[1] or {}).get("result"))).get("studios", [])
        except (ValueError, AttributeError):
            return []

    def erlaubte_ids(self):
        plaetze = {o["placeId"] for o in orte_lesen()}
        return {studio_id_von(s) for s in self.studios_roh() if place_von(s) in plaetze} - {None}

    # --- Bruecke -> Cockpit ---
    def von_bruecke(self):
        for zeile in self.bruecke.stdout:
            try:
                msg = json.loads(zeile)
            except ValueError:
                continue
            mid = msg.get("id")
            if mid in self.intern:
                self.intern[mid][1] = msg
                self.intern[mid][0].set()
                continue
            art = self.offen.pop(mid, None) if mid is not None else None
            if art == "tools/list" and isinstance(msg.get("result"), dict):
                werkzeuge = [w for w in msg["result"].get("tools", []) if w.get("name") not in GESPERRT]
                msg["result"]["tools"] = werkzeuge + [EIGENES]
            elif art == "studios" and isinstance(msg.get("result"), dict):
                plaetze = {o["placeId"] for o in orte_lesen()}
                try:
                    roh = json.loads(text_von(msg["result"]))
                    roh["studios"] = [s for s in roh.get("studios", []) if place_von(s) in plaetze]
                    msg["result"] = ergebnis(json.dumps(roh))
                except (ValueError, AttributeError):
                    msg["result"] = ergebnis('{"studios":[]}')
            self.an_cockpit(msg)
        log("Bruecke beendet")
        os._exit(0)

    # --- Cockpit -> Bruecke ---
    def antworten(self, mid, res):
        if mid is not None:
            self.an_cockpit({"jsonrpc": "2.0", "id": mid, "result": res})

    def werkzeug(self, msg):
        mid = msg.get("id")
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name in GESPERRT:
            return self.antworten(mid, ergebnis(f"{name} ist im Roblox-Cockpit gesperrt ({GESPERRT[name]}).", True))
        if name == "studio_oeffnen":
            return self.antworten(mid, self.oeffnen(args))
        if name == "list_roblox_studios":
            self.offen[mid] = "studios"
            return self.an_bruecke(msg)
        sid = args.get("studio_id")
        if sid is None or str(sid) not in self.erlaubte_ids():
            return self.antworten(mid, ergebnis(
                "Diese studio_id gehoert zu keinem freigegebenen Spiel. Erst list_roblox_studios aufrufen; "
                "ist die Liste leer, mit studio_oeffnen das Spiel oeffnen.", True))
        self.an_bruecke(msg)

    def oeffnen(self, args):
        orte = orte_lesen()
        if not orte:
            return ergebnis("Noch kein Spiel freigegeben. Das macht der Besitzer des PCs.", True)
        liste = ", ".join(f"{o['name'] or 'ohne Namen'} (placeId {o['placeId']})" for o in orte)
        wunsch = args.get("placeId")
        ort = next((o for o in orte if wunsch is None or str(o["placeId"]) == str(wunsch)), None)
        if ort is None:
            return ergebnis(f"placeId {wunsch} ist nicht freigegeben. Freigegeben: {liste}", True)
        if any(place_von(s) == ort["placeId"] for s in self.studios_roh()):
            return ergebnis(f"{ort['name'] or ort['placeId']} ist schon offen. Freigegeben: {liste}")
        fehler = studio_starten(ort)
        if fehler:
            return ergebnis(fehler, True)
        return ergebnis(f"Studio fuer {ort['name'] or ort['placeId']} wird geoeffnet. list_roblox_studios "
                        f"wiederholen, bis es erscheint (bis zu 3 Minuten). Freigegeben: {liste}")

    def laufen(self):
        threading.Thread(target=self.von_bruecke, daemon=True).start()
        for zeile in sys.stdin:
            try:
                msg = json.loads(zeile)
            except ValueError:
                continue
            methode = msg.get("method")
            if methode == "tools/call":
                # Eigener Faden: die Pruefung fragt selbst die Bruecke und darf
                # das Lesen weiterer Nachrichten nicht blockieren.
                threading.Thread(target=self.werkzeug, args=(msg,), daemon=True).start()
                continue
            if methode == "tools/list":
                self.offen[msg.get("id")] = "tools/list"
            self.an_bruecke(msg)
        self.bruecke.kill()


def studio_starten(ort):
    """Wie studio-start.sh des Autopiloten: ueber die laufende Hyprland-Sitzung."""
    laufzeit = f"/run/user/{os.getuid()}"
    hypr = os.path.join(laufzeit, "hypr")
    try:
        sitzungen = sorted(
            (d for d in os.listdir(hypr) if os.path.exists(os.path.join(hypr, d, ".socket.sock"))),
            key=lambda d: os.path.getmtime(os.path.join(hypr, d)), reverse=True)
    except OSError:
        sitzungen = []
    if not sitzungen:
        return "Auf dem PC laeuft keine Desktop-Sitzung -- Studio laesst sich gerade nicht oeffnen."
    env = dict(os.environ, XDG_RUNTIME_DIR=laufzeit, HYPRLAND_INSTANCE_SIGNATURE=sitzungen[0])
    befehl = f"vinegar -task EditPlace -placeId {ort['placeId']} -universeId {ort['universeId']}"
    try:
        r = subprocess.run(["hyprctl", "dispatch", f'hl.dsp.exec_cmd("{befehl}")'],
                           env=env, capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"Studio-Start fehlgeschlagen: {e}"
    if r.returncode != 0:
        return f"Studio-Start fehlgeschlagen: {r.stdout.decode(errors='replace')[:200]}"
    return None


if __name__ == "__main__":
    Filter().laufen()
