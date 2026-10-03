/**
 * Die Variante dieses Cockpits (src/variante.ts), wie GET /api/variante sie
 * liefert. app.js fuellt sie beim Start, bevor ein Bereich zeichnet; die
 * Vorgabe ist das Haupt-Cockpit -- so bleibt alles wie bisher, wenn ein
 * aelterer Daemon die Route nicht kennt.
 */
export const variante = {
  id: 'haupt',
  name: 'Cockpit',
  bereicheAus: [],
  arbeitsWurzel: null,
  /** Wer in der Prompt-Zeile und im fastfetch-Kopf steht. */
  nutzer: 'can',
  /** Vorschlaege im leeren Chat; null = die des Haupt-Cockpits. */
  vorschlaege: null,
  /** Bereich PC (wecken/herunterfahren) -- nur, wenn der Daemon einen PC kennt. */
  pc: false,
}
