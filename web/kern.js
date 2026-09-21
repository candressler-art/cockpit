/**
 * Der Wissenskern -- eine pulsierende Kugelschale aus echten Notizen.
 *
 * Kein Zierobjekt: jeder Punkt ist eine Notiz aus dem Obsidian-Vault, jede
 * Linie eine echte Verknuepfung. Was leuchtet, wurde gerade von einem Agenten
 * angefasst. Was sich bewegt, bewegt sich, weil etwas passiert -- der
 * Herzschlag folgt der gemessenen Last, die Helligkeit dem tatsaechlichen
 * Sprachpegel.
 *
 * Technisch nach der Recherche:
 *   - Fibonacci-Spirale statt Zufall: gleichmaessige Verteilung auf der
 *     Schale, aus jedem Blickwinkel dicht.
 *   - THREE.Points mit eigenem Shader statt einzelner Kugel-Meshes. Bei 500
 *     Knoten ist das ein Zeichenaufruf statt 500, und auf Handy-GPUs
 *     guenstiger als InstancedMesh mit echter Geometrie.
 *   - Kanten als EINE LineSegments-Geometrie, ebenfalls ein Zeichenaufruf.
 *   - Doppelpuls ueber smoothstep statt sin: zwei ungleiche Spitzen mit
 *     Ruhephase lesen sich als Herzschlag, ein Sinus als Blinken.
 *   - Erregung breitet sich per Breitensuche ueber die ECHTEN Kanten aus,
 *     nicht ueber einen Radius im Raum.
 */
import * as THREE from './vendor/three.module.js'

const VERTEX = `
attribute float aPhase;
attribute float aAktiv;
attribute vec3 aFarbe;
uniform float uZeit;
uniform float uPuls;
uniform float uPegel;
uniform float uGroesse;
varying float vAktiv;
varying vec3 vFarbe;

void main() {
  vAktiv = aAktiv;
  vFarbe = aFarbe;

  // Atmen der ganzen Schale plus ein eigener Versatz je Punkt, damit die
  // Oberflaeche lebt statt starr zu skalieren.
  float atmen = 1.0 + uPuls * 0.06 + sin(uZeit * 0.7 + aPhase * 6.2831) * 0.012;
  vec3 pos = position * atmen;

  // Angefasste Knoten treten nach aussen -- die Schale bekommt Beulen dort,
  // wo gearbeitet wird.
  pos += normalize(position) * aAktiv * 1.8;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float basis = uGroesse * (1.0 + aAktiv * 2.2 + uPegel * 0.5 + uPuls * 0.25);
  gl_PointSize = basis * (260.0 / -mv.z);
}
`

const FRAGMENT = `
uniform float uPegel;
varying float vAktiv;
varying vec3 vFarbe;

void main() {
  // Weicher Kreis ohne Textur: billiger als ein Sprite und scharf auf jedem
  // Pixelverhaeltnis.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float rand = smoothstep(0.5, 0.06, r);
  float kern = smoothstep(0.32, 0.0, r);

  vec3 farbe = mix(vFarbe, vec3(1.0), kern * (0.45 + vAktiv * 0.5));
  float staerke = rand * (0.32 + vAktiv * 0.85 + uPegel * 0.22);
  gl_FragColor = vec4(farbe, staerke);
}
`

/** Fibonacci-Spirale: gleichmaessige Punkte auf der Einheitskugel. */
function kugelpunkt(i, n) {
  const versatz = 2 / n
  const y = i * versatz - 1 + versatz / 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const phi = i * Math.PI * (3 - Math.sqrt(5))
  return [Math.cos(phi) * r, y, Math.sin(phi) * r]
}

/**
 * Doppelpuls. Zwei ungleiche Spitzen, dann Ruhe -- lub-dub.
 * Ein Sinus an dieser Stelle sieht aus wie eine blinkende Leuchtdiode.
 */
function herzschlag(phase) {
  const s = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  const eins = s(0, 0.08, phase) * (1 - s(0.08, 0.2, phase))
  const zwei = s(0.22, 0.29, phase) * (1 - s(0.29, 0.42, phase)) * 0.55
  return eins + zwei
}

export class Wissenskern {
  /**
   * @param {HTMLElement} behaelter
   * @param {{farben?: Record<string,number>}} opt
   */
  constructor(behaelter, opt = {}) {
    this.behaelter = behaelter
    this.farben = opt.farben ?? {}
    this.knoten = []
    this.nachbarn = new Map()
    this.erregung = new Map()
    this.pulsrate = 0.55
    this.pulsZiel = 0.55
    this.pegel = 0
    this.zeit = 0
    this.laeuft = false
    this.schleife = null
    this.drehung = 0

    const b = behaelter.clientWidth || 600
    const h = behaelter.clientHeight || 420

    this.szene = new THREE.Scene()
    this.kamera = new THREE.PerspectiveCamera(50, b / h, 0.1, 600)
    this.kamera.position.set(0, 0, 118)

    // Kein Antialias, kein Stencil, gedeckeltes Pixelverhaeltnis: das ist der
    // Unterschied zwischen fluessig und heiss auf einem Mittelklasse-Handy.
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, alpha: true, stencil: false, powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    this.renderer.setSize(b, h)
    behaelter.appendChild(this.renderer.domElement)

    this.gruppe = new THREE.Group()
    this.szene.add(this.gruppe)

    this._groesse = () => this.anpassen()
    addEventListener('resize', this._groesse)
  }

  /**
   * Daten setzen. Erwartet das Format von /api/vault/graph.
   * Erneutes Setzen baut die Geometrie neu -- das passiert selten (der Index
   * aendert sich nur, wenn Notizen dazukommen).
   */
  setzen(graph) {
    this.abbauen(false)
    const roh = graph?.knoten ?? []
    const n = Math.max(1, roh.length)
    this.knoten = roh
    this.index = new Map(roh.map((k, i) => [k.id, i]))

    const radius = 44
    const pos = new Float32Array(n * 3)
    const phase = new Float32Array(n)
    const aktiv = new Float32Array(n)
    const farbe = new Float32Array(n * 3)
    const c = new THREE.Color()

    for (let i = 0; i < n; i++) {
      const [x, y, z] = kugelpunkt(i, n)
      // Stark verknuepfte Notizen sitzen etwas weiter innen: der Kern wird
      // dichter, wo der Vault dicht ist.
      const tiefe = radius * (1 - Math.min(0.28, (roh[i]?.grad ?? 0) * 0.02))
      pos[i * 3] = x * tiefe
      pos[i * 3 + 1] = y * tiefe
      pos[i * 3 + 2] = z * tiefe
      phase[i] = (i * 0.618) % 1
      aktiv[i] = 0
      c.set(this.farben[roh[i]?.ordner ?? ''] ?? 0x6fe3ff)
      farbe[i * 3] = c.r
      farbe[i * 3 + 1] = c.g
      farbe[i * 3 + 2] = c.b
    }

    const geo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(pos, 3)
    posAttr.setUsage(THREE.StaticDrawUsage)
    this.aktivAttr = new THREE.BufferAttribute(aktiv, 1)
    this.aktivAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
    geo.setAttribute('aAktiv', this.aktivAttr)
    geo.setAttribute('aFarbe', new THREE.BufferAttribute(farbe, 3))

    this.uniforms = {
      uZeit: { value: 0 },
      uPuls: { value: 0 },
      uPegel: { value: 0 },
      uGroesse: { value: 2.1 },
    }
    this.punkte = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }))
    this.gruppe.add(this.punkte)

    // --- Kanten: eine Geometrie, ein Zeichenaufruf ---
    const kanten = (graph?.kanten ?? []).filter(
      (k) => this.index.has(k.von) && this.index.has(k.nach),
    )
    this.nachbarn = new Map()
    const linien = new Float32Array(kanten.length * 6)
    kanten.forEach((k, i) => {
      const a = this.index.get(k.von)
      const b2 = this.index.get(k.nach)
      for (let j = 0; j < 3; j++) {
        linien[i * 6 + j] = pos[a * 3 + j]
        linien[i * 6 + 3 + j] = pos[b2 * 3 + j]
      }
      if (!this.nachbarn.has(a)) this.nachbarn.set(a, [])
      if (!this.nachbarn.has(b2)) this.nachbarn.set(b2, [])
      this.nachbarn.get(a).push(b2)
      this.nachbarn.get(b2).push(a)
    })
    const lgeo = new THREE.BufferGeometry()
    lgeo.setAttribute('position', new THREE.BufferAttribute(linien, 3))
    this.linien = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({
      color: 0x6fe3ff, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending,
      depthWrite: false,
    }))
    this.gruppe.add(this.linien)
  }

  /**
   * Eine Notiz wurde angefasst. Die Erregung laeuft ueber die echten Kanten
   * weiter, hoechstens zwei Spruenge weit -- tiefer wird es teuer und der
   * Effekt ist ohnehin nicht mehr zuzuordnen.
   */
  anstossen(notizId, tiefe = 2) {
    const start = this.index?.get(notizId)
    if (start === undefined) return
    const jetzt = performance.now()
    const gesehen = new Set([start])
    let rand = [start]
    for (let d = 0; d <= tiefe; d++) {
      for (const i of rand) this.erregung.set(i, jetzt + d * 140)
      const naechste = []
      for (const i of rand) {
        for (const nb of this.nachbarn.get(i) ?? []) {
          if (gesehen.has(nb)) continue
          gesehen.add(nb)
          naechste.push(nb)
        }
      }
      rand = naechste
      if (!rand.length) break
    }
  }

  /** Herzschlagrate aus echter Last: 0 ruhig, 1 hektisch. */
  lastSetzen(anteil) {
    this.pulsZiel = 0.45 + Math.min(1, Math.max(0, anteil)) * 1.5
  }

  /** Sprachpegel 0..1 aus dem Analyser. */
  pegelSetzen(p) {
    this.pegel = p
  }

  anpassen() {
    if (!this.renderer) return
    const b = this.behaelter.clientWidth || 600
    const h = this.behaelter.clientHeight || 420
    this.renderer.setSize(b, h)
    this.kamera.aspect = b / h
    this.kamera.updateProjectionMatrix()
  }

  starten() {
    if (this.laeuft) return
    this.laeuft = true
    let vorher = performance.now()
    const bild = (jetzt) => {
      if (!this.laeuft) { this.schleife = null; return }
      this.schleife = requestAnimationFrame(bild)
      const dt = Math.min(0.05, (jetzt - vorher) / 1000)
      vorher = jetzt
      this.zeichnen(jetzt, dt)
    }
    this.schleife = requestAnimationFrame(bild)
  }

  anhalten() {
    this.laeuft = false
    if (this.schleife) cancelAnimationFrame(this.schleife)
    this.schleife = null
  }

  zeichnen(jetzt, dt) {
    if (!this.punkte) return
    this.zeit += dt
    // Die Rate wird gefuehrt, nicht gesetzt: springt die Last, soll der Puls
    // nachziehen und nicht zucken.
    this.pulsrate += (this.pulsZiel - this.pulsrate) * Math.min(1, dt * 0.8)

    const phase = (this.zeit * this.pulsrate) % 1
    const puls = herzschlag(phase)
    this.uniforms.uZeit.value = this.zeit
    this.uniforms.uPuls.value = puls
    this.uniforms.uPegel.value = this.pegel

    // Erregung abklingen lassen. Nur die betroffenen Punkte werden
    // geschrieben -- der Rest bleibt unberuehrt.
    if (this.erregung.size) {
      const a = this.aktivAttr.array
      let min = Infinity
      let max = -Infinity
      for (const [i, ab] of [...this.erregung]) {
        const alter = (jetzt - ab) / 1000
        if (alter < 0) continue
        const wert = Math.max(0, 1 - alter / 2.4)
        a[i] = wert
        if (i < min) min = i
        if (i > max) max = i
        if (wert <= 0.001) { a[i] = 0; this.erregung.delete(i) }
      }
      if (max >= min) {
        this.aktivAttr.addUpdateRange(min, max - min + 1)
        this.aktivAttr.needsUpdate = true
      }
    }

    // Langsame Eigendrehung, vom Puls leicht moduliert.
    this.drehung += dt * (0.055 + puls * 0.05)
    this.gruppe.rotation.y = this.drehung
    this.gruppe.rotation.x = Math.sin(this.zeit * 0.11) * 0.16

    if (this.linien) this.linien.material.opacity = 0.1 + puls * 0.1 + this.pegel * 0.08

    this.renderer.render(this.szene, this.kamera)
  }

  abbauen(ganz = true) {
    this.punkte?.geometry.dispose()
    this.punkte?.material.dispose()
    this.linien?.geometry.dispose()
    this.linien?.material.dispose()
    if (this.punkte) this.gruppe.remove(this.punkte)
    if (this.linien) this.gruppe.remove(this.linien)
    this.punkte = null
    this.linien = null
    this.erregung.clear()
    if (ganz) {
      this.anhalten()
      removeEventListener('resize', this._groesse)
      this.renderer?.dispose()
      this.renderer?.domElement?.remove()
      this.renderer = null
    }
  }
}
