/**
 * Akzentfarbe des Cockpits -- je Geraet (localStorage), wie ein Theme in HyDE.
 *
 * Jeder Akzent ist ein Farbpaar wie col.active_border in Hyprland: die erste
 * Farbe fuer Knoepfe und Auswahl, beide zusammen fuer den Rand der aktiven
 * Kachel. Die Werte stehen in stil.css (html[data-akzent]); hier nur Namen
 * und eine Kopie der Farben fuer die Proben in der Auswahl.
 * akzent-frueh.js setzt den gespeicherten Wert schon vor dem ersten Zeichnen.
 */
const SCHLUESSEL = 'cockpit-akzent'

export const AKZENTE = [
  { id: 'hyprland', name: 'Hyprland', a: '#33ccff', b: '#00ff99' },
  { id: 'catppuccin', name: 'Catppuccin', a: '#89b4fa', b: '#cba6f7' },
  { id: 'tokyo', name: 'Tokyo Night', a: '#7aa2f7', b: '#bb9af7' },
  { id: 'rosepine', name: 'Rosé Pine', a: '#ebbcba', b: '#c4a7e7' },
  { id: 'gruvbox', name: 'Gruvbox', a: '#fabd2f', b: '#b8bb26' },
  { id: 'dracula', name: 'Dracula', a: '#bd93f9', b: '#ff79c6' },
  { id: 'blau', name: 'Blau', a: '#3b82f6', b: '#06b6d4' },
  { id: 'lila', name: 'Lila', a: '#a855f7', b: '#e879f9' },
  { id: 'nord', name: 'Nord', a: '#88c0d0', b: '#81a1c1' },
  { id: 'everforest', name: 'Everforest', a: '#a7c080', b: '#dbbc7f' },
  { id: 'kanagawa', name: 'Kanagawa', a: '#7e9cd8', b: '#e6c384' },
  { id: 'synthwave', name: 'Synthwave', a: '#ff2e97', b: '#00e5ff' },
  { id: 'sonnenuntergang', name: 'Sonnenuntergang', a: '#ff7a59', b: '#ffc857' },
  { id: 'matrix', name: 'Matrix', a: '#00ff66', b: '#00b3a4' },
  { id: 'blutmond', name: 'Blutmond', a: '#ff4d6d', b: '#c77dff' },
]

export function akzentLesen() {
  let id = null
  try { id = localStorage.getItem(SCHLUESSEL) } catch { /* privater Modus */ }
  return AKZENTE.some((x) => x.id === id) ? id : 'hyprland'
}

export function akzentSetzen(id) {
  if (!AKZENTE.some((x) => x.id === id)) return
  try { localStorage.setItem(SCHLUESSEL, id) } catch { /* dann nur bis zum Neuladen */ }
  if (id === 'hyprland') delete document.documentElement.dataset.akzent
  else document.documentElement.dataset.akzent = id
  dispatchEvent(new CustomEvent('akzent-geaendert', { detail: id }))
}
