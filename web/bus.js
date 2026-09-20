/**
 * Bus -- eine Verbindung fuer alle Tabs.
 *
 * Vorher besass die Lauf-Ansicht die WebSocket-Verbindung selbst. Mit mehreren
 * Tabs ginge das nicht mehr gut: jeder Tab haette seine eigene Verbindung
 * aufgemacht, der Daemon haette dieselben Ereignisse mehrfach geschickt, und
 * beim Wechseln waere jedes Mal neu verbunden worden. Deshalb liegt die
 * Verbindung jetzt hier, genau einmal, und die Tabs melden sich an.
 *
 * Der Nachrichtentyp ist der Schluessel: `abonnieren('ereignis', fn)`. Wer
 * jeden Typ sehen will, nimmt '*'.
 */

// Wohin der Client spricht.
//
// Im Browser ist das der Host, von dem die Seite kam. Im Tauri-Fenster nicht:
// dort ist location.host die App selbst. Die Huelle reicht die Adresse des
// Daemons durch, damit dieselbe Oberflaeche lokal, im Tailnet und in der App
// funktioniert, ohne neu gebaut zu werden.
let BASIS = location.host
let IN_TAURI = false
let sock = null

const horcher = new Map()
const zustandHorcher = new Set()

export async function basisErmitteln() {
  const tauri = window.__TAURI__
  if (!tauri?.core?.invoke) return
  IN_TAURI = true
  try {
    const adresse = await tauri.core.invoke('daemon_basis')
    if (adresse) BASIS = adresse
  } catch (e) {
    console.warn('Daemon-Adresse nicht ermittelbar, bleibe bei', BASIS, e)
  }
}

/**
 * Schema der Daemon-Adresse bestimmen.
 *
 * BASIS darf ein Schema mitbringen (`https://servertwo…`). Fehlt es, wird
 * geraten -- und zwar so, wie es in dieser Umgebung stimmt: lokal ist der
 * Daemon unverschluesselt erreichbar, alles andere laeuft ueber
 * `tailscale serve` und damit ausschliesslich ueber TLS. Ein http-Aufruf gegen
 * den Tailnet-Namen liefe sonst ins Leere.
 */
export function schema(fuerWebsocket = false) {
  const m = /^(https?):\/\//.exec(BASIS)
  if (m) return fuerWebsocket ? (m[1] === 'https' ? 'wss' : 'ws') : m[1]
  const host = BASIS.replace(/^.*:\/\//, '')
  const lokal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)
  // Im Browser gilt zusaetzlich das Schema der Seite selbst.
  const sicher = lokal ? (!IN_TAURI && location.protocol === 'https:') : true
  return fuerWebsocket ? (sicher ? 'wss' : 'ws') : sicher ? 'https' : 'http'
}

export const hostOhneSchema = () => BASIS.replace(/^https?:\/\//, '').replace(/\/+$/, '')
export const api = (pfad) => `${schema()}://${hostOhneSchema()}${pfad}`
export const wsUrl = () => `${schema(true)}://${hostOhneSchema()}/ws`
export const basis = () => BASIS

/** Auf einen Nachrichtentyp horchen. Gibt die Abmeldefunktion zurueck. */
export function abonnieren(typ, fn) {
  if (!horcher.has(typ)) horcher.set(typ, new Set())
  horcher.get(typ).add(fn)
  return () => horcher.get(typ)?.delete(fn)
}

/** Auf den Verbindungszustand horchen: fn('verbunden' | 'getrennt'). */
export function beiZustand(fn) {
  zustandHorcher.add(fn)
  return () => zustandHorcher.delete(fn)
}

function melden(zustand) {
  for (const fn of zustandHorcher) {
    try { fn(zustand) } catch (e) { console.warn('Zustandshorcher warf', e) }
  }
}

/**
 * An den Daemon senden. Still verworfen, solange die Verbindung nicht steht --
 * der Aufrufer muesste sonst ueberall denselben Zustand pruefen, und nach dem
 * Wiederverbinden holt das `folgen` mit `seit` den Rueckstand ohnehin nach.
 */
export function senden(obj) {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj))
}

/** Was beim (Wieder-)Verbinden geschickt wird. Setzt die Lauf-Ansicht. */
let anmeldung = () => null

export function anmeldungSetzen(fn) { anmeldung = fn }

export function verbinden() {
  sock = new WebSocket(wsUrl())
  sock.onopen = () => {
    melden('verbunden')
    const a = anmeldung()
    if (a) sock.send(JSON.stringify(a))
  }
  sock.onclose = () => {
    melden('getrennt')
    // Wiederverbinden mit Backfill ab letzteSeq: kein Loch im Verlauf.
    setTimeout(verbinden, 1500)
  }
  sock.onmessage = (ev) => {
    const { typ, daten } = JSON.parse(ev.data)
    for (const fn of horcher.get(typ) ?? []) {
      try { fn(daten) } catch (e) { console.warn(`Horcher fuer '${typ}' warf`, e) }
    }
    for (const fn of horcher.get('*') ?? []) {
      try { fn(typ, daten) } catch (e) { console.warn('Sammelhorcher warf', e) }
    }
  }
}
