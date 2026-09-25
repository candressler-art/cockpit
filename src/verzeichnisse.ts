// Ordner durchsuchen fuer die Projektwahl im Chat. Nur Verzeichnisse, keine
// Dateien: die Oberflaeche waehlt ein Arbeitsverzeichnis, sie ist kein
// Dateimanager. Das Cockpit laeuft ohnehin mit den Rechten des Nutzers und
// hat mit dem Terminal einen weit groesseren Zugriff -- hier wird also nichts
// abgeschirmt, nur sauber gemeldet.

import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'

/** Mehr zeigt keine Liste sinnvoll an (node_modules-artige Ordner). */
export const ORDNER_HOECHSTENS = 500

export interface OrdnerListe {
  pfad: string
  /** null an der Wurzel. */
  eltern: string | null
  ordner: { name: string; pfad: string }[]
  /** Mehr als ORDNER_HOECHSTENS Eintraege -- die Liste ist abgeschnitten. */
  gekuerzt: boolean
}

export class OrdnerFehler extends Error {
  constructor(readonly status: 400 | 403 | 404, meldung: string) {
    super(meldung)
  }
}

/**
 * Unterordner von `pfad`, nach Namen sortiert (Gross/klein egal). Versteckte
 * (Punkt) nur auf Wunsch -- sonst stehen .git, .cache, .npm ganz oben.
 * Links auf Ordner zaehlen als Ordner, kaputte Links fallen weg.
 */
export async function ordnerAuflisten(pfad: string, versteckte = false): Promise<OrdnerListe> {
  if (!pfad || !isAbsolute(pfad)) throw new OrdnerFehler(400, 'pfad muss absolut sein')
  const p = normalize(pfad).replace(/(.)\/+$/, '$1')
  let eintraege
  try {
    eintraege = await readdir(p, { withFileTypes: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new OrdnerFehler(404, `${p} gibt es nicht`)
    if (code === 'ENOTDIR') throw new OrdnerFehler(400, `${p} ist kein Ordner`)
    if (code === 'EACCES' || code === 'EPERM') throw new OrdnerFehler(403, `${p}: keine Leserechte`)
    throw e
  }
  const ordner: { name: string; pfad: string }[] = []
  for (const e of eintraege) {
    if (!versteckte && e.name.startsWith('.')) continue
    let istOrdner = e.isDirectory()
    if (e.isSymbolicLink()) {
      istOrdner = await stat(join(p, e.name)).then((s) => s.isDirectory(), () => false)
    }
    if (istOrdner) ordner.push({ name: e.name, pfad: join(p, e.name) })
  }
  ordner.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }))
  return {
    pfad: p,
    eltern: p === '/' ? null : dirname(p),
    ordner: ordner.slice(0, ORDNER_HOECHSTENS),
    gekuerzt: ordner.length > ORDNER_HOECHSTENS,
  }
}
