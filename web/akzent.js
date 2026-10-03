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
