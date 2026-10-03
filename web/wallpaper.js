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
import { designLesen } from './design.js'

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

/* --- Motive der anderen Designs (design.js) ----------------------------------- */

const kopf = (B, H) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${B} ${H}" preserveAspectRatio="xMidYMid slice">`

/** Terminal: Phosphor-Raster mit Zeilen wie auf einer Roehre, kein Bild. */
function terminalSvg({ a }) {
  const B = 1600, H = 1000
  const fein = mischen(a, GRUND, 0.07), grob = mischen(a, GRUND, 0.15)
  let linien = ''
  for (let x = 0; x <= B; x += 32) linien += `<path d="M${x} 0V${H}" stroke="${x % 160 ? fein : grob}"/>`
  for (let y = 0; y <= H; y += 32) linien += `<path d="M0 ${y}H${B}" stroke="${y % 160 ? fein : grob}"/>`
  // Kreuze an den groben Schnittpunkten, wie Passmarken.
  let kreuze = ''
  for (let x = 160; x < B; x += 320) for (let y = 160; y < H; y += 320) {
    kreuze += `<path d="M${x - 6} ${y}H${x + 6}M${x} ${y - 6}V${y + 6}" stroke="${mischen(a, GRUND, 0.45)}" stroke-width="1.5"/>`
  }
  return kopf(B, H)
    + `<defs><radialGradient id="g" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="${mischen(a, GRUND, 0.10)}"/><stop offset="1" stop-color="#030404"/></radialGradient>`
    + `<pattern id="z" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="2" fill="#000" opacity=".28"/></pattern></defs>`
    + `<rect width="${B}" height="${H}" fill="url(#g)"/><g stroke-width="1" shape-rendering="crispEdges">${linien}</g>${kreuze}`
    + `<rect width="${B}" height="${H}" fill="url(#z)"/></svg>`
}

/** Neon: Synthwave -- Sonne mit Schlitzen ueber einem Perspektivgitter. */
function neonSvg({ a, b, id }) {
  const z = zufall(saatVon(id + 'neon'))
  const B = 1600, H = 1000, hz = 600, mx = 800
  const nacht = '#05030a'
  let sterne = ''
  for (let i = 0; i < 70; i++) {
    sterne += `<circle cx="${(z() * B).toFixed(0)}" cy="${(z() * hz * 0.75).toFixed(0)}" r="${z() < 0.1 ? 1.6 : 0.9}" fill="#fff" opacity="${(0.15 + z() * 0.5).toFixed(2)}"/>`
  }
  // Schlitze in der unteren Sonnenhaelfte, nach unten breiter.
  let schlitze = ''
  for (let i = 0, y = hz - 150; i < 7; i++) { const d = 4 + i * 3.2; schlitze += `<rect x="0" y="${y.toFixed(0)}" width="${B}" height="${d.toFixed(1)}" fill="#000"/>`; y += d + 14 }
  // Boden: waagerechte Linien rücken zum Horizont zusammen, senkrechte laufen im Fluchtpunkt zusammen.
  let gitter = ''
  for (let i = 1; i < 16; i++) { const y = hz + (H - hz) * Math.pow(i / 15, 2.1); gitter += `<path d="M0 ${y.toFixed(1)}H${B}"/>` }
  for (let i = -16; i <= 16; i++) gitter += `<path d="M${mx} ${hz}L${mx + i * 150} ${H}"/>`
  // Ferne Berge als flache Silhouette, damit der Horizont Tiefe hat.
  let berg = `M0 ${hz}`
  for (let x = 0; x <= B; x += 80) berg += `L${x} ${(hz - 18 - z() * (Math.abs(x - mx) > 380 ? 70 : 18)).toFixed(0)}`
  berg += `L${B} ${hz}Z`
  return kopf(B, H)
    + `<defs><linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${nacht}"/><stop offset=".45" stop-color="${mischen(b, nacht, 0.16)}"/><stop offset=".6" stop-color="${mischen(a, nacht, 0.42)}"/></linearGradient>`
    + `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mischen(b, '#ffffff', 0.85)}"/><stop offset="1" stop-color="${a}"/></linearGradient>`
    + `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mischen(a, nacht, 0.22)}"/><stop offset=".35" stop-color="${nacht}"/></linearGradient>`
    + `<mask id="m"><rect width="${B}" height="${H}" fill="#fff"/>${schlitze}</mask>`
    + `<radialGradient id="glut"><stop offset="0" stop-color="${a}" stop-opacity=".45"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient></defs>`
    + `<rect width="${B}" height="${H}" fill="url(#h)"/>${sterne}`
    + `<circle cx="${mx}" cy="${hz - 120}" r="420" fill="url(#glut)"/>`
    + `<circle cx="${mx}" cy="${hz - 120}" r="230" fill="url(#s)" mask="url(#m)"/>`
    + `<path d="${berg}" fill="${mischen(b, nacht, 0.10)}"/>`
    + `<rect y="${hz}" width="${B}" height="${H - hz}" fill="url(#f)"/>`
    + `<g stroke="${a}" stroke-width="1.6" opacity=".55">${gitter}</g>`
    + `<path d="M0 ${hz}H${B}" stroke="${mischen(a, '#ffffff', 0.7)}" stroke-width="2.5"/></svg>`
}

/** Brutal: flache Vollfarben, grosse Grundformen, harte Kanten -- kein Verlauf. */
function brutalSvg({ a, b }) {
  const B = 1600, H = 1000, grund = '#0b0c0e'
  const fa = mischen(a, grund, 0.30), fb = mischen(b, grund, 0.24), fc = mischen(a, grund, 0.12)
  let streifen = ''
  for (let i = 0; i < 14; i++) streifen += `<path d="M${-200 + i * 56} ${H}L${200 + i * 56} ${H - 400}" stroke="${fc}" stroke-width="22"/>`
  let punkte = ''
  for (let x = 1040; x < 1560; x += 26) for (let y = 70; y < 330; y += 26) punkte += `<circle cx="${x}" cy="${y}" r="4.5" fill="${fc}"/>`
  return kopf(B, H)
    + `<rect width="${B}" height="${H}" fill="${grund}"/>`
    + `<circle cx="1330" cy="820" r="420" fill="${fa}"/>`
    + `<rect x="-60" y="90" width="720" height="250" fill="${fb}"/>`
    + `<rect x="-60" y="90" width="720" height="250" fill="none" stroke="#000" stroke-width="14" transform="translate(28 28)"/>`
    + `<g>${streifen}</g>${punkte}`
    + `<rect x="900" y="520" width="140" height="140" fill="${mischen(b, grund, 0.55)}"/></svg>`
}

const MOTIVE = { glas: wallpaperSvg, terminal: terminalSvg, neon: neonSvg, brutal: brutalSvg, ruhig: null }

/** Fuer die Vorschau in den Einstellungen: Motiv eines Designs als CSS-url() oder 'none'. */
export function tapeteUrl(designId, akzentId = akzentLesen()) {
  const akzent = AKZENTE.find((x) => x.id === akzentId) ?? AKZENTE[0]
  const motiv = MOTIVE[designId] === undefined ? wallpaperSvg : MOTIVE[designId]
  if (!motiv) return 'none'
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(motiv(akzent))}")`
}

export function wallpaperSetzen(id = akzentLesen(), design = designLesen()) {
  document.documentElement.style.setProperty('--tapete', tapeteUrl(design, id))
}
