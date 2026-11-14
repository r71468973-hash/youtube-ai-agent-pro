// 3D cartoon stage. Runs inside headless Chrome; the Node renderer drives it frame by frame
// through window.loadScene(spec) and window.setFrame(seconds). Every frame is a real WebGL render
// of animated, rigged characters (walk / run / jump / wave / idle, facial expressions, timed lip-sync)
// with a moving camera. Nothing here is a static picture.
import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

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
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);
scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(3, 6, 5);
scene.add(sun);

let spec = null;
let rigs = new Map();

const ENV = {
  park: { sky: 0x9fd8ff, ground: 0x7cc96a },
  village: { sky: 0xffe0b2, ground: 0xc8a165 },
  indoor: { sky: 0xfff3e0, ground: 0x8d6e63 },
  school: { sky: 0xbbdefb, ground: 0x90a4ae },
  temple: { sky: 0xffcc80, ground: 0xd7ccc8 },
};

function buildEnv(setting) {
  const p = ENV[setting] || ENV.park;
  const grp = new THREE.Group();
  scene.background = new THREE.Color(p.sky);
  scene.fog = new THREE.Fog(p.sky, 22, 60);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), toon(p.ground));
  ground.rotation.x = -Math.PI / 2;
  grp.add(ground);
  const tree = (x, z) => {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.4, 10), toon(0x8d6e63));
    trunk.position.y = 0.7;
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.95, 18, 14), toon(0x43a047));
    top.position.y = 2.1;
    t.add(trunk, top);
    t.position.set(x, 0, z);
    grp.add(t);
  };
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
  } else if (setting === 'indoor') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(30, 6, 0.2), toon(0xfff3e0));
    wall.position.set(0, 3, -4);
    grp.add(wall);
  } else {
    tree(-6, -5);
    tree(5, -6);
    tree(-2, -9);
    tree(8, -3);
  }
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
    }
  }
}

function applyFace(rig, expr, speak, t) {
  let w = 1;
  let base = 0.12;
  let y = -0.15;
  let browTilt = 0;
  let browLift = 0;
  switch (expr) {
    case 'happy': w = 1.5; base = speak ? 0.18 : 0.06; y = -0.13; break;
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
  rig.eyes.forEach((e) => { e.scale.y = closed ? 0.1 : 1; });
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

window.loadScene = (s) => {
  spec = s;
  for (const obj of [...scene.children]) if (obj.userData.dynamic) scene.remove(obj);
  rigs = new Map();
  const env = buildEnv(s.setting);
  env.userData.dynamic = true;
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
  camera.lookAt(cam.look[0], cam.look[1], cam.look[2]);

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
