// Wyoming-Rahmen: eine Kopfzeile JSON, optional gefolgt von Rohdaten.
//
// stimme.ts (Piper) und hoeren.ts (Whisper) sprechen dasselbe Protokoll, nur
// in entgegengesetzte Richtung. Das Zerlegen und Bauen steht hier einmal,
// bewusst ohne Netzwerk -- ein Socket ist fuer einen Test dieser Logik nicht
// noetig, und stimme.ts hatte genau das lange Zeit privat und ungetestet
// eingebaut.

export interface WyomingEreignis {
  type: string
  data: Record<string, unknown>
  payload: Buffer | null
}

interface WyomingKopf {
  type: string
  data?: Record<string, unknown>
  data_length?: number | null
  payload_length?: number | null
}

/**
 * Ein Ereignis als Bytes bauen: Kopfzeile plus optionale Rohdaten direkt
 * danach. `daten` landet inline im Kopf (fuer kleine Felder wie rate/width/
 * channels -- alles, was hier gebraucht wird), `data_length` (grosse, separat
 * codierte JSON-Anhaenge) erzeugt dieser Schreiber bewusst nicht, weil weder
 * Piper noch Whisper das beim Senden von hier aus brauchen.
 */
export function wyomingSchreiben(
  typ: string,
  daten?: Record<string, unknown>,
  payload?: Buffer,
): Buffer {
  const kopf: WyomingKopf = { type: typ }
  if (daten) kopf.data = daten
  if (payload && payload.length > 0) kopf.payload_length = payload.length
  const zeile = Buffer.from(JSON.stringify(kopf) + '\n', 'utf-8')
  return payload && payload.length > 0 ? Buffer.concat([zeile, payload]) : zeile
}

function istObjekt(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Laengenfeld aus dem Kopf: fehlt/null = 0, sonst ganze Zahl >= 0. */
function laenge(x: unknown, feld: string): number {
  if (x === undefined || x === null) return 0
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) {
    throw new Error(`${feld} ist keine gueltige Laenge`)
  }
  return x
}

/**
 * Zerlegt einen Bytestrom in Wyoming-Ereignisse. Haelt unvollstaendige Reste
 * ueber mehrere schieben()-Aufrufe hinweg fest -- Daten aus einem TCP-Socket
 * kommen nicht ereignisweise an, ein 'data'-Callback kann mitten in einer
 * Kopfzeile oder mitten in den Rohdaten enden.
 */
export class WyomingLeser {
  private puffer: Buffer = Buffer.alloc(0)

  /** Neue Bytes einspielen, alle inzwischen vollstaendigen Ereignisse zurueckgeben. */
  schieben(stueck: Buffer): WyomingEreignis[] {
    this.puffer = this.puffer.length ? Buffer.concat([this.puffer, stueck]) : stueck
    const ergebnisse: WyomingEreignis[] = []

    for (;;) {
      const nl = this.puffer.indexOf(0x0a)
      if (nl < 0) break

      let kopf: WyomingKopf
      try {
        kopf = JSON.parse(this.puffer.subarray(0, nl).toString('utf-8')) as WyomingKopf
      } catch {
        throw new Error('kein gueltiges JSON in der Kopfzeile')
      }
      // Gueltiges JSON ist noch kein Kopf: `null` liess kopf.data_length einen
      // TypeError werfen, eine Laenge wie "abc" ergab gesamt = NaN -- dann
      // verbrauchte die Schleife nichts und lief ewig (Daemon haengt).
      if (!istObjekt(kopf) || typeof kopf.type !== 'string') {
        throw new Error('Kopfzeile ist kein Wyoming-Ereignis')
      }
      const dLen = laenge(kopf.data_length, 'data_length')
      const pLen = laenge(kopf.payload_length, 'payload_length')
      const gesamt = nl + 1 + dLen + pLen
      if (this.puffer.length < gesamt) break // noch nicht alles da

      let daten: unknown = kopf.data ?? {}
      if (dLen > 0) {
        try {
          daten = JSON.parse(this.puffer.subarray(nl + 1, nl + 1 + dLen).toString('utf-8'))
        } catch {
          throw new Error('kein gueltiges JSON im Datenfeld')
        }
      }
      if (!istObjekt(daten)) throw new Error('Datenfeld ist kein Objekt')
      const payload = pLen > 0 ? Buffer.from(this.puffer.subarray(nl + 1 + dLen, gesamt)) : null
      this.puffer = this.puffer.subarray(gesamt)
      ergebnisse.push({ type: kopf.type, data: daten, payload })
    }

    return ergebnisse
  }
}
