// Turns a cut-out (transparent background) image into sticker textures:
//   art   — the photo, cropped and padded, straight RGBA
//   shape — R: die-cut coverage (anti-aliased); G/B unused, A opaque
// The border is grown with a Euclidean distance transform on a low-res copy
// of the alpha, then upsampled bilinearly so the outline stays smooth.

export type Cut = 'angular' | 'smooth'

export interface Sticker {
  art: HTMLCanvasElement
  shape: Uint8Array // RGBA, w*h*4
  mask: Uint8Array // R channel only, for hit testing
  w: number
  h: number
  corner: [number, number] // bottom-right-most point of the cut, tex px
}

const MAX_SUBJECT = 1600 // longest side of the subject in the texture
const LOW = 640 // longest side of the working grid for distance fields
const INF = 1e20
const ROUND = 1.0 // angular cut: corner radius, as a share of the border

export function buildSticker(src: CanvasImageSource & { width: number; height: number }, border: number, cut: Cut): Sticker {
  // 1. crop to the subject
  const probe = canvas(src.width, src.height)
  const pc = probe.getContext('2d', { willReadFrequently: true })!
  pc.drawImage(src, 0, 0)
  const pa = pc.getImageData(0, 0, src.width, src.height).data
  let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (pa[(y * src.width + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) throw new Error('The image is fully transparent.')
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1
  const k = Math.min(1, MAX_SUBJECT / Math.max(bw, bh))
  const S = Math.max(bw, bh) * k
  const B = border * S
  const pad = Math.ceil(1.6 * B + 0.02 * S + 12)
  const w = Math.round(bw * k) + pad * 2
  const h = Math.round(bh * k) + pad * 2

  // 2. the art texture
  const art = canvas(w, h)
  const ac = art.getContext('2d', { willReadFrequently: true })!
  ac.imageSmoothingQuality = 'high'
  ac.drawImage(src, x0, y0, bw, bh, pad, pad, bw * k, bh * k)

  // 3. low-res binary subject, specks dropped
  const f = Math.min(1, LOW / Math.max(w, h))
  const lw = Math.max(2, Math.round(w * f)), lh = Math.max(2, Math.round(h * f))
  const fx = lw / w, fy = lh / h
  const low = canvas(lw, lh)
  const lc = low.getContext('2d', { willReadFrequently: true })!
  lc.drawImage(art, 0, 0, lw, lh)
  const la = lc.getImageData(0, 0, lw, lh).data
  const subj = new Uint8Array(lw * lh)
  for (let i = 0; i < subj.length; i++) subj[i] = la[i * 4 + 3] > 110 ? 1 : 0
  dropSmall(subj, lw, lh, 0.004)

  // 4. grow the border
  const out = edt(subj, lw, lh) // distance to the subject, low px
  const Bl = B * f
  const grow = cut === 'angular' ? 0.55 * Bl : Bl
  const shapeLow = new Uint8Array(lw * lh)
  for (let i = 0; i < shapeLow.length; i++) shapeLow[i] = out[i] <= Bl ? 1 : 0

  let polys: [number, number][][] = []
  if (cut === 'angular') {
    // trace the grown outline and simplify it hard: facets like a hand cut
    const filled = fillHoles(shapeLow, lw, lh)
    polys = traceAll(filled, lw, lh).map((c) => simplifyClosed(c, Math.max(1.5, 0.5 * Bl)))
    shapeLow.fill(0)
    const pl = canvas(lw, lh)
    const plc = pl.getContext('2d', { willReadFrequently: true })!
    fillPolys(plc, polys.map((p) => p.map(([x, y]) => [x + 0.5, y + 0.5] as [number, number])), 1, ROUND * Bl)
    const pd = plc.getImageData(0, 0, lw, lh).data
    for (let i = 0; i < shapeLow.length; i++) shapeLow[i] = pd[i * 4 + 3] > 127 || out[i] <= grow ? 1 : 0
  }
  const solid = fillHoles(shapeLow, lw, lh)

  // 5. full-res coverage: smooth offset ∪ polygon ∪ filled holes
  let poly: Uint8ClampedArray | null = null
  if (polys.length) {
    const pc2 = canvas(w, h).getContext('2d', { willReadFrequently: true })!
    fillPolys(pc2, polys.map((p) => p.map(([x, y]) => [(x + 0.5) / fx, (y + 0.5) / fy] as [number, number])), 1, (ROUND * Bl) / fx)
    poly = pc2.getImageData(0, 0, w, h).data
  }
  const holes = new Uint8Array(lw * lh)
  for (let i = 0; i < holes.length; i++) holes[i] = solid[i] && !shapeLow[i] ? 1 : 0
  const holesD = edt(holes, lw, lh)


  const shape = new Uint8Array(w * h * 4)
  const mask = new Uint8Array(w * h)
  const pxLow = 1 / f // full px per low px
  let cx = 0, cy = 0, best = -1
  for (let y = 0; y < h; y++) {
    const ly = (y + 0.5) * fy - 0.5
    for (let x = 0; x < w; x++) {
      const lx = (x + 0.5) * fx - 0.5
      const od = sample(out, lw, lh, lx, ly) * pxLow
      let c = clamp01(0.5 - (od - grow * pxLow))
      if (poly) c = Math.max(c, poly[(y * w + x) * 4 + 3] / 255)
      if (sample(holesD, lw, lh, lx, ly) < 1.5) c = 1
      const i = y * w + x
      const m = Math.round(c * 255)
      shape[i * 4] = m
      shape[i * 4 + 3] = 255
      mask[i] = m
      if (m > 200 && x + y > best) { best = x + y; cx = x; cy = y }
    }
  }
  return { art, shape, mask, w, h, corner: [cx, cy] }
}

export function hasTransparency(src: CanvasImageSource & { width: number; height: number }): boolean {
  const s = Math.min(1, 256 / Math.max(src.width, src.height))
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s))
  const c = canvas(w, h).getContext('2d', { willReadFrequently: true })!
  c.drawImage(src, 0, 0, w, h)
  const d = c.getImageData(0, 0, w, h).data
  let clear = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] < 16) clear++
  return clear / (w * h) > 0.03
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth01 = (v: number) => {
  const t = clamp01(v)
  return t * t * (3 - 2 * t)
}

function sample(a: Float32Array, w: number, h: number, x: number, y: number) {
  x = Math.min(Math.max(x, 0), w - 1)
  y = Math.min(Math.max(y, 0), h - 1)
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1)
  const tx = x - x0, ty = y - y0
  const a0 = a[y0 * w + x0] + (a[y0 * w + x1] - a[y0 * w + x0]) * tx
  const a1 = a[y1 * w + x0] + (a[y1 * w + x1] - a[y1 * w + x0]) * tx
  return a0 + (a1 - a0) * ty
}

// Felzenszwalb & Huttenlocher exact Euclidean distance to the nearest set pixel
function edt(bin: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h)
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1)
  const v = new Int32Array(n)
  const g = new Float64Array(w * h)
  for (let i = 0; i < g.length; i++) g[i] = bin[i] ? 0 : INF
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x]
    edt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) g[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x]
    edt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) g[y * w + x] = d[x]
  }
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(g[i])
  return out
}

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

// 4-connected components; returns labels (0 = background) and their areas
function label(bin: Uint8Array, w: number, h: number) {
  const lab = new Int32Array(w * h)
  const areas = [0]
  const stack: number[] = []
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || lab[i]) continue
    const id = areas.length
    let area = 0
    lab[i] = id
    stack.push(i)
    while (stack.length) {
      const j = stack.pop()!
      area++
      const x = j % w, y = (j / w) | 0
      if (x > 0 && bin[j - 1] && !lab[j - 1]) { lab[j - 1] = id; stack.push(j - 1) }
      if (x < w - 1 && bin[j + 1] && !lab[j + 1]) { lab[j + 1] = id; stack.push(j + 1) }
      if (y > 0 && bin[j - w] && !lab[j - w]) { lab[j - w] = id; stack.push(j - w) }
      if (y < h - 1 && bin[j + w] && !lab[j + w]) { lab[j + w] = id; stack.push(j + w) }
    }
    areas.push(area)
  }
  return { lab, areas }
}

function dropSmall(bin: Uint8Array, w: number, h: number, frac: number) {
  const { lab, areas } = label(bin, w, h)
  const total = areas.reduce((a, b) => a + b, 0)
  for (let i = 0; i < bin.length; i++) if (lab[i] && areas[lab[i]] < total * frac) bin[i] = 0
}

// everything not reachable from the border becomes solid
function fillHoles(bin: Uint8Array, w: number, h: number) {
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (i: number) => {
    if (!bin[i] && !outside[i]) { outside[i] = 1; stack.push(i) }
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (stack.length) {
    const j = stack.pop()!
    const x = j % w, y = (j / w) | 0
    if (x > 0) push(j - 1)
    if (x < w - 1) push(j + 1)
    if (y > 0) push(j - w)
    if (y < h - 1) push(j + w)
  }
  const solid = new Uint8Array(w * h)
  for (let i = 0; i < solid.length; i++) solid[i] = outside[i] ? 0 : 1
  return solid
}

// Moore-neighbour outline of every component
const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]

function traceAll(bin: Uint8Array, w: number, h: number) {
  const { lab, areas } = label(bin, w, h)
  const seen = new Set<number>()
  const out: [number, number][][] = []
  for (let i = 0; i < lab.length; i++) {
    const id = lab[i]
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (areas[id] < 16) continue
    out.push(trace(lab, w, h, id, i % w, (i / w) | 0))
  }
  return out
}

function trace(lab: Int32Array, w: number, h: number, id: number, sx: number, sy: number) {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === id
  const pts: [number, number][] = [[sx, sy]]
  let cx = sx, cy = sy
  let back = 4 // came from the west
  for (let guard = 0; guard < w * h * 4; guard++) {
    let found = -1
    for (let i = 1; i <= 8; i++) {
      const dIdx = (back + i) % 8
      if (inside(cx + DIRS[dIdx][0], cy + DIRS[dIdx][1])) { found = dIdx; break }
    }
    if (found < 0) break // single pixel
    cx += DIRS[found][0]
    cy += DIRS[found][1]
    back = (found + 4) % 8
    if (cx === sx && cy === sy) break
    pts.push([cx, cy])
  }
  return pts
}

function simplifyClosed(pts: [number, number][], eps: number) {
  if (pts.length < 8) return pts
  let far = 0, fd = -1
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2
    if (d > fd) { fd = d; far = i }
  }
  const a = rdp(pts.slice(0, far + 1), eps)
  const b = rdp([...pts.slice(far), pts[0]], eps)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

function rdp(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1]
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  let idx = 0, md = -1
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len
    if (d > md) { md = d; idx = i }
  }
  if (md <= eps) return [pts[0], pts[pts.length - 1]]
  const l = rdp(pts.slice(0, idx + 1), eps)
  const r = rdp(pts.slice(idx), eps)
  return [...l.slice(0, -1), ...r]
}

// r > 0 rounds every corner with an arc of that radius (in output px),
// shrunk where the neighbouring edges are too short to fit it
function fillPolys(c: CanvasRenderingContext2D, polys: [number, number][][], scale: number, r = 0) {
  c.fillStyle = '#fff'
  c.beginPath()
  for (const p of polys) {
    const q = p.map(([x, y]) => [x * scale, y * scale] as [number, number])
    if (r <= 0 || q.length < 3) {
      q.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
    } else {
      const n = q.length
      const len = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1])
      const [ax, ay] = q[n - 1], [bx, by] = q[0]
      c.moveTo((ax + bx) / 2, (ay + by) / 2)
      for (let i = 0; i < n; i++) {
        const a = q[(i - 1 + n) % n], v = q[i], b = q[(i + 1) % n]
        c.arcTo(v[0], v[1], b[0], b[1], Math.min(r, 0.5 * len(a, v), 0.5 * len(v, b)))
      }
    }
    c.closePath()
  }
  c.fill('nonzero')
}

// A flat, explicit background (e.g. a design export with a solid fill behind
// a cut-out) is removed by colour, not by the AI model, which can drop
// people it isn't sure about. Returns null unless most of the image border is
// one exact colour. Only that colour connected to the border is cleared, so
// matching pixels inside the subject are kept.
const KEY_TOL = 2 // max channel difference still counted as background (6 ate into dark hair)
const POCKET = 64 // enclosed patches of the exact fill colour at least this big are background too
const KEY_BORDER = 0.6 // share of the border that must be that colour

export function keySolidBackground(src: CanvasImageSource & { width: number; height: number }, tol = KEY_TOL): HTMLCanvasElement | null {
  const k = Math.min(1, 4096 / Math.max(src.width, src.height))
  const w = Math.round(src.width * k), h = Math.round(src.height * k)
  const c = canvas(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data

  const border: number[] = []
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x)
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1)
  // the most common border colour, quantised a little
  const counts = new Map<number, number>()
  for (const i of border) {
    const key = ((d[i * 4] >> 2) << 12) | ((d[i * 4 + 1] >> 2) << 6) | (d[i * 4 + 2] >> 2)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let top = 0, topN = 0
  counts.forEach((n, key) => n > topN && ((topN = n), (top = key)))
  const ref = border.find((i) => (((d[i * 4] >> 2) << 12) | ((d[i * 4 + 1] >> 2) << 6) | (d[i * 4 + 2] >> 2)) === top)!
  const br = d[ref * 4], bg = d[ref * 4 + 1], bb = d[ref * 4 + 2]
  const diff = (i: number) => Math.max(Math.abs(d[i * 4] - br), Math.abs(d[i * 4 + 1] - bg), Math.abs(d[i * 4 + 2] - bb))
  const match = border.filter((i) => diff(i) <= tol).length
  if (match / border.length < KEY_BORDER) return null

  // flood inward from the border through background-coloured pixels
  const bgMask = new Uint8Array(w * h)
  const stack: number[] = []
  for (const i of border) if (diff(i) <= tol && !bgMask[i]) { bgMask[i] = 1; stack.push(i) }
  while (stack.length) {
    const j = stack.pop()!
    const x = j % w, y = (j / w) | 0
    const visit = (n: number) => {
      if (!bgMask[n] && diff(n) <= tol) { bgMask[n] = 1; stack.push(n) }
    }
    if (x > 0) visit(j - 1)
    if (x < w - 1) visit(j + 1)
    if (y > 0) visit(j - w)
    if (y < h - 1) visit(j + w)
  }

  // pockets of the fill enclosed by the subject (gaps between arms): photo
  // pixels are never this flat over an area, so exact-colour patches go too
  const seen = new Uint8Array(w * h)
  for (let s0 = 0; s0 < w * h; s0++) {
    if (bgMask[s0] || seen[s0] || diff(s0) > 1) continue
    const comp = [s0]
    seen[s0] = 1
    for (let k = 0; k < comp.length; k++) {
      const j = comp[k]
      const x = j % w, y = (j / w) | 0
      for (const n of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (n >= 0 && !seen[n] && !bgMask[n] && diff(n) <= 1) { seen[n] = 1; comp.push(n) }
      }
    }
    if (comp.length >= POCKET) for (const j of comp) bgMask[j] = 1
  }

  // clear it; on the 1px fringe, unmix the background out of blended edge pixels
  for (let i = 0; i < w * h; i++) {
    if (bgMask[i]) { d[i * 4 + 3] = 0; continue }
    const x = i % w, y = (i / w) | 0
    const edge = (x > 0 && bgMask[i - 1]) || (x < w - 1 && bgMask[i + 1]) || (y > 0 && bgMask[i - w]) || (y < h - 1 && bgMask[i + w])
    if (!edge) continue
    const a = Math.min(1, diff(i) / 40)
    if (a < 1) {
      for (const [o, b] of [[0, br], [1, bg], [2, bb]]) d[i * 4 + o] = Math.max(0, Math.min(255, (d[i * 4 + o] - (1 - a) * b) / Math.max(a, 0.05)))
      d[i * 4 + 3] = Math.round(d[i * 4 + 3] * a)
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}
