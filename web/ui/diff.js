// Zeilen-Diff fuer die Edit-Ansicht. Eigene Datei ohne DOM-Bezug, damit
// tests/diff.test.mjs sie unter Node pruefen kann.

/**
 * Zeilen-Diff ueber die laengste gemeinsame Teilfolge. Fuer die Groessen,
 * die ein Edit hat (selten mehr als ein paar hundert Zeilen), reicht die
 * quadratische Tabelle; darueber einfach alt komplett weg, neu komplett
 * hinzu -- lieber grob als ein haengender Tab.
 */
export function zeilenDiff(alt, neu) {
  const a = alt === '' ? [] : alt.split('\n')
  const b = neu === '' ? [] : neu.split('\n')
  if (a.length * b.length > 250000) {
    return [...a.map((t) => ['-', t]), ...b.map((t) => ['+', t])]
  }
  const n = a.length, m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const aus = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { aus.push([' ', a[i]]); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) aus.push(['-', a[i++]])
    else aus.push(['+', b[j++]])
  }
  while (i < n) aus.push(['-', a[i++]])
  while (j < m) aus.push(['+', b[j++]])
  return aus
}
