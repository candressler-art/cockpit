// Buchfuehrung ueber laufende Chat-Zuege (POST /api/chats/<id>/weiter).
//
// Steht in einer eigenen Datei, weil daemon.ts beim Import den Server startet
// und sich deshalb nicht direkt testen laesst.
//
// Warum mehr als eine Map id -> startSeq: agentAbbrechen setzt 'stopped'
// synchron, die Oberflaeche gibt daraufhin "Senden" wieder frei -- aber der
// abgebrochene Zug laeuft im Supervisor noch aus (SDK-Subprozess beenden),
// und erst danach wird der Eintrag geraeumt. Wer in diesem Fenster wieder
// sendet, bekam 409 "schreibt gerade schon weiter". Einfach durchlassen geht
// nicht: zwei agentStarten mit demselben Schluessel ueberschreiben sich in
// supervisor.laufende, und das finally des alten Zugs loeschte den Eintrag
// des neuen -- der liesse sich dann nicht mehr stoppen. Also: ist der alte
// Zug laut Supervisor schon im Endzustand, kurz auf sein Auslaufen warten.

type Zug = { startSeq: number; fertig: Promise<void> }

/**
 * Status, in denen ein Agent nichts mehr tut -- nur noch auslaufen kann.
 * Dieselbe Liste, nach der web/ui/chat.js den Zug beendet und "Senden"
 * wieder freigibt ('waiting_ratelimit': alle Konten gesperrt, Zug endet).
 */
const ENDZUSTAENDE = new Set(['done', 'failed', 'stopped', 'waiting_ratelimit'])

export class ChatZuege {
  private zuege = new Map<string, Zug>()

  laeuft(id: string): boolean {
    return this.zuege.has(id)
  }

  startSeq(id: string): number | undefined {
    return this.zuege.get(id)?.startSeq
  }

  /**
   * Zug eintragen und `arbeit` starten. Der Eintrag faellt weg, sobald
   * `arbeit` fertig ist -- egal ob mit Erfolg oder Ausnahme (die Ausnahme
   * behandelt `arbeit` selbst; hier wird sie nur geschluckt, damit kein
   * unbehandeltes Versprechen den Prozess stoert).
   */
  starten(id: string, startSeq: number, arbeit: () => Promise<void>): void {
    // Erst eintragen, dann starten: arbeit laeuft synchron bis zum ersten
    // await an, und endet sie ganz ohne await, muss finally den Eintrag
    // schon vorfinden, sonst bliebe er fuer immer stehen.
    const zug: Zug = { startSeq, fertig: Promise.resolve() }
    this.zuege.set(id, zug)
    zug.fertig = (async () => {
      try { await arbeit() } catch { /* Sache von arbeit */ } finally {
        if (this.zuege.get(id) === zug) this.zuege.delete(id)
      }
    })()
  }

  /**
   * Frei fuer einen neuen Zug? true sofort, wenn keiner laeuft. Laeuft einer,
   * aber `agentStatus` meldet schon einen Endzustand, wird bis `wartenMs` auf
   * sein Auslaufen gewartet. Sonst (Agent arbeitet wirklich) false.
   */
  async freiWerden(id: string, agentStatus: string | undefined, wartenMs: number): Promise<boolean> {
    const z = this.zuege.get(id)
    if (!z) return true
    if (!agentStatus || !ENDZUSTAENDE.has(agentStatus)) return false
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      z.fertig,
      new Promise<void>((r) => { timer = setTimeout(r, wartenMs) }),
    ])
    clearTimeout(timer)
    return !this.zuege.has(id)
  }
}
