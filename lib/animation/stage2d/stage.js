'use strict';
/**
 * 2D cartoon stage. Runs inside headless Chrome: the Node renderer drives it frame by frame through
 * window.loadScene(spec) and window.setFrame(seconds). Every frame is drawn with the Canvas 2D API:
 * flat, outlined cartoon characters (walk, run, jump, wave, talk, blink, expressions) on an Indian village
 * background. The background is laid out with a real perspective camera, so mountains, houses, trees and
 * the river get smaller with distance, and the sky, fog and light follow the time of day.
 * No 3D models, no WebGL, no image files: everything is drawn with paths. Nothing is a static picture.
 */
const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const OUT = '#2a1a10'; // outline colour for every cartoon shape

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);
let ctx = canvas.getContext('2d');
const mainCtx = ctx;
const buffer = document.createElement('canvas');
const bufferCtx = buffer.getContext('2d');
let W = 0;
let H = 0;
function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
  buffer.width = W;
  buffer.height = H;
}
resize();

// ---- colour helpers ----
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
function mix(a, b, f) {
  const A = Array.isArray(a) ? a : hex(a);
  const B = Array.isArray(b) ? b : hex(b);
  return [lerp(A[0], B[0], f), lerp(A[1], B[1], f), lerp(A[2], B[2], f)];
}
const shade = (c, f) => rgb(mix(c, [0, 0, 0], 1 - f));

// ---- time of day: sky, sun or moon, light ----
const TIME = {
  sunrise: { top: '#6f8fd6', horizon: '#ffb27a', bottom: '#ffd9a8', fog: '#ffc795', sun: '#ffb070', sunPos: [0.2, 0.6], light: 0.95, tint: [255, 170, 90, 0.10] },
  day: { top: '#3f8fd9', horizon: '#cfeeff', bottom: '#e8f6ff', fog: '#cfeeff', sun: '#fff3a0', sunPos: [0.8, 0.12], light: 1.0, tint: null },
  evening: { top: '#4b3a86', horizon: '#ff9a6b', bottom: '#ffb88a', fog: '#ff9e7a', sun: '#ff9060', sunPos: [0.86, 0.5], light: 0.88, tint: [255, 120, 60, 0.12] },
  night: { top: '#070b1c', horizon: '#26335a', bottom: '#1b2440', fog: '#1b2440', sun: '#c8d6ff', sunPos: [0.2, 0.14], light: 0.5, tint: [20, 30, 90, 0.28] },
};
let T = TIME.day;

// ---- perspective camera: the same framing rules the spec was written for (vertical field of view) ----
let cam = null;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function setCamera(pos, look, fovDeg) {
  const fwd = norm(sub(look, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  cam = { pos, fwd, right, up, focal: H / 2 / Math.tan((fovDeg * Math.PI) / 360) };
}
/** World point -> screen point and scale (pixels per world unit at that depth). Null when behind the camera. */
function proj(x, y, z) {
  const v = [x - cam.pos[0], y - cam.pos[1], z - cam.pos[2]];
  const d = dot(v, cam.fwd);
  if (d < 0.05) return null;
  const f = cam.focal / d;
  return { x: W / 2 + dot(v, cam.right) * f, y: H / 2 - dot(v, cam.up) * f, s: f, d };
}
const depthOf = (x, y, z) => dot([x - cam.pos[0], y - cam.pos[1], z - cam.pos[2]], cam.fwd);

/** Distant things fade towards the horizon colour: aerial perspective. */
function fogged(color, d) {
  const f = clamp01((d - 35) / 110) * 0.8;
  return rgb(mix(color, T.fog, f));
}

// ---- sky ----
function drawSky(t) {
  const hy = horizonY();
  const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
  g.addColorStop(0, T.top);
  g.addColorStop(1, T.horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, Math.max(0, hy) + 2);
  // Sun or moon with a soft glow.
  const sx = T.sunPos[0] * W;
  const sy = T.sunPos[1] * H;
  const r = Math.min(W, H) * 0.075;
  const glow = ctx.createRadialGradient(sx, sy, r * 0.5, sx, sy, r * 4);
  glow.addColorStop(0, T === TIME.night ? 'rgba(200,215,255,0.35)' : 'rgba(255,240,180,0.55)');
  glow.addColorStop(1, 'rgba(255,240,180,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = T.sun;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, TAU);
  ctx.fill();
  if (T === TIME.night) {
    // Stars that twinkle slowly.
    for (let i = 0; i < 90; i++) {
      const a = 0.35 + 0.45 * Math.abs(Math.sin(t * 1.3 + i));
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.fillRect(hash(i) * W, hash(i + 400) * hy * 0.85, 2, 2);
    }
  }
}
function horizonY() {
  // Screen row where the ground meets the sky, from the camera's horizontal view direction.
  const d = norm([cam.fwd[0], 0, cam.fwd[2]]);
  const p = proj(cam.pos[0] + d[0] * 4000, 0, cam.pos[2] + d[2] * 4000);
  return p ? p.y : H * 0.5;
}

// ---- clouds drift slowly across the sky ----
const CLOUDS = Array.from({ length: 7 }, (_, i) => ({ x0: -60 + hash(i + 200) * 120, y: 12 + hash(i + 90) * 7, z: -45 - hash(i + 150) * 40, speed: 0.6 + hash(i + 300) * 0.6, w: 2.8 + hash(i + 40) * 2.2 }));
function drawClouds(t) {
  if (T === TIME.night) return;
  for (const c of CLOUDS) {
    let x = ((c.x0 + t * c.speed + 80) % 160) - 80;
    const p = proj(x, c.y, c.z);
    if (!p) continue;
    const u = c.w * p.s;
    ctx.fillStyle = 'rgba(255,255,255,0.93)';
    for (let k = 0; k < 5; k++) {
      ctx.beginPath();
      ctx.ellipse(p.x + (k - 2) * u * 0.35, p.y - u * 0.1 * Math.abs(k - 2) * 0.4, u * (0.45 + 0.12 * (2 - Math.abs(k - 2))), u * 0.35, 0, 0, TAU);
      ctx.fill();
    }
  }
}

// ---- birds glide and flap ----
function drawBirds(t) {
  ctx.strokeStyle = '#37474f';
  ctx.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    const x = ((-30 + i * 9 + t * (1.2 + i * 0.12)) % 70) - 30;
    const p = proj(x, 9 + (i % 2) * 1.5, -30);
    if (!p) continue;
    const flap = Math.sin(t * 9 + i) * 0.45;
    const s = 14 * p.s / 40;
    ctx.beginPath();
    ctx.moveTo(p.x - s * (1 + 0.1 * flap), p.y - s * flap);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(p.x + s * (1 + 0.1 * flap), p.y - s * flap);
    ctx.stroke();
  }
}

// ---- strong sun: rays turn slowly around the sun (only on sunny scenes) ----
function drawSunRays(t) {
  if (spec.weather !== 'sun' || T === TIME.night) return;
  const R = Math.min(W, H) * 0.075;
  ctx.save();
  ctx.translate(T.sunPos[0] * W, T.sunPos[1] * H);
  ctx.rotate(t * 0.05);
  ctx.fillStyle = 'rgba(255,250,200,0.42)';
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const len = (i % 2 ? 1.6 : 2.6) * R;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a - 0.09) * R * 0.9, Math.sin(a - 0.09) * R * 0.9);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.lineTo(Math.cos(a + 0.09) * R * 0.9, Math.sin(a + 0.09) * R * 0.9);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---- monsoon rain: a grey-blue wash and slanted falling streaks (only on rainy scenes) ----
const RAIN = Array.from({ length: 170 }, (_, i) => ({ x: hash(i + 700), y: hash(i + 900), v: 0.7 + hash(i + 1100) * 0.6, len: 0.012 + hash(i + 1300) * 0.022 }));
function drawRain(t) {
  if (spec.weather !== 'rain') return;
  ctx.fillStyle = 'rgba(70,100,120,0.10)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(232,244,255,0.78)';
  ctx.lineWidth = Math.max(1.5, W / 480);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const r of RAIN) {
    const y = ((r.y + t * r.v * 0.9) % 1) * H;
    const x = ((r.x + t * r.v * 0.05) % 1) * W;
    const len = r.len * H;
    ctx.moveTo(x, y);
    ctx.lineTo(x - len * 0.25, y + len);
  }
  ctx.stroke();
}

// ---- ground ----
function drawGround() {
  const hy = horizonY();
  const grass = mix(hex('#6fb24a'), [0, 0, 0], 1 - T.light);
  const g = ctx.createLinearGradient(0, Math.max(0, hy), 0, H);
  g.addColorStop(0, rgb(mix(grass, T.fog, 0.45)));
  g.addColorStop(1, rgb(mix(grass, [0, 0, 0], 0.25)));
  ctx.fillStyle = g;
  ctx.fillRect(0, hy, W, H - hy);
}
/** A flat patch on the ground, given as world (x, z) corners. */
function groundPoly(pts, color) {
  const q = pts.map(([x, z]) => proj(x, 0, z)).filter(Boolean);
  if (q.length < 3) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
}
function drawGrassTufts(t) {
  ctx.strokeStyle = shade('#3d7a2e', T.light);
  ctx.lineWidth = 2;
  for (let i = 0; i < 260; i++) {
    const x = -40 + hash(i) * 80;
    const z = -2 - hash(i + 500) * 40;
    const p = proj(x, 0, z);
    if (!p) continue;
    const s = 0.5 * p.s;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - s * 0.2, p.y - s * 0.6);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + s * 0.25, p.y - s * 0.5);
    ctx.stroke();
  }
  // Foreground tufts and flowers, close to the camera, so the bottom of the frame is not empty.
  ctx.strokeStyle = shade('#2f6b2a', T.light);
  ctx.lineWidth = 3;
  for (let i = 0; i < 90; i++) {
    const p = proj(-12 + hash(i + 900) * 24, 0, 1.5 + hash(i + 950) * 9);
    if (!p) continue;
    const s = 0.7 * p.s;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - s * 0.25, p.y - s * 0.9);
    ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + s * 0.3, p.y - s * 0.8);
    ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - s * 1.1);
    ctx.stroke();
  }
  // Wild flowers in red, yellow, white and purple.
  const FL = ['#ff5252', '#ffeb3b', '#ffffff', '#ba68c8'];
  for (let i = 0; i < 70; i++) {
    const p = proj(-14 + hash(i + 700) * 28, 0, 3 - hash(i + 800) * 17);
    if (!p) continue;
    ctx.fillStyle = FL[i % FL.length];
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.5, 0.09 * p.s), 0, TAU);
    ctx.fill();
  }
}

// ---- mountains: three ridges, the far ones paler ----
const RIDGES = [
  { z: -120, h: 34, color: [150, 180, 200], seed: 1 },
  { z: -90, h: 24, color: [100, 140, 160], seed: 2 },
  { z: -62, h: 14, color: [78, 118, 96], seed: 3 },
];
function drawMountains() {
  const xc = cam.pos[0];
  for (const R of RIDGES) {
    const pts = [];
    for (let x = xc - 160; x <= xc + 160; x += 6) {
      const n = 0.55 + 0.25 * Math.sin(x * 0.045 + R.seed) + 0.15 * Math.sin(x * 0.13 + R.seed * 2.3) + 0.08 * Math.sin(x * 0.4 + R.seed * 5);
      const top = proj(x, R.h * Math.max(0.2, n), R.z);
      const base = proj(x, 0, R.z);
      if (top && base) pts.push([x, top, base]);
    }
    if (pts.length < 2) continue;
    const d = depthOf(xc, 0, R.z);
    ctx.fillStyle = rgb(mix(R.color, T.fog, clamp01((d - 40) / 90) * 0.7));
    ctx.beginPath();
    pts.forEach(([, top], i) => (i ? ctx.lineTo(top.x, top.y) : ctx.moveTo(top.x, top.y)));
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][2].x, pts[i][2].y);
    ctx.closePath();
    ctx.fill();
    // Snow or light on the highest ridge only.
    if (R.z === -120 && T !== TIME.night) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fill();
    }
  }
}

// ---- river and paddy fields ----
function drawRiver(t) {
  const shallow = mix(hex('#5ec8d8'), T.fog, 0.2);
  groundPoly([[-60, -4.6], [60, -4.6], [60, -8.2], [-60, -8.2]], rgb(shallow));
  // Moving ripples: lines that drift along the river.
  for (let k = 0; k < 9; k++) {
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let x = -60; x <= 60; x += 3) {
      const z = -5.2 - (k / 9) * 2.6 + Math.sin(x * 0.2 + t * 1.6 + k) * 0.08;
      const p = proj(x + ((t * 3 + k * 7) % 6) - 3, 0, z);
      if (!p) continue;
      if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; }
    }
    ctx.stroke();
  }
  // Sandy banks on both sides.
  groundPoly([[-60, -3.2], [60, -3.2], [60, -4.6], [-60, -4.6]], rgb(mix(hex('#e0c08a'), T.fog, 0.1)));
  groundPoly([[-60, -8.2], [60, -8.2], [60, -9.6], [-60, -9.6]], rgb(mix(hex('#e0c08a'), T.fog, 0.1)));
}
function drawPaddy() {
  for (let r = 0; r < 9; r++) {
    const z0 = -10 - r * 1.5;
    groundPoly([[-40, z0], [40, z0], [40, z0 - 0.9], [-40, z0 - 0.9]], rgb(mix(r % 2 ? hex('#9ccc65') : hex('#7cb342'), T.fog, 0.1)));
  }
  groundPoly([[-40, -6.5], [40, -6.5], [40, -7.3], [-40, -7.3]], rgb(mix(hex('#90c8c0'), T.fog, 0.15)));
}

// ---- lane (village) and courtyard floor ----
function drawLane(x0 = -0.9, x1 = 0.9, z0 = 14, z1 = -18, color = '#c9a66b') {
  groundPoly([[x0, z0], [x1, z0], [x1 * 1.1, z1], [x0 * 1.1, z1]], rgb(mix(hex(color), T.fog, 0.05)));
}

// ---- props, drawn far to near ----
const MANGO = ['#2e7d32', '#388e3c', '#1b5e20', '#43a047'];
function drawMangoTree(x, z, s, seed) {
  const p = proj(x, 0, z);
  if (!p) return;
  const k = p.s; // pixels per unit at this depth
  const fog = clamp01((p.d - 35) / 110) * 0.6;
  // trunk
  ctx.fillStyle = rgb(mix(hex('#6d4c41'), T.fog, fog));
  ctx.fillRect(p.x - 0.16 * s * k, p.y - 2.0 * s * k, 0.32 * s * k, 2.0 * s * k);
  // shadow on the ground
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, 1.4 * s * k, 0.35 * s * k, 0, 0, TAU);
  ctx.fill();
  // canopy: many leaf clusters with a darker and a lighter green
  for (let i = 0; i < 11; i++) {
    const cx = x + (hash(seed + i) - 0.5) * 2.2 * s;
    const cy = (2.6 + hash(seed + i + 20) * 0.9) * s;
    const cz = z + (hash(seed + i + 30) - 0.5) * 1.6 * s;
    const q = proj(cx, cy, cz);
    if (!q) continue;
    const r = (0.55 + hash(seed + i + 9) * 0.45) * s * q.s;
    ctx.fillStyle = rgb(mix(hex(MANGO[i % MANGO.length]), T.fog, clamp01((q.d - 35) / 110) * 0.6));
    ctx.beginPath();
    ctx.arc(q.x, q.y, r, 0, TAU);
    ctx.fill();
  }
  // ripe mangoes
  for (let i = 0; i < 7; i++) {
    const q = proj(x + (hash(seed + i + 60) - 0.5) * 1.8 * s, (2.1 + hash(seed + i + 70) * 0.5) * s, z + (hash(seed + i + 80) - 0.5) * 1.2 * s);
    if (!q) continue;
    ctx.fillStyle = ['#ffb300', '#ffa000', '#ffd54f'][i % 3];
    ctx.beginPath();
    ctx.arc(q.x, q.y, 0.13 * s * q.s, 0, TAU);
    ctx.fill();
  }
}
function drawForestTree(x, z, s, seed) {
  // A round, lighter tree for the forest (no mangoes).
  const p = proj(x, 0, z);
  if (!p) return;
  const k = p.s;
  ctx.fillStyle = rgb(mix(hex('#5d4037'), T.fog, clamp01((p.d - 35) / 110) * 0.6));
  ctx.fillRect(p.x - 0.12 * s * k, p.y - 1.6 * s * k, 0.24 * s * k, 1.6 * s * k);
  for (let i = 0; i < 7; i++) {
    const q = proj(x + (hash(seed + i) - 0.5) * 1.6 * s, (2.2 + hash(seed + i + 9) * 1.2) * s, z + (hash(seed + i + 3) - 0.5) * 1.3 * s);
    if (!q) continue;
    ctx.fillStyle = rgb(mix(hex(MANGO[(i + seed) % 4]), T.fog, clamp01((q.d - 35) / 110) * 0.6));
    ctx.beginPath();
    ctx.arc(q.x, q.y, (0.65 + hash(seed + i + 5) * 0.4) * s * q.s, 0, TAU);
    ctx.fill();
  }
}
/** A village house: plastered front, a deeper side wall, a terracotta roof, a door, lit windows and a tulsi plant. */
function drawHouse(x, z, wall, opts = {}) {
  const w = opts.w || 2.4;
  const hgt = opts.h || 1.9;
  const dep = 2.1;
  const f0 = proj(x - w / 2, 0, z + dep / 2);
  const f1 = proj(x + w / 2, 0, z + dep / 2);
  const b1 = proj(x + w / 2, 0, z - dep / 2);
  if (!f0 || !f1 || !b1) return;
  const fog = clamp01((f0.d - 35) / 110) * 0.6;
  const frontTop = (xx) => proj(xx, hgt, z + dep / 2);
  const ft0 = frontTop(x - w / 2);
  const ft1 = frontTop(x + w / 2);
  const bt1 = proj(x + w / 2, hgt, z - dep / 2);
  // side wall (in shade)
  ctx.fillStyle = rgb(mix(mix(hex(wall), [0, 0, 0], 0.18), T.fog, fog));
  ctx.beginPath();
  ctx.moveTo(f1.x, f1.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(bt1.x, bt1.y); ctx.lineTo(ft1.x, ft1.y);
  ctx.closePath(); ctx.fill();
  // front wall
  ctx.fillStyle = rgb(mix(hex(wall), T.fog, fog));
  ctx.beginPath();
  ctx.moveTo(f0.x, f0.y); ctx.lineTo(f1.x, f1.y); ctx.lineTo(ft1.x, ft1.y); ctx.lineTo(ft0.x, ft0.y);
  ctx.closePath(); ctx.fill();
  // roof: a pitched tiled roof (the ridge sits over the middle of the house)
  const apex = proj(x, hgt + 1.0, z);
  ctx.fillStyle = rgb(mix(hex('#b5532c'), T.fog, fog));
  ctx.beginPath();
  ctx.moveTo(ft0.x - 0.15 * f0.s, ft0.y); ctx.lineTo(ft1.x + 0.15 * f0.s, ft1.y); ctx.lineTo(apex.x, apex.y);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(80,30,10,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // door and two lit windows on the front wall
  const at = (u, v) => proj(x + u * w / 2, v, z + dep / 2);
  const door = [at(-0.2, 0), at(0.2, 0), at(0.2, 1.1), at(-0.2, 1.1)];
  ctx.fillStyle = '#4e2f1c';
  ctx.beginPath(); door.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
  for (const u of [-0.62, 0.62]) {
    const win = [at(u - 0.18, 1.2), at(u + 0.18, 1.2), at(u + 0.18, 1.5), at(u - 0.18, 1.5)];
    ctx.fillStyle = T === TIME.night || T === TIME.evening ? '#ffd87a' : '#ffe9b0';
    ctx.beginPath(); win.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
  }
  // tulsi plant in a terracotta pot in front
  const pot = proj(x + 1.6, 0.1, z + dep / 2 + 0.5);
  if (pot) {
    ctx.fillStyle = '#b5651d';
    ctx.fillRect(pot.x - 0.2 * pot.s, pot.y - 0.3 * pot.s, 0.4 * pot.s, 0.3 * pot.s);
    const top = proj(x + 1.6, 0.8, z + dep / 2 + 0.5);
    ctx.fillStyle = '#2e7d32';
    ctx.beginPath(); ctx.arc(top.x, top.y, 0.32 * top.s, 0, TAU); ctx.fill();
  }
}
// ---- scene layouts: a setting is a set of world-space props ----
function sceneProps(setting) {
  const P = [];
  const tree = (x, z, s, seed, kind = 'mango') => P.push({ z, fn: () => (kind === 'forest' ? drawForestTree(x, z, s, seed) : drawMangoTree(x, z, s, seed)) });
  const house = (x, z, wall, o) => P.push({ z, fn: () => drawHouse(x, z, wall, o) });
  switch (setting) {
    case 'village':
      house(-6.2, -8, '#f6e3b4');
      house(6.4, -9, '#e9b98b');
      house(-1.2, -17, '#c9e0b0');
      tree(-10.5, -4, 1.25, 3);
      tree(10.5, -3, 1.2, 17);
      tree(-13.5, -13, 1.5, 29);
      tree(12.5, -14, 1.4, 41);
      P.push({ z: 0, fn: () => drawLane() });
      break;
    case 'park':
      for (const z of [-5, -10, -16]) for (const x of [-9, -3, 3, 9]) tree(x + (z % 2 ? 1 : 0), z, 1.05, 100 + z * 3 + x * 7);
      break;
    case 'forest':
      for (let i = 0; i < 26; i++) {
        const x = -24 + hash(i + 11) * 48;
        const z = -6 - hash(i + 31) * 24;
        tree(x, z, 1.0 + hash(i + 51) * 0.6, 200 + i * 5, 'forest');
      }
      P.push({ z: 0, fn: () => drawLane(-0.7, 0.7, 14, -18, '#a1855c') });
      break;
    case 'river':
      tree(-9, -3, 1.2, 201);
      tree(3, -2, 1.1, 215);
      tree(-2, -14, 1.4, 229);
      tree(10, -13, 1.3, 243);
      tree(-16, -12, 1.5, 257, 'forest');
      break;
    case 'field':
      tree(-10, -18, 1.3, 301);
      tree(10, -20, 1.2, 317);
      house(11, -26, '#e9b98b', { w: 2.2, h: 1.7 });
      break;
    case 'courtyard':
      // A big house with a courtyard, a boundary wall and a tulsi plant.
      house(0, -9, '#f6e3b4', { w: 4.2, h: 2.4 });
      tree(-7, -5, 1.2, 401);
      tree(7, -5.5, 1.2, 419);
      break;
    case 'market':
      house(-9, -12, '#f6e3b4');
      house(9, -12, '#e9b98b');
      for (const x of [-4, 0, 4]) P.push({ z: -6, fn: () => drawStall(x) });
      break;
    default:
      tree(-6, -6, 1.0, 401);
      tree(6, -6, 1.0, 419);
  }
  return P;
}
function drawStall(x) {
  const top = proj(x, 2.1, -6);
  const bot = proj(x, 0, -6);
  if (!top || !bot) return;
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(bot.x - 1.1 * bot.s, bot.y - 0.9 * bot.s, 2.2 * bot.s, 0.9 * bot.s);
  ctx.fillStyle = ['#ef5350', '#ffca28', '#42a5f5'][Math.round((x + 4) / 4) % 3];
  ctx.fillRect(top.x - 1.4 * top.s, top.y - 0.15 * top.s, 2.8 * top.s, 0.3 * top.s);
}

// ---- indoor: a room with a window, a table and a chair ----
function drawIndoor() {

  ctx.fillStyle = rgb(mix(hex('#fff3e0'), [0, 0, 0], 1 - T.light));
  ctx.fillRect(0, 0, W, H);
  // floor
  const fl = [proj(-12, 0, 2), proj(12, 0, 2), proj(12, 0, -4), proj(-12, 0, -4)].filter(Boolean);
  ctx.fillStyle = '#a1887f';
  ctx.beginPath(); fl.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
  // window with sky behind it
  const a = proj(-6.5, 1.9, -3.9); const b = proj(-3.5, 4.4, -3.9);
  if (a && b) {
    ctx.fillStyle = T === TIME.night ? '#26335a' : '#8fc7f0';
    ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
    ctx.strokeStyle = '#8d6e63';
    ctx.lineWidth = 0.12 * b.s;
    ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
  }
  // table and chair (front faces)
  const tb = proj(3.4, 0.95, -1.6); const tl = proj(5.6, 0.95, -1.6);
  if (tb && tl) {
    ctx.fillStyle = '#8d6e63';
    ctx.fillRect(tb.x, tb.y - 0.12 * tb.s, tl.x - tb.x, 0.14 * tb.s);
  }
  const ch = proj(2.3, 0.9, -0.4);
  if (ch) {
    ctx.fillStyle = '#a1887f';
    ctx.fillRect(ch.x - 0.45 * ch.s, ch.y - 0.9 * ch.s, 0.9 * ch.s, 0.9 * ch.s);
  }
}

// ---- characters (drawn in local units: 1 unit = 1 world unit, feet at 0, y up) ----
function fillStroke(fill, drawPath, lw = 0.035) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = OUT;
  ctx.lineWidth = lw;
  ctx.beginPath();
  drawPath();
  ctx.fill();
  ctx.stroke();
}
function limb(x0, y0, angle, len, color, width) {
  const x1 = x0 + Math.sin(angle) * len;
  const y1 = y0 - Math.cos(angle) * len;
  ctx.strokeStyle = OUT;
  ctx.lineCap = 'round';
  ctx.lineWidth = width + 0.07;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  return { x: x1, y: y1 };
}

/** Pose for one character at local time `t` in its current action. */
function poseFor(action, t, speak = false) {
  const s = Math.sin;
  const P = { legL: 0, legR: 0, armL: 0.08, armR: -0.08, bob: 0, lean: 0, jumpLegs: false };
  switch (action) {
    case 'walk': {
      const ph = t * TAU * 1.1;
      P.legL = s(ph) * 0.5; P.legR = -s(ph) * 0.5;
      P.armL = -s(ph) * 0.45; P.armR = s(ph) * 0.45;
      P.bob = Math.abs(s(ph * 2)) * 0.05;
      break;
    }
    case 'run': {
      const ph = t * TAU * 2.2;
      P.legL = s(ph) * 0.9; P.legR = -s(ph) * 0.9;
      P.armL = -s(ph) * 0.9; P.armR = s(ph) * 0.9;
      P.bob = Math.abs(s(ph * 2)) * 0.1;
      P.lean = 0.12;
      break;
    }
    case 'jump':
      P.bob = Math.abs(s(t * TAU * 0.8)) * 0.7;
      P.armL = 2.6; P.armR = -2.6;
      P.legL = 0.35; P.legR = -0.35;
      P.jumpLegs = true;
      break;
    case 'wave':
      P.armR = 2.9 + s(t * TAU * 1.5) * 0.35;
      P.armL = -0.12;
      break;
    case 'sow': {
      // Bent over the field: the right hand reaches to the soil and dips, the left holds the seed bag.
      const ph = t * TAU * 0.6;
      P.lean = 0.3 + s(ph) * 0.04;
      P.legL = 0.7; P.legR = -0.5;
      P.armR = 1.3 + s(ph) * 0.2;
      P.armL = 0.6 - s(ph) * 0.15;
      break;
    }
    default:
      // Standing still is not allowed: weight shifts, arms sway, the head bobs a little.
      P.bob = Math.abs(s(t * TAU * 0.9)) * 0.03;
      P.legL = s(t * TAU * 0.45) * 0.12; P.legR = -s(t * TAU * 0.45) * 0.12;
      P.armL = -0.15 + s(t * TAU * 0.7) * 0.22;
      P.armR = 0.15 - s(t * TAU * 0.7 + 1.1) * 0.22;
  }
  if (speak) {
    // A speaker gestures with the right hand while talking.
    P.armR = 0.9 + s(t * TAU * 1.3) * 0.55;
    P.armL = -0.2 + s(t * TAU * 0.9) * 0.15;
    P.bob = Math.abs(s(t * TAU * 2.1)) * 0.02;
  }
  return P;
}

function drawCharacter(c, seg, t, facing) {
  const local = t - seg.start;
  const pose = poseFor(seg.action, local, !!seg.speak);
  const p = proj(seg.x, 0, 0);
  if (!p) return;
  const k = p.s;
  // Shadow under the feet (drawn in screen space so it stays flat on the ground).
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y, 0.5 * k, 0.12 * k, 0, 0, TAU); ctx.fill();
  // Local frame: origin at the feet, y up, mirrored when facing left.
  ctx.setTransform(k * facing, 0, 0, -k, p.x, p.y);
  const bob = pose.bob;
  ctx.translate(0, bob);
  const ex = facing * 0.02;
  // back hair (long hair falls behind the head)
  if (c.longHair) fillStroke(c.hair, () => { ctx.moveTo(-0.4, 1.9); ctx.lineTo(-0.42, 1.15); ctx.quadraticCurveTo(0, 0.95, 0.42, 1.15); ctx.lineTo(0.4, 1.9); ctx.closePath(); });
  // legs
  const hipL = [-0.16, 0.6]; const hipR = [0.16, 0.6];
  const legLen = 0.6;
  const footL = limb(hipL[0], hipL[1], pose.legL, legLen, c.pants, 0.2);
  const footR = limb(hipR[0], hipR[1], pose.legR, legLen, c.pants, 0.2);
  for (const f of [footL, footR]) fillStroke(c.shoe || '#222222', () => ctx.ellipse(f.x + 0.06, f.y + 0.02, 0.14, 0.08, 0, 0, TAU), 0.03);
  // torso (rounded shirt), leaning a little when running
  ctx.save();
  ctx.translate(0, 0.8);
  ctx.rotate(-pose.lean * facing);
  ctx.translate(0, -0.8);
  fillStroke(c.shirt, () => { const x = -0.32, y = 0.5, w = 0.64, h = 0.95, r = 0.26; ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); });
  // arms (sleeve colour), hands (skin)
  const shL = [-0.4, 1.35]; const shR = [0.4, 1.35];
  const hL = limb(shL[0], shL[1], pose.armL, 0.62, c.shirt, 0.18);
  const hR = limb(shR[0], shR[1], pose.armR, 0.62, c.shirt, 0.18);
  for (const h of [hL, hR]) fillStroke(c.skin, () => ctx.arc(h.x, h.y, 0.1, 0, TAU), 0.03);
  ctx.restore();
  // neck and head
  fillStroke(c.skin, () => ctx.rect(-0.1, 1.4, 0.2, 0.2), 0.02);
  fillStroke(c.skin, () => ctx.arc(0, 1.85, 0.34, 0, TAU));
  // hair cap and fringe
  fillStroke(c.hair, () => { ctx.arc(0, 1.85, 0.36, Math.PI * 1.02, Math.PI * -0.02, true); ctx.closePath(); }, 0.03);
  // cheeks
  for (const sx of [-1, 1]) {
    ctx.fillStyle = 'rgba(255,110,140,0.45)';
    ctx.beginPath(); ctx.arc(sx * 0.2 + ex, 1.66, 0.07, 0, TAU); ctx.fill();
  }
  // eyes: blink every 3.2 s; happy eyes are upward arcs
  const bt = t % 3.2;
  const closed = bt > 3.05 && bt < 3.14;
  for (const sx of [-1, 1]) {
    const x = sx * 0.12;
    if (seg.expr === 'happy') {
      ctx.strokeStyle = OUT; ctx.lineWidth = 0.03; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - 0.07, 1.9); ctx.quadraticCurveTo(x, 1.99, x + 0.07, 1.9); ctx.stroke();
    } else {
      const eh = closed ? 0.012 : 0.085;
      fillStroke('#ffffff', () => ctx.ellipse(x, 1.9, 0.07, eh, 0, 0, TAU), 0.02);
      if (!closed) {
        ctx.fillStyle = OUT;
        ctx.beginPath(); ctx.arc(x + ex * 0.9 + (seg.expr === 'surprised' ? 0 : 0), 1.89, 0.042, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(x + ex * 0.9 + 0.014, 1.91, 0.012, 0, TAU); ctx.fill();
      }
    }
  }
  // eyebrows follow the expression
  ctx.strokeStyle = c.hair; ctx.lineWidth = 0.035; ctx.lineCap = 'round';
  const brow = (sx, y, tiltInner) => { ctx.beginPath(); ctx.moveTo(sx * 0.2, y + (sx * tiltInner)); ctx.lineTo(sx * 0.04, y - (sx * tiltInner)); ctx.stroke(); };
  const expr = seg.expr || 'neutral';
  const raise = expr === 'surprised' ? 0.07 : 0;
  const tilt = expr === 'angry' ? -0.07 : expr === 'sad' ? 0.06 : 0;
  brow(-1, 2.08 + raise, tilt);
  brow(1, 2.08 + raise, -tilt);
  // mouth: talking opens and closes; otherwise the expression sets the shape
  ctx.strokeStyle = OUT; ctx.lineWidth = 0.03; ctx.lineCap = 'round';
  const talkOpen = seg.speak ? 0.02 + 0.08 * Math.abs(Math.sin(t * TAU * 4.2)) : 0;
  if (seg.speak) {
    ctx.fillStyle = '#7a2a2a';
    ctx.beginPath(); ctx.ellipse(ex * 0.5, 1.68, 0.09, 0.03 + talkOpen, 0, 0, TAU); ctx.fill();
  } else if (expr === 'happy') {
    ctx.beginPath(); ctx.moveTo(-0.1, 1.72); ctx.quadraticCurveTo(0, 1.6, 0.1, 1.72); ctx.stroke();
  } else if (expr === 'sad') {
    ctx.beginPath(); ctx.moveTo(-0.08, 1.6); ctx.quadraticCurveTo(0, 1.7, 0.08, 1.6); ctx.stroke();
  } else if (expr === 'surprised') {
    ctx.fillStyle = '#7a2a2a';
    ctx.beginPath(); ctx.ellipse(0, 1.67, 0.06, 0.07, 0, 0, TAU); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(-0.06, 1.68); ctx.lineTo(0.06, 1.68); ctx.stroke();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---- scene state ----
let spec = null; // the scene being drawn
let props = [];
let birdsOn = false;
let timeline = [];

function activeSegment(id, t) {
  let last = null;
  for (const seg of timeline) {
    if (seg.char !== id) continue;
    if (t >= seg.start && t < seg.end) return seg;
    if (seg.end <= t) last = seg;
  }
  return last;
}

/** Makes `sc` the scene that the drawing functions read (its time of day, props, timeline and camera). */
function useScene(sc) {
  spec = sc;
  T = TIME[sc.time] || TIME.day;
  props = sceneProps(sc.setting);
  birdsOn = sc.setting !== 'indoor';
  timeline = sc.timeline;
}

/** Points the camera at scene `sc` at time `t` (eased from its start pose to its end pose). */
function aimCamera(sc, t) {
  const camS = sc.camera;
  const p = ease(clamp01(t / sc.duration));
  let pos = [
    lerp(camS.from[0], camS.to[0], p) + Math.sin(t * 1.7) * 0.05,
    lerp(camS.from[1], camS.to[1], p) + Math.sin(t * 1.1) * 0.035,
    lerp(camS.from[2], camS.to[2], p),
  ];
  // A tall (9:16) frame is narrow, so the camera steps back to keep every character in the picture.
  if (H > W) {
    const k = 1.35;
    pos = [camS.look[0] + (pos[0] - camS.look[0]) * k, camS.look[1] + (pos[1] - camS.look[1]) * k, camS.look[2] + (pos[2] - camS.look[2]) * k];
  }
  setCamera(pos, camS.look, sc.fov || 38);
}

/** Draws the whole scene (sky, ground, props, characters) for the scene and time already set. */
function drawWorld(t) {
  if (spec.setting === 'indoor') {
    drawIndoor();
  } else {
    drawSky(t);
    drawSunRays(t);
    drawClouds(t);
    drawMountains();
    drawGround();
    if (spec.setting === 'river') drawRiver(t);
    if (spec.setting === 'field') drawPaddy();
    drawGrassTufts(t);
    drawRain(t);
    if (birdsOn) drawBirds(t);
    // Props far to near (painter's order by depth).
    const sorted = props.map((o) => ({ o, d: depthOf(0, 0, o.z) })).sort((a, b) => b.d - a.d);
    for (const { o } of sorted) o.fn();
  }
  // Characters, facing the way they move.
  for (const c of spec.characters) {
    const seg = activeSegment(c.id, t);
    if (!seg) continue;
    const local = t - seg.start;
    const len = Math.max(0.001, seg.end - seg.start);
    const q = clamp01(local / len);
    const x = lerp(seg.from[0], seg.to[0], q);
    const dx = seg.to[0] - seg.from[0];
    const facing = Math.abs(dx) > 0.001 ? (dx > 0 ? 1 : -1) : 1;
    drawCharacter(c, { ...seg, x }, t, facing);
  }
}

/** Warm or cool grade for the time of day, and a soft vignette for a cinematic look. */
function drawGrade() {
  if (T.tint) {
    const [r, g, b, a] = T.tint;
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    ctx.fillRect(0, 0, W, H);
  }
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

let current = null;
window.loadScene = (s) => {
  current = s;
  return true;
};

window.setFrame = (t) => {
  if (!current) throw new Error('no scene loaded');
  ctx = mainCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);
  // Scene transition: the first moments of a new scene dissolve from the last frame of the scene before it.
  // The previous scene is held at its final pose, so the length and the voice timing stay exact.
  const tr = current.transition;
  const dissolve = tr && t < tr.seconds;
  if (dissolve) {
    ctx = mainCtx;
    useScene(tr.from);
    aimCamera(tr.from, tr.fromT);
    drawWorld(tr.fromT);
    drawGrade();
    // The new scene is drawn on its own layer, then blended over the old one as one picture.
    ctx = bufferCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    useScene(current);
    aimCamera(current, t);
    drawWorld(t);
    drawGrade();
    ctx = mainCtx;
    ctx.globalAlpha = clamp01(t / tr.seconds);
    ctx.drawImage(buffer, 0, 0);
    ctx.globalAlpha = 1;
    return true;
  }
  ctx = mainCtx;
  useScene(current);
  aimCamera(current, t);
  drawWorld(t);
  drawGrade();
  return true;
};

window.STAGE_READY = true;
