/**
 * Welche Ereignisse eine Benachrichtigung wert sind -- ohne DOM, damit Node
 * es testen kann (tests/meldungen.test.mjs). Das Zeigen macht web/benachrichtigen.js.
 *
 * Gemeldet wird nur, was auf einen wartet oder fertig ist: Ende eines Chats,
 * offene Freigaben und Rueckfragen, Ende oder Frage eines Team-Auftrags.
 * Angehalten hat man selbst -- das braucht keine Meldung.
 */

const CHAT = /^chat-(.+)$/

/**
 * @param {string} typ   WebSocket-Typ ('agent', 'freigabe', 'lauf_ende')
 * @param {object} d     Nutzlast
 * @param {{ titelVon: (sessionId: string) => string | null }} hilfe
 * @returns {{ titel: string, text: string, ziel: string, tag: string } | null}
 */
export function meldungFuer(typ, d, { titelVon }) {
  if (!d || typeof d !== 'object') return null
  const chat = CHAT.exec(String(d.runId ?? ''))?.[1] ?? null
  const chatTitel = chat ? (titelVon(chat) ?? 'Chat') : null

  if (typ === 'agent') {
    if (d.agentId !== 'chat' || !chat) return null
    if (d.status === 'done') return { titel: 'Claude ist fertig', text: chatTitel, ziel: `#/chat/${chat}`, tag: d.runId }
    if (d.status === 'failed') return { titel: 'Chat mit Fehler beendet', text: chatTitel, ziel: `#/chat/${chat}`, tag: d.runId }
    return null
  }

  if (typ === 'freigabe') {
    if (d.decidedAt || d.decided_at) return null
    const werkzeug = d.toolName ?? d.tool_name ?? 'ein Werkzeug'
    const titel = werkzeug === 'AskUserQuestion' ? 'Claude hat eine Frage'
      : werkzeug === 'ExitPlanMode' ? 'Plan wartet auf dich'
        : 'Freigabe wartet'
    const wo = chat ? chatTitel : (d.agentId ?? 'Team-Auftrag')
    const text = titel === 'Freigabe wartet' ? `${wo}: ${werkzeug}` : wo
    // Tag je Freigabe: zwei offene Freigaben sind zwei Dinge zu tun.
    return { titel, text, ziel: chat ? `#/chat/${chat}` : '#/aufgaben', tag: `freigabe-${d.id ?? werkzeug}` }
  }

  if (typ === 'pc') {
    // Zwei Leute teilen sich den Knopf -- der andere soll es mitbekommen.
    const an = d.aktion === 'wecken'
    return { titel: an ? 'PC wird geweckt' : 'PC fährt herunter', text: an ? 'Gleich bereit für Studio und Blender.' : 'Aus dem Cockpit ausgeschaltet.', ziel: '#/pc', tag: 'pc' }
  }

  if (typ === 'lauf_ende') {
    const grund = d.ende?.grund ?? 'beendet'
    if (grund === 'entscheidung') {
      return { titel: 'Entscheidung gefragt', text: d.ende?.frage || 'Der Orchestrator braucht dich.', ziel: '#/aufgaben', tag: `lauf-${d.runId}` }
    }
    return { titel: 'Team-Auftrag beendet', text: `Grund: ${grund}`, ziel: '#/aufgaben', tag: `lauf-${d.runId}` }
  }

  return null
}
