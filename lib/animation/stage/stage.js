// 3D cartoon stage. Runs inside headless Chrome; the Node renderer drives it frame by frame
// through window.loadScene(spec) and window.setFrame(seconds). Every frame is a real WebGL render
// of animated, rigged characters (walk / run / jump / wave / idle, facial expressions, timed lip-sync),
// with a sky and light that match the time of day, real shadows, and a moving camera.
// Nothing here is a static picture.
import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const rnd = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// Three-tone "toon" ramp gives the cartoon look.
const toonTex = (() => {
  const t = new THREE.DataTexture(new Uint8Array([120, 190, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
const toon = (color) => new THREE.MeshToonMaterial({ color, gradientMap: toonTex });

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);
const hemi = new THREE.HemisphereLight(0xffffff, 0x556070, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.03;
scene.add(sun);

// Sky, sun colour and light for each time of day. "horizon" also tints the fog.
const TIME = {
  sunrise: { horizon: 0xffb27a, top: 0x6f8fd6, bottom: 0xffd9a8, sunColor: 0xffb070, sunIntensity: 1.7, sunPos: [-9, 2.6, 3], hemi: 1.25, fog: 0xffc795, glow: 0xffd28a, sunDisc: [-10, 3.2, -40] },
  day: { horizon: 0xcfeeff, top: 0x3f8fd9, bottom: 0xe8f6ff, sunColor: 0xffffff, sunIntensity: 1.6, sunPos: [3, 6, 5], hemi: 1.1, fog: 0xcfeeff, glow: null, sunDisc: [9, 15, -46] },
  evening: { horizon: 0xff9a6b, top: 0x4b3a86, bottom: 0xffb88a, sunColor: 0xff9060, sunIntensity: 1.3, sunPos: [8, 2.4, -4], hemi: 1.15, fog: 0xff9e7a, glow: 0xffb07a, sunDisc: [14, 3, -44] },
  night: { horizon: 0x26335a, top: 0x070b1c, bottom: 0x1b2440, sunColor: 0x9db4ff, sunIntensity: 0.6, sunPos: [-4, 8, 4], hemi: 0.5, fog: 0x1b2440, glow: null, sunDisc: null },
};
let T = TIME.day;

function applyTime(key) {
  T = TIME[key] || TIME.day;
  hemi.intensity = T.hemi;
  sun.color.setHex(T.sunColor);
  sun.intensity = T.sunIntensity;
  sun.position.set(...T.sunPos);
  scene.background = new THREE.Color(T.horizon);
  scene.fog = new THREE.Fog(T.fog, 24, 70);
}

const ENV = {
  park: { ground: 0x7cc96a },
  village: { ground: 0xc8a165 },
  indoor: { ground: 0x8d6e63 },
  school: { ground: 0x90a4ae },
  temple: { ground: 0xd7ccc8 },
  river: { ground: 0x8bc34a },
  field: { ground: 0xaed581 },
  market: { ground: 0xbcaaa4 },
};

/** Gradient sky dome: horizon colour near the ground, top colour overhead. Never receives fog or shadows. */
function buildSky() {
  const R = 120;
  const geo = new THREE.SphereGeometry(R, 32, 16);
  const pos = geo.attributes.position;
  const cols = [];
  const cHor = new THREE.Color(T.horizon);
  const cTop = new THREE.Color(T.top);
  const cBot = new THREE.Color(T.bottom);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / R;
    if (y >= 0) c.copy(cHor).lerp(cTop, Math.pow(y, 0.6));
    else c.copy(cHor).lerp(cBot, Math.min(1, -y * 4));
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }));
  sky.userData.noShadow = true;
  return sky;
}

function buildEnv(setting) {
  const p = ENV[setting] || ENV.park;
  const grp = new THREE.Group();
  grp.add(buildSky());
  // Sun disc and soft halo for sunrise and evening, placed low behind the scene.
  if (T.sunDisc) {
    const [x, y, z] = T.sunDisc;
    const disc = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), new THREE.MeshBasicMaterial({ color: T.glow || 0xffffff, fog: false }));
    disc.position.set(x, y, z);
    disc.userData.noShadow = true;
    grp.add(disc);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), new THREE.MeshBasicMaterial({ color: T.glow || 0xffffff, transparent: true, opacity: 0.28, fog: false, depthWrite: false }));
    halo.position.set(x, y, z);
    halo.userData.noShadow = true;
    grp.add(halo);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), toon(p.ground));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  grp.add(ground);
  // Small flowers scattered on the grass (not indoors).
  if (setting !== 'indoor') {
    const FLOWERS = [0xff5252, 0xffeb3b, 0xffffff, 0xba68c8, 0xff8a65];
    for (let i = 0; i < 70; i++) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), toon(FLOWERS[i % FLOWERS.length]));
      f.position.set(-12 + rnd(i) * 24, 0.07, -14 + rnd(i + 500) * 16);
      f.userData.noShadow = true;
      grp.add(f);
    }
  }
  // Mango tree: brown trunk, a dense rounded canopy of several leaf blobs, and ripe mangoes.
  const tree = (x, z, s = 1) => {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.22 * s, 1.8 * s, 10), toon(0x6d4c41));
    trunk.position.y = 0.9 * s;
    t.add(trunk);
    const blobs = [[0, 2.5, 0, 1.0], [-0.7, 2.1, 0.3, 0.75], [0.7, 2.2, -0.2, 0.8], [0.1, 3.0, 0.5, 0.7], [-0.3, 2.9, -0.5, 0.65]];
    for (const [bx, by, bz, r] of blobs) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(r * s, 16, 12), toon(0x2e7d32));
      leaf.position.set(bx * s, by * s, bz * s);
      t.add(leaf);
    }
    const mangoColors = [0xffb300, 0xffa000, 0xffd54f];
    [[-0.5, 2.0, 0.6], [0.6, 2.5, 0.5], [0.2, 1.9, -0.7], [-0.9, 2.6, -0.2]].forEach(([mx, my, mz], i) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.13 * s, 10, 8), toon(mangoColors[i % 3]));
      m.position.set(mx * s, my * s, mz * s);
      t.add(m);
    });
    t.position.set(x, 0, z);
    grp.add(t);
  };
  // Birds: two-wing V shapes that flap; animated in setFrame via userData.
  const birds = [];
  if (setting === 'village' || setting === 'park' || setting === 'field' || setting === 'river') {
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Group();
      const wingMat = toon(0x37474f);
      const wl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.14), wingMat);
      const wr = wl.clone();
      wl.position.x = -0.25; wr.position.x = 0.25;
      const bodyB = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), wingMat);
      b.add(wl, wr, bodyB);
      b.userData = { wl, wr, baseX: -14 + i * 5, baseY: 5 + (i % 2) * 1.5, baseZ: -10 - i * 2, speed: 0.6 + i * 0.1 };
      grp.add(b);
      birds.push(b);
    }
  }
  grp.userData.birds = birds;
  const house = (x, z, color) => {
    const h = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.7, 1.7), toon(color));
    h.position.set(x, 0.85, z);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.0, 4), toon(0xb71c1c));
    roof.rotation.y = Math.PI / 4;
    roof.position.set(x, 2.2, z);
    grp.add(h, roof);
  };
  if (setting === 'village') {
    house(-7, -6, 0xffab91);
    house(6, -7, 0xfff59d);
    house(0, -11, 0xa5d6a7);
    tree(-9, -3, 1.2);
    tree(9, -2, 1.1);
    tree(-4, -13, 1.4);
    tree(4, -12, 1.3);
  } else if (setting === 'indoor') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(30, 6, 0.2), toon(0xfff3e0));
    wall.position.set(0, 3, -4);
    grp.add(wall);
    // Window with a bright sky behind it, a table and a chair.
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.0), new THREE.MeshBasicMaterial({ color: T.top, fog: false }));
    sky.position.set(-5, 3.2, -3.85);
    sky.userData.noShadow = true;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.9, 2.3, 0.12), toon(0x8d6e63));
    frame.position.set(-5, 3.2, -3.9);
    grp.add(frame, sky);
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 1.2), toon(0x8d6e63));
    table.position.set(4.5, 0.95, -1.6);
    const leg = (x, z) => { const l = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.92, 0.12), toon(0x6d4c41)); l.position.set(4.5 + x, 0.46, -1.6 + z); grp.add(l); };
    leg(-0.95, -0.5); leg(0.95, -0.5); leg(-0.95, 0.5); leg(0.95, 0.5);
    const chair = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.9), toon(0xa1887f));
    chair.position.set(2.5, 0.5, -0.4);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 0.1), toon(0xa1887f));
    back.position.set(2.5, 1.0, -0.85);
    grp.add(table, chair, back);
  } else if (setting === 'river') {
    const pond = new THREE.Mesh(new THREE.CircleGeometry(3.2, 32), toon(0x4fc3f7));
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(4.5, 0.02, -5);
    grp.add(pond);
    tree(-7, -5);
    tree(-2, -11);
    tree(9, -3);
  } else if (setting === 'field') {
    for (let r = 0; r < 6; r++) {
      const row = new THREE.Mesh(new THREE.BoxGeometry(30, 0.12, 0.7), toon(r % 2 ? 0x7cb342 : 0x9ccc65));
      row.position.set(0, 0.06, -3 - r * 1.6);
      grp.add(row);
    }
    tree(-8, -8, 1.3);
    tree(9, -10, 1.2);
  } else if (setting === 'market') {
    for (const [x, c] of [[-5, 0xef5350], [0, 0xffca28], [5, 0x42a5f5]]) {
      const table = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.2), toon(0x8d6e63));
      table.position.set(x, 0.45, -5);
      const awning = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.15, 1.6), toon(c));
      awning.position.set(x, 2.1, -5);
      grp.add(table, awning);
      for (const px of [-1.2, 1.2]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 8), toon(0x6d4c41));
        pole.position.set(x + px, 1.05, -5.5);
        grp.add(pole);
      }
    }
  } else {
    tree(-6, -5);
    tree(5, -6);
    tree(-2, -9);
    tree(8, -3);
  }
  // Shadows: everything casts and receives, except the sky, sun disc and halo.
  grp.traverse((o) => { if (o.isMesh && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(grp);
  return grp;
}

function buildCharacter(c) {
  const g = new THREE.Group();
  const skin = toon(c.skin);
  const shirt = toon(c.shirt);
  const pants = toon(c.pants);
  const hair = toon(c.hair);
  const shoe = toon('#222222');
  const black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const blush = new THREE.MeshBasicMaterial({ color: 0xff7f9c, transparent: true, opacity: 0.5 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.55, 6, 14), shirt);
  torso.position.y = 1.0;
  g.add(torso);

  const head = new THREE.Group();
  head.position.y = 1.85;
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.34, 28, 20), skin));
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.37, 28, 18, 0, TAU, 0, Math.PI * 0.55), hair);
  cap.position.y = 0.05;
  head.add(cap);
  if (c.longHair) {
    const back = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.35, 4, 12), hair);
    back.position.set(0, -0.2, -0.13);
    head.add(back);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), black);
  mouth.position.set(0, -0.15, 0.31);
  head.add(mouth);
  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sx * 0.12, 0.04, 0.29);
    eye.add(new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), white));
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), black);
    pupil.position.z = 0.05;
    eye.add(pupil);
    head.add(eye);
    eyes.push(eye);
  }
  const brows = [];
  for (const sx of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.02), hair);
    b.position.set(sx * 0.12, 0.15, 0.31);
    head.add(b);
    brows.push(b);
  }
  for (const sx of [-1, 1]) {
    const ch = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), blush);
    ch.scale.set(1, 0.6, 0.3);
    ch.position.set(sx * 0.2, -0.05, 0.29);
    head.add(ch);
  }
  g.add(head);

  const arm = (sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.38, 1.35, 0);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.4, 4, 10), shirt);
    limb.position.y = -0.3;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), skin);
    hand.position.y = -0.62;
    pivot.add(limb, hand);
    g.add(pivot);
    return pivot;
  };
  const leg = (sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.16, 0.55, 0);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.42, 4, 10), pants);
    limb.position.y = -0.36;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.3), shoe);
    foot.position.set(0, -0.82, 0.05);
    pivot.add(limb, foot);
    g.add(pivot);
    return pivot;
  };

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return {
    root: g, head, torso, eyes, brows, mouth,
    armL: arm(-1), armR: arm(1), legL: leg(-1), legR: leg(1),
  };
}

function applyAction(rig, action, t) {
  const s = Math.sin;
  rig.legL.rotation.set(0, 0, 0);
  rig.legR.rotation.set(0, 0, 0);
  rig.armL.rotation.set(0, 0, 0);
  rig.armR.rotation.set(0, 0, 0);
  rig.root.position.y = 0;
  rig.torso.scale.set(1, 1, 1);
  rig.torso.rotation.set(0, 0, 0);
  rig.head.rotation.set(0, 0, 0);
  const gait = (freq, legAmp, armAmp, bob) => {
    const ph = t * TAU * freq;
    rig.legL.rotation.x = s(ph) * legAmp;
    rig.legR.rotation.x = -s(ph) * legAmp;
    rig.armL.rotation.x = -s(ph) * armAmp;
    rig.armR.rotation.x = s(ph) * armAmp;
    rig.root.position.y = Math.abs(s(ph * 2)) * bob;
  };
  switch (action) {
    case 'walk':
      gait(1.1, 0.5, 0.45, 0.05);
      break;
    case 'run':
      gait(2.2, 0.9, 0.9, 0.1);
      rig.torso.rotation.x = 0.12; // lean forward while running
      break;
    case 'jump':
      rig.root.position.y = Math.abs(s(t * TAU * 0.8)) * 0.7;
      rig.armL.rotation.x = -2.4;
      rig.armR.rotation.x = -2.4;
      rig.legL.rotation.x = 0.35;
      rig.legR.rotation.x = -0.35;
      break;
    case 'wave':
      rig.armR.rotation.x = -2.5;
      rig.armR.rotation.z = s(t * TAU * 1.5) * 0.5;
      rig.armL.rotation.z = -0.12;
      break;
    default: {
      rig.torso.scale.y = 1 + s(t * TAU * 0.5) * 0.015;
      rig.armL.rotation.z = -0.12;
      rig.armR.rotation.z = 0.12;
      rig.head.rotation.y = s(t * TAU * 0.3) * 0.08; // idle head turn
    }
  }
}

function applyFace(rig, expr, speak, t) {
  let w = 1;
  let base = 0.12;
  let y = -0.15;
  let browTilt = 0;
  let browLift = 0;
  let eyeBase = 1;
  switch (expr) {
    case 'happy': w = 1.5; base = speak ? 0.18 : 0.06; y = -0.13; eyeBase = 0.7; break;
    case 'sad': w = 0.9; base = 0.06; y = -0.2; browTilt = -0.35; break;
    case 'surprised': w = 0.8; base = 0.5; y = -0.12; browLift = 0.03; break;
    case 'angry': w = 1.1; base = 0.08; y = -0.16; browTilt = 0.45; break;
    default: break;
  }
  const talk = speak ? 0.22 + 0.42 * Math.abs(Math.sin(t * TAU * 4.2)) : 0;
  rig.mouth.scale.set(w, base + talk, 0.5);
  rig.mouth.position.y = y;
  rig.brows.forEach((b, i) => {
    const sx = i === 0 ? -1 : 1;
    b.rotation.z = sx * browTilt;
    b.position.y = 0.15 + browLift;
  });
  // Blink about every 3.2 seconds.
  const bt = t % 3.2;
  const closed = bt > 3.06 && bt < 3.14;
  rig.eyes.forEach((e) => { e.scale.y = closed ? 0.1 : eyeBase; });
}

function activeSegment(timeline, id, t) {
  let last = null;
  for (const seg of timeline) {
    if (seg.char !== id) continue;
    if (t >= seg.start && t < seg.end) return seg;
    if (seg.end <= t) last = seg;
  }
  return last;
}

let spec = null;
let rigs = new Map();
let birdList = [];

window.loadScene = (s) => {
  spec = s;
  for (const obj of [...scene.children]) if (obj.userData.dynamic) scene.remove(obj);
  applyTime(s.time || 'day');
  rigs = new Map();
  const env = buildEnv(s.setting);
  env.userData.dynamic = true;
  birdList = env.userData.birds || [];
  for (const c of s.characters) {
    const rig = buildCharacter(c);
    rig.root.userData.dynamic = true;
    scene.add(rig.root);
    rigs.set(c.id, rig);
  }
  camera.fov = s.fov || 38;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  return true;
};

window.setFrame = (t) => {
  if (!spec) throw new Error('no scene loaded');
  const cam = spec.camera;
  const p = ease(clamp01(t / spec.duration));
  camera.position.set(
    lerp(cam.from[0], cam.to[0], p),
    lerp(cam.from[1], cam.to[1], p),
    lerp(cam.from[2], cam.to[2], p),
  );
  // Handheld feel: a slow, small sway so the shot is never perfectly still.
  camera.position.x += Math.sin(t * 1.7) * 0.05;
  camera.position.y += Math.sin(t * 1.1) * 0.035;
  camera.lookAt(cam.look[0], cam.look[1], cam.look[2]);

  // Birds glide across the sky and flap their wings; positions depend only on t, so frames are deterministic.
  for (const b of birdList) {
    const u = b.userData;
    const flap = Math.sin(t * 9 + u.baseX) * 0.6;
    u.wl.rotation.z = flap;
    u.wr.rotation.z = -flap;
    b.position.set(((u.baseX + t * u.speed * 2) % 40) - 20, u.baseY + Math.sin(t * 1.3 + u.baseZ) * 0.3, u.baseZ);
  }
  for (const c of spec.characters) {
    const rig = rigs.get(c.id);
    const seg = activeSegment(spec.timeline, c.id, t);
    if (!seg) continue;
    const local = t - seg.start;
    const len = Math.max(0.001, seg.end - seg.start);
    const q = clamp01(local / len);
    const dx = seg.to[0] - seg.from[0];
    const dz = seg.to[1] - seg.from[1];
    rig.root.position.x = seg.from[0] + dx * q;
    rig.root.position.z = seg.from[1] + dz * q;
    rig.root.rotation.y = Math.abs(dx) + Math.abs(dz) > 0.001 ? Math.atan2(dx, dz) : 0;
    applyAction(rig, seg.action, local);
    applyFace(rig, seg.expr || 'neutral', !!seg.speak, local);
  }
  renderer.render(scene, camera);
  return true;
};

window.STAGE_READY = true;
