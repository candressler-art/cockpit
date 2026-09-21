/**
 * Tab "Vault" -- Notizen und Agenten in einer 3D-Szene.
 *
 * Zwei Wolken in einer Szene, absichtlich getrennt gelegt:
 *
 *  - unten die NOTIZEN, ruhig, verbunden durch ihre Wikilinks. Kugelgroesse
 *    nach Zahl der Verknuepfungen, Farbe nach Ordner.
 *  - darueber die AGENTEN des gewaehlten Laufs, leuchtend, verbunden
 *    untereinander entlang ihrer Eltern-Kind-Beziehung.
 *
 * Die Trennung in zwei Hoehen ist der Punkt: in einer gemeinsamen Wolke waere
 * nicht mehr zu sehen, was Notiz und was Agent ist, und genau das will man
 * hier sehen.
 *
 * Die Kraftsimulation laeuft in O(n^2). Bei 70 Notizen sind das rund 2400
 * Paare je Bild -- das traegt ein Handy locker, und ein Barnes-Hut-Baum waere
 * hier nur Code ohne Gegenwert.
 */
import * as THREE from '../vendor/three.module.js'
import { api } from '../bus.js'

const FARBEN = [0x89b4fa, 0x94e2d5, 0xcba6f7, 0xf9e2af, 0xfab387, 0xf38ba8, 0xa6e3a1, 0x74c7ec]
const AGENTFARBE = {
  orchestrator: 0x89b4fa,
  rechercheur: 0x94e2d5,
  coder: 0xcba6f7,
  kommunikator: 0xf9e2af,
}

let wurzel = null
let vorn = false
let renderer = null
let szene = null
let kamera = null
let schleife = null
let daten = null
let koerper = []
let beschriftung = null
let aufraeumen = []

function farbeFuer(ordner, tabelle) {
  const k = ordner ?? '(Wurzel)'
  if (!tabelle.has(k)) tabelle.set(k, FARBEN[tabelle.size % FARBEN.length])
  return tabelle.get(k)
}

/**
 * Kraftsimulation: Abstossung zwischen allen, Anziehung entlang der Kanten,
 * schwache Zugkraft zur Mitte, damit nichts davonfliegt. Die Y-Achse wird
 * zusaetzlich zu einer Sollhoehe gezogen -- so bleiben Notizen unten und
 * Agenten oben, auch wenn Kanten dazwischen ziehen.
 */
function schritt(knoten, kanten, daempfung) {
  const n = knoten.length
  for (let i = 0; i < n; i++) {
    const a = knoten[i]
    for (let j = i + 1; j < n; j++) {
      const b = knoten[j]
      let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
      let d2 = dx * dx + dy * dy + dz * dz
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = 0.01 }
      const kraft = 28 / d2
      const d = Math.sqrt(d2)
      a.vx += (dx / d) * kraft; a.vy += (dy / d) * kraft; a.vz += (dz / d) * kraft
      b.vx -= (dx / d) * kraft; b.vy -= (dy / d) * kraft; b.vz -= (dz / d) * kraft
    }
  }
  for (const k of kanten) {
    const a = k.a, b = k.b
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01
    const kraft = (d - 9) * 0.02
    a.vx += (dx / d) * kraft; a.vy += (dy / d) * kraft; a.vz += (dz / d) * kraft
    b.vx -= (dx / d) * kraft; b.vy -= (dy / d) * kraft; b.vz -= (dz / d) * kraft
  }
  for (const k of knoten) {
    k.vx -= k.x * 0.004
    k.vz -= k.z * 0.004
    k.vy += (k.sollY - k.y) * 0.06
    k.vx *= daempfung; k.vy *= daempfung; k.vz *= daempfung
    k.x += k.vx; k.y += k.vy; k.z += k.vz
  }
}

function szeneBauen(el) {
  const breite = el.clientWidth || 800
  const hoehe = el.clientHeight || 500

  szene = new THREE.Scene()
  szene.fog = new THREE.FogExp2(0x11111b, 0.012)
  kamera = new THREE.PerspectiveCamera(55, breite / hoehe, 0.1, 1000)
  kamera.position.set(0, 14, 62)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(breite, hoehe)
  el.appendChild(renderer.domElement)

  szene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const licht = new THREE.PointLight(0xffffff, 1.2, 400)
  licht.position.set(30, 50, 40)
  szene.add(licht)

  // Drehen mit der Maus oder dem Finger. Bewusst kein OrbitControls: das
  // waere eine zweite Datei aus dem three.js-Beispielordner, und gebraucht
  // werden nur Drehen und Zoomen.
  let zieht = false, lx = 0, ly = 0
  let winkel = 0, neigung = 0.25, abstand = 62
  const runter = (e) => { zieht = true; lx = e.clientX; ly = e.clientY }
  const hoch = () => { zieht = false }
  const zieh = (e) => {
    if (!zieht) return
    winkel -= (e.clientX - lx) * 0.005
    neigung = Math.max(-1.2, Math.min(1.2, neigung + (e.clientY - ly) * 0.005))
    lx = e.clientX; ly = e.clientY
  }
  const rad = (e) => {
    e.preventDefault()
    abstand = Math.max(18, Math.min(180, abstand + e.deltaY * 0.06))
  }
  const c = renderer.domElement
  c.addEventListener('pointerdown', runter)
  addEventListener('pointerup', hoch)
  addEventListener('pointermove', zieh)
  c.addEventListener('wheel', rad, { passive: false })
  aufraeumen.push(() => {
    c.removeEventListener('pointerdown', runter)
    removeEventListener('pointerup', hoch)
    removeEventListener('pointermove', zieh)
    c.removeEventListener('wheel', rad)
  })

  return {
    kameraSetzen() {
      kamera.position.set(
        Math.sin(winkel) * Math.cos(neigung) * abstand,
        Math.sin(neigung) * abstand + 8,
        Math.cos(winkel) * Math.cos(neigung) * abstand,
      )
      kamera.lookAt(0, 4, 0)
    },
  }
}

function inhaltBauen(g) {
  for (const o of koerper) {
    szene.remove(o)
    o.geometry?.dispose?.()
    o.material?.dispose?.()
  }
  koerper = []

  const ordnerfarben = new Map()
  const knoten = []
  const nachId = new Map()

  for (const k of g.knoten ?? []) {
    const p = {
      id: k.id, titel: k.titel, typ: 'notiz', ordner: k.ordner,
      x: (Math.random() - 0.5) * 30, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 30,
      vx: 0, vy: 0, vz: 0, sollY: 0,
      r: 0.5 + Math.min(k.grad, 14) * 0.13,
      farbe: farbeFuer(k.ordner, ordnerfarben),
    }
    knoten.push(p); nachId.set(k.id, p)
  }

  for (const a of g.agenten ?? []) {
    const id = `agent:${a.agent_id}`
    const p = {
      id, titel: a.label || a.agent_id, typ: 'agent',
      fachrolle: a.fachrolle, status: a.status,
      x: (Math.random() - 0.5) * 16, y: 18, z: (Math.random() - 0.5) * 16,
      vx: 0, vy: 0, vz: 0, sollY: 18,
      r: 1.1,
      farbe: AGENTFARBE[a.fachrolle] ?? 0x9399b2,
      agentId: a.agent_id, elter: a.parent_agent_id,
    }
    knoten.push(p); nachId.set(id, p)
  }

  const kanten = []
  for (const k of g.kanten ?? []) {
    const a = nachId.get(k.von), b = nachId.get(k.nach)
    if (a && b) kanten.push({ a, b, art: 'notiz' })
  }
  for (const p of knoten) {
    if (p.typ !== 'agent' || !p.elter) continue
    const e = nachId.get(`agent:${p.elter}`)
    if (e) kanten.push({ a: e, b: p, art: 'agent' })
  }

  // Vorrechnen, damit die Szene nicht als Knaeuel aufgeht.
  for (let i = 0; i < 220; i++) schritt(knoten, kanten, 0.82)

  const kugel = new THREE.SphereGeometry(1, 14, 12)
  for (const p of knoten) {
    const m = new THREE.Mesh(kugel, new THREE.MeshStandardMaterial({
      color: p.farbe,
      emissive: p.typ === 'agent' ? p.farbe : 0x000000,
      emissiveIntensity: p.typ === 'agent' ? 0.55 : 0,
      roughness: 0.55,
    }))
    m.scale.setScalar(p.r)
    szene.add(m); koerper.push(m)
    p.mesh = m
  }

  const linien = []
  for (const k of kanten) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    const mat = new THREE.LineBasicMaterial({
      color: k.art === 'agent' ? 0x89b4fa : 0x45475a,
      transparent: true,
      opacity: k.art === 'agent' ? 0.75 : 0.32,
    })
    const l = new THREE.Line(geo, mat)
    szene.add(l); koerper.push(l)
    linien.push({ ...k, linie: l })
  }

  return { knoten, kanten, linien }
}

function beschriftungZeichnen(inhalt) {
  if (!beschriftung) return
  const rect = renderer.domElement.getBoundingClientRect()
  // Agenten immer, Notizen nur die am staerksten verknuepften: siebzig Namen
  // gleichzeitig sind ein grauer Teppich, in dem man nichts mehr liest.
  const agenten = inhalt.knoten.filter((p) => p.typ === 'agent')
  const notizen = inhalt.knoten
    .filter((p) => p.typ !== 'agent')
    .sort((a, b) => b.r - a.r)
    .slice(0, 14)

  const teile = []
  const belegt = []
  for (const p of [...agenten, ...notizen]) {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(kamera)
    if (v.z > 1) continue
    const x = (v.x * 0.5 + 0.5) * rect.width
    const y = (-v.y * 0.5 + 0.5) * rect.height
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) continue
    // Ueberdeckungen wegwerfen statt uebereinanderstapeln. Agenten kommen
    // zuerst durch die Schleife und gewinnen damit jeden Platzstreit.
    if (belegt.some((b) => Math.abs(b.x - x) < 90 && Math.abs(b.y - y) < 16)) continue
    belegt.push({ x, y })
    const titel = p.titel.length > 34 ? p.titel.slice(0, 33) + '\u2026' : p.titel
    teile.push(
      `<span class="vlabel ${p.typ}" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px">` +
      `${titel.replace(/[&<>]/g, '')}</span>`)
  }
  beschriftung.innerHTML = teile.join('')
}

async function laden() {
  const runId = new URLSearchParams(location.search).get('run')
  const r = await fetch(api(`/api/vault/graph${runId ? `?run=${encodeURIComponent(runId)}` : ''}`))
  return r.json()
}

export default {
  id: 'vault',
  titel: 'Vault',
  symbol: '◈',

  async mount(el) {
    wurzel = el
    el.innerHTML = `<div class="vaultkopf">
        <span class="pill" id="vaultstand">wird geladen…</span>
        <div class="spacer"></div>
        <span class="vhinweis">ziehen zum Drehen · Rad zum Zoomen</span>
      </div>
      <div id="vaultbuehne"><div id="vaultlabels"></div></div>`
    const buehne = el.querySelector('#vaultbuehne')
    beschriftung = el.querySelector('#vaultlabels')

    try {
      daten = await laden()
    } catch (e) {
      buehne.innerHTML = `<div class="leer">Vault nicht abrufbar: ${String(e)}</div>`
      return
    }
    if (!daten.spiegelDa) {
      buehne.innerHTML = '<div class="leer">Der Vault-Spiegel fehlt auf dem Server.</div>'
      return
    }

    const steuerung = szeneBauen(buehne)
    const inhalt = inhaltBauen(daten)

    el.querySelector('#vaultstand').textContent =
      `${daten.knoten.length} Notizen · ${daten.kanten.length} Verknüpfungen` +
      `${daten.agenten?.length ? ` · ${daten.agenten.length} Agenten` : ''}`

    let t = 0
    const tick = () => {
      schleife = requestAnimationFrame(tick)
      if (!vorn) return
      t++
      // Nach dem Einschwingen nur noch leicht nachrechnen: die Wolke soll
      // atmen, nicht zappeln.
      schritt(inhalt.knoten, inhalt.kanten, t < 240 ? 0.85 : 0.92)
      for (const p of inhalt.knoten) p.mesh.position.set(p.x, p.y, p.z)
      for (const k of inhalt.linien) {
        k.linie.geometry.setFromPoints([
          new THREE.Vector3(k.a.x, k.a.y, k.a.z),
          new THREE.Vector3(k.b.x, k.b.y, k.b.z),
        ])
      }
      steuerung.kameraSetzen()
      renderer.render(szene, kamera)
      if (t % 4 === 0) beschriftungZeichnen(inhalt)
    }
    tick()

    const groesse = () => {
      if (!renderer) return
      const b = buehne.clientWidth || 800, h = buehne.clientHeight || 500
      renderer.setSize(b, h)
      kamera.aspect = b / h
      kamera.updateProjectionMatrix()
    }
    addEventListener('resize', groesse)
    aufraeumen.push(() => removeEventListener('resize', groesse))
  },

  sichtbar(an) {
    vorn = an
    // Die Schleife laeuft weiter, rendert aber nichts: so bleibt der
    // eingeschwungene Zustand erhalten, ohne im Hintergrund Strom zu ziehen.
    if (an && renderer) {
      const b = wurzel.querySelector('#vaultbuehne')
      if (b) {
        renderer.setSize(b.clientWidth || 800, b.clientHeight || 500)
        kamera.aspect = (b.clientWidth || 800) / (b.clientHeight || 500)
        kamera.updateProjectionMatrix()
      }
    }
  },

  unmount() {
    if (schleife) cancelAnimationFrame(schleife)
    for (const f of aufraeumen) f()
    aufraeumen = []
    renderer?.dispose?.()
    renderer = null
  },
}
