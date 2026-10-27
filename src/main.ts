import { addSaved, listSaved, removeSaved, updateSaved, type Saved, type Settings } from './history'
import { buildSticker, hasTransparency, keySolidBackground, type Cut, type Sticker } from './sticker'
import { FRAG, VERT } from './shaders'
import './style.css'

// ── tuning ────────────────────────────────────────────────────────────────
const FIT_W = 0.8 // sticker fits within this share of the viewport
const FIT_H = 0.68
const CURL = 0.22 // curl radius as a share of the pull distance
const CURL_MAX = 0.085 // …capped at this share of the sticker's short side
const FLY_AT = 0.55 // release past this share of the long side and it comes off
const SPRING = 170 // spring-back stiffness (critically damped, so no flip)
const SHELF = 112 // css px kept clear on each side for the saved-stickers column
const THUMB = 180 // longest side of a saved thumbnail

// ── dom ───────────────────────────────────────────────────────────────────
const cv = document.querySelector<HTMLCanvasElement>('#gl')!
const fileIn = document.querySelector<HTMLInputElement>('#file')!
const borderIn = document.querySelector<HTMLInputElement>('#border')!
const shardsIn = document.querySelector<HTMLInputElement>('#shards')!
const holoIn = document.querySelector<HTMLInputElement>('#holo')!
const cutBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-cut]')]
const rimBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-rim]')]
const monoBtn = document.querySelector<HTMLButtonElement>('#mono')!
const saveBtn = document.querySelector<HTMLButtonElement>('#save')!
const status = document.querySelector<HTMLElement>('#status')!
const drop = document.querySelector<HTMLElement>('#drop')!
const shelf = document.querySelector<HTMLElement>('#shelf')!

// ── gl ────────────────────────────────────────────────────────────────────
const gl = cv.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false })!
if (!gl) throw new Error('WebGL2 is required')

function compile(type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
  return s
}
const prog = gl.createProgram()!
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
gl.linkProgram(prog)
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
gl.useProgram(prog)
gl.bindVertexArray(gl.createVertexArray())

const U = Object.fromEntries(
  ['uArt', 'uShape', 'uRes', 'uRect', 'uFoldP', 'uFoldN', 'uR', 'uLight', 'uTime', 'uHolo', 'uFade', 'uWhite', 'uMono', 'uShards', 'uExport', 'uDpr'].map(
    (n) => [n, gl.getUniformLocation(prog, n)],
  ),
)
gl.uniform1i(U.uArt, 0)
gl.uniform1i(U.uShape, 1)

function makeTex(unit: number) {
  const t = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}
const artTex = makeTex(0)
const shapeTex = makeTex(1)

function upload(s: Sticker) {
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, artTex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.art)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, shapeTex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, s.w, s.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, s.shape)
  gl.generateMipmap(gl.TEXTURE_2D)
}

// ── state ─────────────────────────────────────────────────────────────────
type V = [number, number]
let sticker: Sticker | null = null
let cutout: ImageBitmap | null = null
let cut: Cut = 'smooth'
let white = false
let mono = false
let dpr = 1
const rect = { x: 0, y: 0, w: 1, h: 1 }

let mode: 'rest' | 'drag' | 'spring' | 'fly' | 'gone' | 'locked' = 'rest'
let grab: V = [0, 0]
let pull: V = [0, 0] // where the grabbed point has been pulled to
let vel: V = [0, 0]
let fade = 1
let goneAt = 0
let light: V = [0, 0]
let lightTo: V = [0, 0]
let lastMove = 0

function layout() {
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  cv.width = Math.round(innerWidth * dpr)
  cv.height = Math.round(innerHeight * dpr)
  if (!sticker) return
  const room = innerWidth > 720 ? cv.width - 2 * SHELF * dpr : cv.width
  const s = Math.min((room * FIT_W) / sticker.w, (cv.height * FIT_H) / sticker.h, 1.6 * dpr)
  rect.w = sticker.w * s
  rect.h = sticker.h * s
  rect.x = (cv.width - rect.w) / 2
  rect.y = cv.height * 0.45 - rect.h / 2
}
addEventListener('resize', layout)

function hit(x: number, y: number) {
  if (!sticker) return false
  const u = Math.floor(((x - rect.x) / rect.w) * sticker.w)
  const v = Math.floor(((y - rect.y) / rect.h) * sticker.h)
  if (u < 0 || v < 0 || u >= sticker.w || v >= sticker.h) return false
  return sticker.mask[v * sticker.w + u] > 100
}

function fold() {
  const dx = grab[0] - pull[0], dy = grab[1] - pull[1]
  const L = Math.hypot(dx, dy)
  if (L < 0.75) return null
  const n: V = [dx / L, dy / L]
  const R = Math.min(L * CURL, CURL_MAX * Math.min(rect.w, rect.h))
  // the grabbed point sits on the flat, flipped part and lands under the pointer
  const s = (L + Math.PI * R) / 2
  return { P: [grab[0] - n[0] * s, grab[1] - n[1] * s] as V, n, R, L }
}

// ── input ─────────────────────────────────────────────────────────────────
const pt = (e: PointerEvent): V => [e.clientX * dpr, e.clientY * dpr]

cv.addEventListener('pointerdown', (e) => {
  const p = pt(e)
  if ((mode !== 'rest' && mode !== 'spring') || !hit(...p)) return
  grab = p
  pull = p
  vel = [0, 0]
  mode = 'drag'
  try {
    cv.setPointerCapture(e.pointerId)
  } catch {}
  cv.style.cursor = 'grabbing'
})
cv.addEventListener('pointermove', (e) => {
  const p = pt(e)
  lastMove = performance.now()
  lightTo = [(p[0] / cv.width) * 2 - 1, (p[1] / cv.height) * 2 - 1]
  if (mode === 'drag') pull = p
  else cv.style.cursor = mode === 'rest' && hit(...p) ? 'grab' : 'default'
})
const release = () => {
  if (mode !== 'drag') return
  cv.style.cursor = 'default'
  const f = fold()
  mode = f && f.L > FLY_AT * Math.max(rect.w, rect.h) ? 'fly' : 'spring'
  if (mode === 'fly' && f) vel = [-f.n[0] * f.L * 2, -f.n[1] * f.L * 2]
}
cv.addEventListener('pointerup', release)

// ] holds the peel where it is, even after letting go; [ lets it fall back
const hintEl = document.querySelector<HTMLElement>('.hint')!
const hintText = hintEl.textContent
addEventListener('keydown', (e) => {
  if (e.key === ']' && (mode === 'drag' || mode === 'spring') && fold()) {
    mode = 'locked'
    vel = [0, 0]
    cv.style.cursor = 'default'
    hintEl.textContent = 'Peel locked · press [ to release'
  } else if (e.key === '[' && mode === 'locked') {
    mode = 'spring'
    hintEl.textContent = hintText
  }
})
cv.addEventListener('pointercancel', release)

// ── loop ──────────────────────────────────────────────────────────────────
let last = performance.now()
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 1 / 30)
  last = now

  if (mode === 'spring') {
    const c = 2 * Math.sqrt(SPRING)
    for (const i of [0, 1]) {
      vel[i] += (SPRING * (grab[i] - pull[i]) - c * vel[i]) * dt
      pull[i] += vel[i] * dt
    }
    if (Math.hypot(grab[0] - pull[0], grab[1] - pull[1]) < 0.5 && Math.hypot(...vel) < 5) mode = 'rest'
  } else if (mode === 'fly') {
    for (const i of [0, 1]) {
      vel[i] *= 1 + 2.5 * dt
      pull[i] += vel[i] * dt
    }
    const f = fold()
    if (f && f.L > 2.4 * Math.hypot(rect.w, rect.h)) {
      mode = 'gone'
      goneAt = now
      fade = 0
    }
  } else if (mode === 'gone' && now - goneAt > 450) {
    mode = 'rest'
    pull = [...grab]
  }
  if (mode === 'rest' || mode === 'spring') fade = Math.min(1, fade + dt * 3.2)

  // with the pointer still, the light drifts on its own
  const idle = now - lastMove > 2500
  const target: V = idle ? [Math.sin(now / 2300) * 0.6, Math.cos(now / 3100) * 0.35] : lightTo
  light = [light[0] + (target[0] - light[0]) * 0.06, light[1] + (target[1] - light[1]) * 0.06]

  draw(now, false)
  requestAnimationFrame(frame)
}

function draw(now: number, exporting: boolean) {
  gl.viewport(0, 0, cv.width, cv.height)
  gl.uniform2f(U.uRes, cv.width, cv.height)
  gl.uniform4f(U.uRect, rect.x, rect.y, rect.w, rect.h)
  const f = exporting || mode === 'gone' ? null : fold()
  gl.uniform2f(U.uFoldP, ...(f ? f.P : ([0, 0] as V)))
  gl.uniform2f(U.uFoldN, ...(f ? f.n : ([1, 0] as V)))
  gl.uniform1f(U.uR, f ? f.R : 0)
  gl.uniform2f(U.uLight, ...(exporting ? ([0.2, -0.3] as V) : light))
  gl.uniform1f(U.uTime, now / 1000)
  gl.uniform1f(U.uHolo, +holoIn.value)
  gl.uniform1f(U.uFade, exporting ? 1 : easeOut(fade))
  gl.uniform1f(U.uExport, exporting ? 1 : 0)
  gl.uniform1f(U.uWhite, white ? 1 : 0)
  gl.uniform1f(U.uMono, mono ? 1 : 0)
  gl.uniform1f(U.uShards, +shardsIn.value)
  gl.uniform1f(U.uDpr, dpr)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
}
const easeOut = (t: number) => 1 - (1 - t) ** 3

// ── sticker building ──────────────────────────────────────────────────────
function rebuild(hint = false) {
  if (!cutout) return
  sticker = buildSticker(cutout, +borderIn.value, cut)
  upload(sticker)
  layout()
  mode = 'rest'
  pull = [...grab]
  hintEl.textContent = hintText
  if (hint) peelHint()
}

// on a fresh sticker, lift the corner a little so it reads as peelable
function peelHint() {
  if (!sticker) return
  const s = rect.w / sticker.w
  grab = [rect.x + sticker.corner[0] * s, rect.y + sticker.corner[1] * s]
  pull = [...grab]
  const to: V = [grab[0] - rect.w * 0.09, grab[1] - rect.h * 0.11]
  const t0 = performance.now()
  mode = 'drag'
  const step = (now: number) => {
    if (mode !== 'drag') return
    const t = Math.min((now - t0) / 650, 1)
    const e = 1 - (1 - t) ** 3
    pull = [grab[0] + (to[0] - grab[0]) * e, grab[1] + (to[1] - grab[1]) * e]
    if (t < 1) requestAnimationFrame(step)
    else setTimeout(() => mode === 'drag' && (mode = 'spring'), 500)
  }
  requestAnimationFrame(step)
}

let rebuildTimer = 0
const queueRebuild = () => {
  clearTimeout(rebuildTimer)
  rebuildTimer = window.setTimeout(() => rebuild(), 120)
}
borderIn.addEventListener('input', () => {
  queueRebuild()
  queuePersist()
})
cutBtns.forEach((b) =>
  b.addEventListener('click', () => {
    cut = b.dataset.cut as Cut
    cutBtns.forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
    rebuild()
    queuePersist()
  }),
)

rimBtns.forEach((b) =>
  b.addEventListener('click', () => {
    white = b.dataset.rim === 'white'
    rimBtns.forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
    queuePersist()
  }),
)
monoBtn.addEventListener('click', () => {
  mono = !mono
  monoBtn.setAttribute('aria-pressed', String(mono))
  queuePersist()
})
shardsIn.addEventListener('input', () => queuePersist())
holoIn.addEventListener('input', () => queuePersist())

function say(msg: string) {
  status.textContent = msg
  status.hidden = !msg
}

async function useFile(file: Blob, demo?: string) {
  try {
    say('Reading image…')
    let bmp = await createImageBitmap(file)
    let cutBlob: Blob = file
    const keyed = hasTransparency(bmp) ? null : keySolidBackground(bmp)
    if (keyed) {
      cutBlob = await new Promise<Blob>((r) => keyed.toBlob((b) => r(b!), 'image/png'))
      bmp = await createImageBitmap(keyed)
    } else if (!hasTransparency(bmp)) {
      say('Loading background remover…')
      const { removeBackground } = await import('@imgly/background-removal')
      const blob = await removeBackground(file, {
        model: 'isnet_fp16',
        output: { format: 'image/png' },
        progress: (key: string, cur: number, total: number) => {
          if (key.startsWith('fetch')) say(`Downloading model… ${Math.round((cur / Math.max(total, 1)) * 100)}%`)
          else say('Removing background…')
        },
      })
      bmp = await createImageBitmap(blob)
      cutBlob = blob
    }
    say('Cutting sticker…')
    await new Promise((r) => setTimeout(r, 30))
    cutout = bmp
    rebuild(true)
    say('')
    try {
      currentId = await addSaved({ created: Date.now(), cutout: cutBlob, thumb: await thumbnail(), settings: getSettings(), demo })
      await renderShelf()
    } catch (err) {
      console.warn('could not save sticker', err)
    }
  } catch (err) {
    console.error(err)
    say(`Couldn't make a sticker: ${(err as Error).message}`)
  }
}

fileIn.addEventListener('change', () => fileIn.files?.[0] && useFile(fileIn.files[0]))
addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.hidden = false
})
addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) drop.hidden = true
})
addEventListener('drop', (e) => {
  e.preventDefault()
  drop.hidden = true
  const f = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (f) useFile(f)
})
addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (f) useFile(f)
})

// the flat sticker at texture resolution, transparent around the cut
function renderFlat(): HTMLCanvasElement | null {
  if (!sticker) return null
  const keep = { ...rect }
  const [w, h] = [cv.width, cv.height]
  cv.width = sticker.w
  cv.height = sticker.h
  Object.assign(rect, { x: 0, y: 0, w: sticker.w, h: sticker.h })
  draw(performance.now(), true)
  const out = document.createElement('canvas')
  out.width = sticker.w
  out.height = sticker.h
  out.getContext('2d')!.drawImage(cv, 0, 0)
  cv.width = w
  cv.height = h
  Object.assign(rect, keep)
  draw(performance.now(), false) // resizing cleared the canvas; refill it before it shows
  return out
}

saveBtn.addEventListener('click', () => {
  renderFlat()?.toBlob((b) => {
    if (!b) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(b)
    a.download = 'holo-sticker.png'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, 'image/png')
})

// ── saved stickers ────────────────────────────────────────────────────────
let currentId: number | null = null

function getSettings(): Settings {
  return { cut, border: +borderIn.value, white, mono, shards: +shardsIn.value, holo: +holoIn.value }
}

function applySettings(st: Settings) {
  cut = st.cut
  white = st.white
  mono = st.mono
  borderIn.value = String(st.border)
  shardsIn.value = String(st.shards)
  holoIn.value = String(st.holo)
  cutBtns.forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.cut === cut)))
  rimBtns.forEach((o) => o.setAttribute('aria-pressed', String((o.dataset.rim === 'white') === white)))
  monoBtn.setAttribute('aria-pressed', String(mono))
}

async function thumbnail(): Promise<Blob> {
  const flat = renderFlat()!
  const k = Math.min(1, THUMB / Math.max(flat.width, flat.height))
  const t = document.createElement('canvas')
  t.width = Math.round(flat.width * k)
  t.height = Math.round(flat.height * k)
  const c = t.getContext('2d')!
  c.imageSmoothingQuality = 'high'
  c.drawImage(flat, 0, 0, t.width, t.height)
  return new Promise((r) => t.toBlob((b) => r(b!), 'image/png'))
}

let persistTimer = 0
function queuePersist() {
  clearTimeout(persistTimer)
  persistTimer = window.setTimeout(async () => {
    if (currentId == null || !sticker) return
    try {
      await updateSaved(currentId, { settings: getSettings(), thumb: await thumbnail() })
      await renderShelf()
    } catch (err) {
      console.warn('could not update sticker', err)
    }
  }, 450)
}

async function openSaved(rec: Saved) {
  cutout = await createImageBitmap(rec.cutout)
  applySettings(rec.settings)
  currentId = rec.id
  rebuild(true)
  shelf.querySelectorAll('.thumb').forEach((el) => el.classList.toggle('active', +(el as HTMLElement).dataset.id! === rec.id))
}

const thumbUrls: string[] = []
async function renderShelf() {
  const recs = await listSaved()
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u))
  shelf.replaceChildren(
    ...recs.map((rec) => {
      const item = document.createElement('div')
      item.className = 'thumb' + (rec.id === currentId ? ' active' : '')
      item.dataset.id = String(rec.id)
      const open = document.createElement('button')
      open.className = 'open'
      open.title = new Date(rec.created).toLocaleString()
      const img = document.createElement('img')
      img.src = URL.createObjectURL(rec.thumb)
      img.alt = 'Saved sticker'
      thumbUrls.push(img.src)
      open.append(img)
      open.addEventListener('click', () => openSaved(rec))
      const del = document.createElement('button')
      del.className = 'del'
      del.title = 'Remove from saved'
      del.textContent = '×'
      del.addEventListener('click', async () => {
        await removeSaved(rec.id)
        const wasOpen = currentId === rec.id
        if (wasOpen) currentId = null
        const left = await renderShelf()
        if (wasOpen && left.length) openSaved(left[0])
      })
      item.append(open, del)
      return item
    }),
  )
  shelf.hidden = recs.length === 0
  return recs
}

// ── go ────────────────────────────────────────────────────────────────────
layout()
requestAnimationFrame(frame)
// always open on the example sticker; it's cut once, then kept on the shelf
const DEMO = 'jelly-cody-2' // bump when the example's defaults change
renderShelf()
  .catch(() => [] as Saved[])
  .then((recs) => {
    const demo = recs.find((r) => r.demo === DEMO)
    for (const r of recs) if (r.demo && r.demo !== DEMO) removeSaved(r.id)
    return demo ? openSaved(demo) : fetch('/demo.png').then((r) => r.blob()).then((b) => useFile(b, DEMO))
  })
