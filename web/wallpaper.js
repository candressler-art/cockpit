/**
 * Wallpaper hinter den Kacheln -- wie der Desktop-Hintergrund in Hyprland.
 *
 * Kein Foto, sondern eine Low-Poly-Berglandschaft als SVG, gebaut aus dem
 * Farbpaar des gewaehlten Akzents: Himmel mit Sternen und Mond, davor vier
 * Bergketten von hell (fern, im Akzent) nach fast schwarz (nah). Jedes Theme
 * hat seinen eigenen Startwert, also eigene Berge. Gesetzt wird die
 * CSS-Variable --tapete auf <html>; stil.css legt sie hinter alles.
 */
import { AKZENTE, akzentLesen } from './akzent.js'

const GRUND = '#07080a'

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}
/** Farbe a zu Anteil t (0..1) ueber Farbe b mischen. */
function mischen(a, b, t) {
  const [x, y] = [rgb(a), rgb(b)]
  return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('')
}
/** Kleiner, fester Zufall (mulberry32): dasselbe Theme ergibt immer dieselben Berge. */
function zufall(saat) {
  let s = saat >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const saatVon = (text) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)

/**
 * Eine Bergkette: abwechselnd Tal und Gipfel mit geraden Kanten (Low-Poly),
 * dazu je Gipfel eine dunklere Flanke bis zum Bildrand -- das gibt die Facetten.
 */
function kette(z, k, B, H) {
  const punkte = []
  const schritt = B / k.zacken
  for (let i = 0; i <= k.zacken; i++) {
    const x = i * schritt + (i && i < k.zacken ? (z() - 0.5) * schritt * 0.5 : 0)
    const gipfel = i % 2 === 1
    const y = gipfel ? k.hoehe - k.unruhe * (0.45 + z() * 0.55) : k.hoehe + k.unruhe * (z() * 0.25)
    punkte.push([x, y])
  }
  const p = (pt) => `${pt[0].toFixed(0)},${pt[1].toFixed(0)}`
  let svg = `<polygon points="0,${H} ${punkte.map(p).join(' ')} ${B},${H}" fill="${k.farbe}"/>`
  for (let i = 1; i < punkte.length - 1; i += 2) {
    const [g, t] = [punkte[i], punkte[i + 1]]
    const fuss = [g[0] + (t[0] - g[0]) * (0.15 + z() * 0.3), H]
    svg += `<polygon points="${p(g)} ${p(t)} ${t[0].toFixed(0)},${H} ${p(fuss)}" fill="${k.schatten}"/>`
  }
  return svg
}

export function wallpaperSvg(akzent) {
  const { a, b, id } = akzent
  const z = zufall(saatVon(id))
  const B = 1600, H = 1000
  const himmelOben = mischen(a, GRUND, 0.08)
  const himmelMitte = mischen(b, GRUND, 0.16)
  const horizont = mischen(a, GRUND, 0.40)
  const mond = mischen(a, '#ffffff', 0.55)
  const ketten = [
    { farbe: mischen(a, GRUND, 0.52), hoehe: 600, zacken: 9, unruhe: 260 },
    { farbe: mischen(b, GRUND, 0.34), hoehe: 700, zacken: 11, unruhe: 210 },
    { farbe: mischen(a, GRUND, 0.18), hoehe: 800, zacken: 15, unruhe: 160 },
    { farbe: mischen(b, GRUND, 0.08), hoehe: 900, zacken: 19, unruhe: 110 },
  ].map((k) => ({ ...k, schatten: mischen(k.farbe, GRUND, 0.72) }))
  const mx = 1050 + z() * 300, my = 230 + z() * 90
  let sterne = ''
  for (let i = 0; i < 90; i++) {
    const x = z() * B, y = z() * 520, r = z() < 0.12 ? 1.8 : 1
    sterne += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r}" fill="#fff" opacity="${(0.2 + z() * 0.6).toFixed(2)}"/>`
  }
  const berge = ketten.map((k) => kette(z, k, B, H)).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${B} ${H}" preserveAspectRatio="xMidYMid slice">`
    + `<defs><linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${himmelOben}"/><stop offset=".45" stop-color="${himmelMitte}"/><stop offset=".72" stop-color="${horizont}"/></linearGradient>`
    + `<radialGradient id="m"><stop offset="0" stop-color="${mond}" stop-opacity=".55"/><stop offset="1" stop-color="${mond}" stop-opacity="0"/></radialGradient></defs>`
    + `<rect width="${B}" height="${H}" fill="url(#h)"/>${sterne}`
    + `<circle cx="${mx.toFixed(0)}" cy="${my.toFixed(0)}" r="210" fill="url(#m)"/><circle cx="${mx.toFixed(0)}" cy="${my.toFixed(0)}" r="62" fill="${mond}"/>`
    + berge + '</svg>'
}

export function wallpaperSetzen(id = akzentLesen()) {
  const akzent = AKZENTE.find((x) => x.id === id) ?? AKZENTE[0]
  const url = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(wallpaperSvg(akzent))}")`
  document.documentElement.style.setProperty('--tapete', url)
}
