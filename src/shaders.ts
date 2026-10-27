export const VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// Everything is in device pixels, y down. The peel is a cylinder curl:
// the part of the sticker past the fold line (dot(p - P, N) > 0) wraps
// around a cylinder of radius R lying on the fold, then lies flat on top,
// face down. Each screen pixel is inverted back to the sticker point(s)
// that land on it, topmost first.
export const FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uArt;   // premultiplied photo
uniform sampler2D uShape; // R cut coverage
uniform vec2 uRes;
uniform vec4 uRect;       // sticker rect: x, y, w, h
uniform vec2 uFoldP;
uniform vec2 uFoldN;
uniform float uR;         // curl radius, 0 = flat
uniform vec2 uLight;      // -1..1, where the light leans
uniform float uTime;
uniform float uHolo;      // how strongly the holographic laminate shows over the photo
uniform float uFade;
uniform float uWhite;     // 1 = plain white rim instead of holo film
uniform float uMono;      // 1 = photo in black and white
uniform float uShards;    // 0..1, faceted 'shattered glass' holo pattern
uniform float uExport;
uniform float uDpr;

out vec4 outColor;

const float PI = 3.14159265;
const float HOLO_BANDS = 1.7; // rainbow cycles across the view
const float SHARD_MIX = 0.55; // how far the shards take over at full slider
float gLod; // mip level for 1:1 mapped samples (set once, so no derivatives in branches)

float sq(float x) { return x * x; }

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 19.19)); }

// one layer of shards: voronoi cells, each split again by a random line
// through its seed so the facets come out as triangles and wedges.
// returns a random value per facet
float shardLayer(vec2 q) {
  vec2 g = floor(q), f = fract(q);
  float best = 8.0;
  vec2 id = g, seed = vec2(0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(i, j);
      vec2 r = o + hash2(g + o) - f;
      float d = dot(r, r);
      if (d < best) { best = d; id = g + o; seed = r; }
    }
  float a = hash(id + 3.7) * 6.28318;
  float side = step(0.0, dot(-seed, vec2(cos(a), sin(a))));
  return hash(id + side * 41.3);
}

vec2 uvOf(vec2 p) { return (p - uRect.xy) / uRect.zw; }
float inBox(vec2 uv) { return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0); }
float cover(vec2 uv) { return textureLod(uShape, uv, gLod).r * inBox(uv); }
float coverLod(vec2 uv, float lod) { return textureLod(uShape, uv, lod).r * inBox(uv); }

// soft studio light the film mirrors: a broad top glow and one diagonal strip
float glare(vec2 u) {
  float t = dot(u, normalize(vec2(0.9, 0.45)));
  float g = 0.3 - 0.15 * u.y;
  g += 0.75 * exp(-sq((t - 0.16) / 0.14));
  g += 0.3 * exp(-sq((t + 0.45) / 0.09));
  return max(g, 0.0);
}

// thin-film rainbow, a cosine spectrum
vec3 spectrum(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}

// printed face. macroN is the surface normal from the curl (0,0,1 when flat);
// sp is where the point sits on screen, so the rainbow stays put in the room
// and sweeps across the sticker as it moves or the light leans
vec3 front(vec2 uv, vec3 macroN, vec2 sp, float lit) {
  vec2 tsz = vec2(textureSize(uShape, 0));

  vec4 a = textureLod(uArt, uv, gLod);
  vec3 ink = a.a > 0.002 ? a.rgb / a.a : vec3(0);
  ink = mix(ink, vec3(dot(ink, vec3(0.299, 0.587, 0.114))), uMono);

  vec3 r = reflect(vec3(0, 0, -1), macroN);
  vec2 view = r.xy * 0.9 + sp * 0.85 + uLight * vec2(0.55, 0.4);
  float g = glare(view);

  // the film: a slow swirl bends the bands, a fine grain makes them glitter
  vec2 q = uv * tsz;
  float swirl = fbm(q / 360.0);
  float grain = vnoise(q / 2.5);
  float phase = dot(view, vec2(0.8, 0.55)) * HOLO_BANDS + swirl * 1.1 + (grain - 0.5) * 0.08;
  // shards: every facet is a grating at its own angle, so each one flips to
  // its own colour as the view moves. two overlapping scales, blended in
  float s1 = shardLayer(q / 34.0), s2 = shardLayer(q / 15.0 + 9.1);
  float sh = mix(s1, s2, step(0.6, hash(floor(q / 34.0) + 2.2)));
  float ang = sh * 6.28318;
  float shardPhase = dot(view, vec2(cos(ang), sin(ang))) * 2.4 + sh * 3.0;
  float plain = phase;
  phase = mix(phase, phase * 0.55 + shardPhase, uShards * SHARD_MIX);
  vec3 rainbow = spectrum(phase);
  // the photo gets only a hint of the shards, so faces stay readable
  vec3 rainbowInk = spectrum(mix(plain, phase, 0.4));
  float facet = 1.0 + (fract(sh * 7.13) - 0.5) * 0.22 * uShards;
  float vivid = 0.22 + 0.5 * smoothstep(0.1, 0.85, g);
  vec3 pearl = vec3(0.87, 0.875, 0.9);
  vec3 film = mix(pearl, rainbow * 0.7 + 0.32, vivid) * (0.8 + 0.3 * g) * facet;
  film += 0.3 * smoothstep(0.75, 1.05, g);
  float spark = step(0.992, hash(floor(q / 2.0))) * smoothstep(0.3, 0.9, g);
  film += spark * 0.6;
  // plain white vinyl: just a soft gloss
  vec3 vinyl = vec3(0.965, 0.965, 0.96) * (0.9 + 0.08 * g) + 0.08 * smoothstep(0.75, 1.05, g);
  film = mix(film, vinyl, uWhite);

  // over the photo: a holographic laminate, screened on
  vec3 tint = rainbowInk * vivid * 0.5 * (0.35 + g);
  vec3 printed = mix(ink, 1.0 - (1.0 - ink) * (1.0 - tint), uHolo) + spark * 0.35 * uHolo;
  vec3 col = mix(film, printed, a.a);
  col += 0.1 * smoothstep(0.8, 1.1, g) * a.a;
  return col * lit;
}

vec3 back(vec2 uv, float lit) {
  vec2 q = uv * vec2(textureSize(uShape, 0));
  float fib = (fbm(q / 5.0) - 0.5) * 0.06 + (vnoise(q * 0.8) - 0.5) * 0.03;
  return vec3(0.85, 0.85, 0.84) * (1.0 + fib) * lit;
}

// coverage of the lifted flap seen from above at q (soft, for shadows)
float flap(vec2 q, float lod) {
  float d = dot(q - uFoldP, uFoldN);
  if (d < 0.0) return coverLod(uvOf(q + (PI * uR - 2.0 * d) * uFoldN), lod);
  if (d <= uR) {
    float s2 = uR * (PI - asin(d / uR));
    return coverLod(uvOf(q + (s2 - d) * uFoldN), lod);
  }
  return 0.0;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 sp = (p - 0.5 * uRes) / min(uRes.x, uRes.y);
  vec2 n2 = uFoldN;
  bool peel = uR > 0.5;
  float d = peel ? dot(p - uFoldP, n2) : -1e6;
  float pxPerTexel = uRect.z / float(textureSize(uShape, 0).x);
  gLod = max(0.0, log2(1.0 / pxPerTexel));

  vec2 uv0 = uvOf(p);
  float m0 = cover(uv0) * clamp(0.5 - d, 0.0, 1.0);

  if (uExport > 0.5) {
    outColor = vec4(front(uv0, vec3(0, 0, 1), sp, 1.0), cover(uv0));
    return;
  }

  // table: flat, same as the page's --bg
  vec3 col = vec3(0.157, 0.157, 0.161);

  // the lifted flap's shadow, falling down and right, softer as it rises
  float fs = 0.0;
  if (peel) {
    vec2 off = vec2(0.35, 1.0) * uR * 0.9 + vec2(0.0, 4.0) * uDpr;
    float lod = log2(max(uR * 0.35, 1.0) / pxPerTexel);
    fs = flap(p - off, lod) * uFade;
    // ambient occlusion tucked in under the curl
    fs = max(fs, 0.5 * smoothstep(uR * 1.1, 0.0, abs(d - uR * 0.3)) * cover(uvOf(p)) * uFade);
  }

  // sticker, flat
  col = mix(col, front(uv0, vec3(0, 0, 1), sp, 1.0), m0 * uFade);
  col *= 1.0 - 0.5 * fs;

  if (peel) {
    if (d >= 0.0 && d <= uR) {
      float th = asin(clamp(d / uR, 0.0, 1.0));
      // inside of the curl: printed face, turning away
      vec2 o1 = p + (uR * th - d) * n2;
      float m1 = cover(uvOf(o1));
      vec3 nIn = vec3(-sin(th) * n2, cos(th));
      col = mix(col, front(uvOf(o1), nIn, sp, 0.42 + 0.45 * cos(th)), m1 * uFade);
      // outside of the curl, on top: the backing
      float th2 = PI - th;
      vec2 o2 = p + (uR * th2 - d) * n2;
      float m2 = cover(uvOf(o2));
      float lit = 0.62 + 0.38 * (-cos(th2)) + 0.12 * exp(-sq((th2 - 2.35) / 0.22));
      col = mix(col, back(uvOf(o2), lit), m2 * uFade);
    } else if (d < 0.0) {
      // flat on top, face down
      vec2 o3 = p + (PI * uR - 2.0 * d) * n2;
      float m3 = cover(uvOf(o3));
      col = mix(col, back(uvOf(o3), 1.02), m3 * uFade);
    }
  }

  outColor = vec4(col, 1.0);
}`
