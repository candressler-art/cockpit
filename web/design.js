/**
 * Design des Cockpits -- je Geraet (localStorage), zweite Achse neben dem Akzent.
 *
 * Der Akzent (akzent.js) waehlt nur das Farbpaar. Das Design waehlt Form und
 * Charakter: Ecken, Rahmen, Schrift, Flaechen, Schatten, Kachelstil und das
 * Motiv des Wallpapers (wallpaper.js). Jedes Design faerbt sich aus dem
 * gewaehlten Akzent, also passt jede Kombination. Die Regeln stehen in
 * designs.css (html[data-design]); akzent-frueh.js setzt den gespeicherten
 * Wert schon vor dem ersten Zeichnen.
 */
const SCHLUESSEL = 'cockpit-design'

export const DESIGNS = [
  { id: 'glas', name: 'Glas', hinweis: 'Durchsichtige Kacheln mit Blur über Low-Poly-Bergen, Verlaufsrand.' },
  { id: 'terminal', name: 'Terminal', hinweis: 'Alles Mono, scharfe Ecken, Linien wie im TTY, Raster statt Bild.' },
  { id: 'neon', name: 'Neon', hinweis: 'Synthwave-Gitter mit Sonne, leuchtende Ränder, breite Schrift.' },
  { id: 'brutal', name: 'Brutal', hinweis: 'Dicke Ränder, harte Schatten, volle Farbflächen, große schmale Schrift.' },
  { id: 'ruhig', name: 'Ruhig', hinweis: 'Kein Bild, feste Flächen, weiche Ecken, viel Luft, leise Farben.' },
]

export function designLesen() {
  let id = null
  try { id = localStorage.getItem(SCHLUESSEL) } catch { /* privater Modus */ }
  return DESIGNS.some((x) => x.id === id) ? id : 'glas'
}

export function designSetzen(id) {
  if (!DESIGNS.some((x) => x.id === id)) return
  try { localStorage.setItem(SCHLUESSEL, id) } catch { /* dann nur bis zum Neuladen */ }
  if (id === 'glas') delete document.documentElement.dataset.design
  else document.documentElement.dataset.design = id
  dispatchEvent(new CustomEvent('design-geaendert', { detail: id }))
}
