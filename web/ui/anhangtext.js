/**
 * Anhang-Block im Nutzertext erkennen (Gegenstueck zu src/anhaenge.ts:
 * promptMitAnhaengen). Ohne DOM, damit tests/anhaenge.test.mjs es pruefen kann.
 */
export const ANHANG_KOPF = 'Angehängte Dateien (mit Read ansehen):'

/** Wie der Daemon den Prompt baut -- fuer die vorlaeufige Blase beim Senden. */
export function mitAnhaengen(text, pfade) {
  return pfade.length ? `${text}\n\n${ANHANG_KOPF}\n${pfade.map((p) => `- ${p}`).join('\n')}` : text
}

/** Text und Pfade trennen. Ohne Block (oder mit fremden Zeilen darunter) bleibt der Text, wie er ist. */
export function anhaengeTrennen(text) {
  const i = text.lastIndexOf(`\n\n${ANHANG_KOPF}\n`)
  if (i < 0) return { text, anhaenge: [] }
  const zeilen = text.slice(i + ANHANG_KOPF.length + 3).split('\n')
  if (!zeilen.length || !zeilen.every((z) => /^- \/\S/.test(z))) return { text, anhaenge: [] }
  const anhaenge = zeilen.map((z) => {
    const pfad = z.slice(2)
    // Der Daemon stellt jedem Namen 8 Zeichen Zufall voran (anhangSpeichern).
    return { pfad, name: pfad.split('/').pop().replace(/^[0-9a-f]{8}-/, '') }
  })
  return { text: text.slice(0, i), anhaenge }
}

const BILD = /\.(png|jpe?g|gif|webp)$/i
export const istBild = (name) => BILD.test(name)
