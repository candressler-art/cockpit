// Konsole mit Freigabe.
//
// Bewusst KEINE offene Shell im Netz. Auf dieser Maschine liegen Pi-hole,
// ntfy, das Monitoring und die Cockpit-Datenbank; ein zweiter Dienst mit
// Vollzugriff waere auch im Tailnet der falsche Tausch -- er waere eine
// zweite, separat zu pflegende Angriffsflaeche statt einer.
//
// Stattdessen geht jeder Befehl durch denselben Freigabe-Broker wie ein
// Werkzeugaufruf eines Agenten: er wird angefragt, erscheint im Cockpit,
// wartet auf ein ausdrueckliches Ja und steht danach mit Ergebnis im
// Nachweis. Ein Befehl, den ein Mensch tippt, ist nicht weniger
// pruefenswert als einer, den ein Agent vorschlaegt.
//
// Was hier absichtlich fehlt: ein "immer erlauben", ein Merken frueherer
// Entscheidungen, ein interaktives Terminal. Alles drei wuerde die Freigabe
// aushoehlen, die der ganze Punkt dieser Loesung ist.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Supervisor } from './supervisor.js'

/** Laenger darf kein Befehl laufen. Danach wird die Gruppe abgeraeumt. */
const TIMEOUT_MS = Number(process.env.COCKPIT_KONSOLE_TIMEOUT_MS ?? 120_000)
/** Mehr Ausgabe als das schickt niemand durch eine Weboberflaeche. */
const MAX_AUSGABE = 256 * 1024

export interface KonsoleErgebnis {
  id: string
  befehl: string
  cwd: string
  phase: 'abgelehnt' | 'fertig' | 'fehler'
  code: number | null
  stdout: string
  stderr: string
  dauerMs: number
  grund?: string
}

function kuerzen(t: string): string {
  if (t.length <= MAX_AUSGABE) return t
  return t.slice(0, MAX_AUSGABE) + `\n\n[… ${t.length - MAX_AUSGABE} Zeichen abgeschnitten]`
}

/**
 * Einen Befehl anfragen und -- nach Freigabe -- ausfuehren.
 *
 * Gibt sofort die Freigabe-Id zurueck, damit die Oberflaeche die Anfrage
 * anzeigen kann, und daneben das Versprechen auf das Ergebnis.
 */
export function konsoleBefehl(
  supervisor: Supervisor,
  befehl: string,
  cwd: string,
  melden: (e: Record<string, unknown>) => void,
): { id: string; ergebnis: Promise<KonsoleErgebnis> } {
  const { id, entschieden } = supervisor.freigabeAnfragen('konsole', 'Bash', {
    command: befehl,
    cwd,
    description: 'Befehl aus der Cockpit-Konsole',
  })

  const ergebnis = (async (): Promise<KonsoleErgebnis> => {
    const { erlaubt, grund } = await entschieden
    if (!erlaubt) {
      const e: KonsoleErgebnis = {
        id, befehl, cwd, phase: 'abgelehnt', code: null,
        stdout: '', stderr: '', dauerMs: 0, grund: grund ?? 'abgelehnt',
      }
      melden(e as unknown as Record<string, unknown>)
      return e
    }

    const start = Date.now()
    melden({ id, phase: 'laeuft', befehl, cwd })

    return await new Promise<KonsoleErgebnis>((fertig) => {
      // 'bash -lc' und nicht direkt: der Nutzer erwartet eine Shell mit
      // Pipes, Umleitungen und seinem PATH. Das ist der Zweck, nicht ein
      // Versehen -- abgesichert wird ueber die Freigabe davor, nicht ueber
      // das Wegnehmen der Shell.
      const kind = execFile(
        '/bin/bash', ['-lc', befehl],
        { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_AUSGABE * 2, killSignal: 'SIGKILL' },
        (fehler, stdout, stderr) => {
          const e: KonsoleErgebnis = {
            id, befehl, cwd,
            phase: 'fertig',
            code: kind.exitCode,
            stdout: kuerzen(String(stdout ?? '')),
            stderr: kuerzen(String(stderr ?? '')),
            dauerMs: Date.now() - start,
          }
          if (fehler && (fehler as { killed?: boolean }).killed) {
            e.phase = 'fehler'
            e.grund = `abgebrochen nach ${Math.round(TIMEOUT_MS / 1000)} s`
          } else if (fehler && kind.exitCode === null) {
            e.phase = 'fehler'
            e.grund = fehler.message
          }
          melden(e as unknown as Record<string, unknown>)
          fertig(e)
        },
      )
    })
  })()

  return { id, ergebnis }
}

/** Prueft ein Arbeitsverzeichnis, bevor ueberhaupt eine Freigabe angefragt wird. */
export function cwdPruefen(cwd: string): string | null {
  if (!cwd) return 'cwd fehlt'
  if (!cwd.startsWith('/')) return 'cwd muss ein absoluter Pfad sein'
  if (!existsSync(cwd)) return `${cwd} gibt es auf diesem Host nicht`
  return null
}
