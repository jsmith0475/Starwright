// Starwright assembly building — the 3D interiors (all original, all procedural).
//
//   buildHall(renderer, { site: 'pad' | 'runway', meshApi }) → {
//     group,                 THREE.Group in world space: floor at y = 0, the assembly bay centred on the origin
//     site, size: {w, d, h}, the interior box (x, z, height) for camera limits
//     keyLight,              the one shadow-casting light (follows the craft through update())
//     envMap,                small procedural environment (PMREM) for reflections
//     update(dt, { top, focus })   animates lamps / crew and hangs the crane hook above `top` (world Vector3)
//     dispose()
//   }
//
// 'pad'    → the Vehicle Assembly Building: a tall hall with service gantries, catwalks, a bridge crane, a height mast.
// 'runway' → the Spaceplane Hangar: a wide, low, arched hall with the long door open onto the apron.
// Static geometry is merged per material (a handful of draw calls); lamps are instanced.
import * as THREE from '../../lib/three.module.min.js';

const C = {
  steel: 0x586675, steelDark: 0x38434f, steelLight: 0x77848f, amber: 0xe0a236, teal: 0x2fb3a6, white: 0xdde3e8,
  red: 0xb23a2e, dark: 0x1a1f26, rubber: 0x121418, concrete: 0x8b9096, orange: 0xe8742a, blue: 0x3a6ea8, wood: 0x9a744a,
};

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------------------------------------- batching
function makeBatch() {
  const buckets = new Map();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyls = new Map();
  const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const col = new THREE.Color();
  const api = {
    geo(key, geo, m, color) { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push({ geo, m: m.clone(), color }); },
    box(key, w, h, d, x, y, z, color, ry = 0, rx = 0, rz = 0) {
      const m = new THREE.Matrix4().compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz, 'YXZ')), s.set(w, h, d));
      api.geo(key, box, m, color);
    },
    /** A box beam from point a to point b with cross-section w × d. */
    beam(key, a, b, w, d, color) {
      const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
      const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()), s.set(w, len, d));
      api.geo(key, box, m, color);
    },
    cyl(key, r, h, x, y, z, color, { rTop = r, seg = 16, rx = 0, rz = 0, ry = 0 } = {}) {
      const k = seg + ':' + (rTop / r).toFixed(3);
      if (!cyls.has(k)) cyls.set(k, new THREE.CylinderGeometry(rTop / r, 1, 1, seg));
      const m = new THREE.Matrix4().compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz, 'YXZ')), s.set(r, h, r));
      api.geo(key, cyls.get(k), m, color);
    },
    build(materials, group, flags = {}) {
      const made = [];
      for (const [key, items] of buckets) {
        let nv = 0, ni = 0;
        for (const it of items) { nv += it.geo.attributes.position.count; ni += it.geo.index ? it.geo.index.count : it.geo.attributes.position.count; }
        const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), cl = new Float32Array(nv * 3);
        const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
        let vo = 0, io = 0;
        const nm = new THREE.Matrix3(), v = new THREE.Vector3();
        for (const it of items) {
          const g = it.geo, pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv, n = pa.count;
          nm.getNormalMatrix(it.m); col.set(it.color ?? 0xffffff);
          for (let i = 0; i < n; i++) {
            v.fromBufferAttribute(pa, i).applyMatrix4(it.m); pos.set([v.x, v.y, v.z], (vo + i) * 3);
            v.fromBufferAttribute(na, i).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], (vo + i) * 3);
            if (ua) { uv[(vo + i) * 2] = ua.getX(i); uv[(vo + i) * 2 + 1] = ua.getY(i); }
            cl.set([col.r, col.g, col.b], (vo + i) * 3);
          }
          if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
          else for (let i = 0; i < n; i++) idx[io++] = vo + i;
          vo += n;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setAttribute('color', new THREE.BufferAttribute(cl, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        const mesh = new THREE.Mesh(geo, materials[key]);
        const f = flags[key] || {};
        mesh.castShadow = f.cast !== false; mesh.receiveShadow = f.receive !== false;
        mesh.name = 'hall_' + key;
        group.add(mesh); made.push(mesh);
      }
      box.dispose(); for (const g of cyls.values()) g.dispose();
      return made;
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------- textures
let ANISO_CAP = 16;   // 1 while a low-quality hall is being built: anisotropic sampling is what software GL spends its time on
function canvasTex(w, h, draw, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(aniso, ANISO_CAP);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
function speckle(c, w, h, r, n, alpha, sizeMax = 3) {
  for (let i = 0; i < n; i++) {
    const v = r() < 0.5 ? 255 : 0;
    c.fillStyle = `rgba(${v},${v},${v},${(r() * alpha).toFixed(3)})`;
    const s = 1 + r() * sizeMax; c.fillRect(r() * w, r() * h, s, s);
  }
}
const FONT = 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif';

/** Grime map shared by every painted prop: near-white with scuffs, edge wear and streaks (multiplies vertex colours). */
function grimeTexture() {
  const r = rng(11);
  return canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#e9e9e9'; c.fillRect(0, 0, w, h);
    speckle(c, w, h, r, 1800, 0.10, 4);
    for (let i = 0; i < 26; i++) {                         // vertical dirt streaks
      const x = r() * w, len = 30 + r() * 140, g = c.createLinearGradient(0, 0, 0, len);
      g.addColorStop(0, `rgba(40,34,28,${0.05 + r() * 0.12})`); g.addColorStop(1, 'rgba(40,34,28,0)');
      c.fillStyle = g; c.save(); c.translate(x, r() * h * 0.6); c.fillRect(0, 0, 2 + r() * 5, len); c.restore();
    }
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1;
    for (let i = 0; i < 40; i++) { const x = r() * w, y = r() * h; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 8); c.stroke(); }
    const e = c.createLinearGradient(0, 0, 0, h);          // darker toward the bottom edge, worn bright rim
    e.addColorStop(0, 'rgba(255,255,255,0.10)'); e.addColorStop(0.08, 'rgba(0,0,0,0)'); e.addColorStop(0.85, 'rgba(0,0,0,0)'); e.addColorStop(1, 'rgba(0,0,0,0.28)');
    c.fillStyle = e; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 3; c.strokeRect(1.5, 1.5, w - 3, h - 3);
  });
}

/** Ribbed wall cladding tile: 8 m wide × 8 m high per repeat. */
function wallTexture(tint) {
  const r = rng(23);
  return canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = tint; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {                      // corrugation
      const g = c.createLinearGradient(x, 0, x + 16, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.45, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(x, 0, 16, h);
    }
    for (const y of [0, 170, 341]) { c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(0, y, w, 3); c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(0, y + 3, w, 2); }
    for (let x = 0; x < w; x += 128) { c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x, 0, 2, h); }
    for (let i = 0; i < 46; i++) {                         // rust and water streaks under the seams
      const x = r() * w, y0 = [0, 170, 341][Math.floor(r() * 3)], len = 30 + r() * 120;
      const g = c.createLinearGradient(0, y0, 0, y0 + len);
      const rust = r() < 0.4;
      g.addColorStop(0, rust ? `rgba(120,70,36,${0.18 + r() * 0.2})` : `rgba(8,10,12,${0.12 + r() * 0.2})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(x, y0 + 3, 3 + r() * 7, len);
    }
    speckle(c, w, h, r, 2600, 0.07, 3);
  }, { repeat: [1, 1] });
}

function concreteDetail() {
  const r = rng(5);
  return canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#9a9a9a'; c.fillRect(0, 0, w, h);
    speckle(c, w, h, r, 5000, 0.16, 3);
    for (let i = 0; i < 12; i++) { c.fillStyle = `rgba(255,255,255,${0.03 + r() * 0.05})`; c.beginPath(); c.ellipse(r() * w, r() * h, 20 + r() * 50, 10 + r() * 30, r() * 3, 0, 7); c.fill(); }
  }, { srgb: false, repeat: [34, 34] });
}

/** Painted concrete floor. `span` metres across the texture; draw(c, ppm, cx, cy) adds the hall-specific markings. */
function floorTexture(span, mark) {
  const r = rng(77), N = 2048;
  return canvasTex(N, N, (c, w, h) => {
    const ppm = w / span, cx = w / 2, cy = h / 2;
    c.fillStyle = '#5b6168'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {                        // mottling
      const v = r() < 0.5 ? 255 : 0;
      c.fillStyle = `rgba(${v},${v},${v},${(0.012 + r() * 0.03).toFixed(3)})`;
      c.beginPath(); c.ellipse(r() * w, r() * h, 30 + r() * 160, 20 + r() * 110, r() * 3, 0, 7); c.fill();
    }
    speckle(c, w, h, r, 9000, 0.06, 3);
    c.strokeStyle = 'rgba(18,20,24,0.55)'; c.lineWidth = 2;  // slab joints every 6 m
    for (let m = -span / 2; m <= span / 2; m += 6) { const x = cx + m * ppm; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.moveTo(0, x); c.lineTo(w, x); c.stroke(); }
    for (let i = 0; i < 70; i++) {                         // oil stains and patches
      const x = r() * w, y = r() * h, s = 8 + r() * 40, g = c.createRadialGradient(x, y, 1, x, y, s);
      g.addColorStop(0, `rgba(14,14,16,${0.10 + r() * 0.22})`); g.addColorStop(1, 'rgba(14,14,16,0)');
      c.fillStyle = g; c.fillRect(x - s, y - s, s * 2, s * 2);
    }
    c.lineCap = 'round';
    for (let i = 0; i < 16; i++) {                         // tyre arcs
      c.strokeStyle = `rgba(12,12,14,${0.06 + r() * 0.1})`; c.lineWidth = 0.28 * ppm;
      const x = r() * w, y = r() * h, rad = (6 + r() * 26) * ppm, a0 = r() * 6.3;
      c.beginPath(); c.arc(x, y, rad, a0, a0 + 0.3 + r() * 0.9); c.stroke();
      c.beginPath(); c.arc(x, y, rad + 1.7 * ppm, a0, a0 + 0.3 + r() * 0.9); c.stroke();
    }
    c.lineCap = 'butt';
    mark(c, ppm, cx, cy, r);
    for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(91,97,104,${0.25 + r() * 0.5})`; c.fillRect(r() * w, r() * h, 2 + r() * 9, 1 + r() * 3); }   // paint wear
  });
}
function hazardBand(c, x, y, w, h, step = 26) {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.fillStyle = '#d9a02e'; c.fillRect(x, y, w, h);
  c.fillStyle = '#1a1c20';
  for (let k = -h; k < w + h; k += step * 2) { c.beginPath(); c.moveTo(x + k, y + h); c.lineTo(x + k + step, y + h); c.lineTo(x + k + step + h, y); c.lineTo(x + k + h, y); c.closePath(); c.fill(); }
  c.restore();
}

/** What you see through the open doors: sky, haze, far hills, the launch complex, sunlit apron. */
function backdropTexture(kind) {
  const r = rng(kind === 'runway' ? 91 : 41);
  return canvasTex(1024, 512, (c, w, h) => {
    const hz = h * 0.66;
    const sky = c.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#5e9bdc'); sky.addColorStop(0.55, '#a9cdee'); sky.addColorStop(1, '#f1ead8');
    c.fillStyle = sky; c.fillRect(0, 0, w, hz);
    const sun = c.createRadialGradient(w * 0.62, hz * 0.42, 4, w * 0.62, hz * 0.42, w * 0.34);
    sun.addColorStop(0, 'rgba(255,252,236,1)'); sun.addColorStop(0.08, 'rgba(255,246,214,0.85)'); sun.addColorStop(1, 'rgba(255,240,200,0)');
    c.fillStyle = sun; c.fillRect(0, 0, w, hz);
    for (let i = 0; i < 9; i++) {                          // soft clouds
      const x = r() * w, y = hz * (0.12 + r() * 0.5), s = 40 + r() * 90;
      for (let k = 0; k < 6; k++) { const g = c.createRadialGradient(x + k * s * 0.35, y + (r() - 0.5) * 10, 2, x + k * s * 0.35, y, s * 0.5); g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(x - s, y - s, s * 5, s * 2); }
    }
    c.fillStyle = '#93a8b4'; c.beginPath(); c.moveTo(0, hz);       // far hills
    for (let x = 0; x <= w; x += 16) c.lineTo(x, hz - 14 - Math.sin(x * 0.011) * 9 - Math.sin(x * 0.037 + 1) * 5 - r() * 2);
    c.lineTo(w, hz); c.fill();
    c.fillStyle = '#6f8f7c'; c.fillRect(0, hz - 5, w, 7);          // tree line
    const g2 = c.createLinearGradient(0, hz, 0, h); g2.addColorStop(0, '#b9b6a6'); g2.addColorStop(0.25, '#a9aaa2'); g2.addColorStop(1, '#8d9093');
    c.fillStyle = g2; c.fillRect(0, hz, w, h - hz);                 // apron
    c.strokeStyle = 'rgba(240,240,230,0.5)'; c.lineWidth = 2;
    for (let k = -8; k <= 8; k++) { c.beginPath(); c.moveTo(w / 2 + k * 14, hz + 2); c.lineTo(w / 2 + k * 150, h); c.stroke(); }
    c.fillStyle = '#56606a';                                         // distant launch tower and buildings
    if (kind === 'runway') {
      c.fillRect(w * 0.12, hz - 26, 70, 26); c.fillRect(w * 0.8, hz - 18, 110, 18); c.fillRect(w * 0.3, hz - 60, 8, 60); c.fillRect(w * 0.293, hz - 66, 22, 8);
      c.fillStyle = 'rgba(245,245,235,0.8)'; for (let k = 0; k < 12; k++) c.fillRect(w / 2 - 3, hz + 6 + k * k * 1.6, 6, 4 + k * 1.5);
    } else {
      const tx = w * 0.37; c.fillRect(tx, hz - 120, 9, 120); c.fillRect(tx + 20, hz - 150, 5, 150);
      for (let y = hz - 116; y < hz; y += 12) { c.fillRect(tx, y, 25, 2); }
      c.fillStyle = '#e8ecef'; c.fillRect(tx + 31, hz - 96, 8, 96); c.beginPath(); c.moveTo(tx + 31, hz - 96); c.lineTo(tx + 35, hz - 112); c.lineTo(tx + 39, hz - 96); c.fill();
      c.fillStyle = '#56606a'; c.fillRect(w * 0.7, hz - 22, 120, 22); c.fillRect(w * 0.08, hz - 14, 90, 14);
    }
    const haze = c.createLinearGradient(0, hz - 60, 0, hz + 40); haze.addColorStop(0, 'rgba(240,236,220,0)'); haze.addColorStop(0.6, 'rgba(240,236,220,0.5)'); haze.addColorStop(1, 'rgba(240,236,220,0)');
    c.fillStyle = haze; c.fillRect(0, hz - 60, w, 100);
  });
}

function glowTexture() {
  return canvasTex(128, 128, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 1, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,246,222,1)'); g.addColorStop(0.18, 'rgba(255,236,196,0.55)'); g.addColorStop(0.5, 'rgba(255,226,170,0.12)'); g.addColorStop(1, 'rgba(255,220,160,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  });
}
/** Lamp bloom: a hot core, a soft shoulder and a long faint skirt (drawn additively, so it must reach zero at the rim). */
function bloomTexture() {
  return canvasTex(256, 256, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    for (let i = 0; i <= 24; i++) { const t = i / 24, a = Math.pow(1 - t, 3.2) * 0.9 + Math.exp(-t * t * 90) * 0.6; g.addColorStop(t, `rgba(255,255,255,${Math.min(1, a * (1 - t * t)).toFixed(4)})`); }
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  }, { srgb: false });
}
/** Contact shade: black, densest in the middle, gone at the rim. */
function shadeTexture() {
  return canvasTex(128, 128, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    for (let i = 0; i <= 12; i++) { const t = i / 12; g.addColorStop(t, `rgba(0,0,0,${(Math.pow(1 - t, 1.6) * (0.55 + 0.45 * Math.min(1, t * 3))).toFixed(4)})`); }
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  }, { srgb: false });
}
/** Seam shade for the floor/wall corners: v = 0 at the corner (dark) fading out at v = 1. */
function seamTexture() {
  return canvasTex(8, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, h, 0, 0);
    for (let i = 0; i <= 10; i++) { const t = i / 10; g.addColorStop(t, `rgba(0,0,0,${(Math.pow(1 - t, 2.2)).toFixed(4)})`); }
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, { srgb: false });
}
function shaftTexture() {
  return canvasTex(64, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const s = c.createLinearGradient(0, 0, w, 0); s.addColorStop(0, 'rgba(0,0,0,1)'); s.addColorStop(0.3, 'rgba(0,0,0,0)'); s.addColorStop(0.7, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,1)');
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = s; c.fillRect(0, 0, w, h);
  });
}
/** A ruler face: `len` metres tall, a tick per metre, a number every five. */
function rulerTexture(len) {
  return canvasTex(128, 4096, (c, w, h) => {
    const ppm = h / len;
    c.fillStyle = '#e9edf0'; c.fillRect(0, 0, w, h);
    for (let m = 0; m < len; m++) if (Math.floor(m / 5) % 2) { c.fillStyle = 'rgba(224,162,54,0.28)'; c.fillRect(0, h - (m + 1) * ppm, w, ppm); }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let m = 0; m <= len; m++) {
      const y = h - m * ppm, five = m % 5 === 0;
      c.fillStyle = five ? '#c8362b' : '#1b1f26';
      c.fillRect(0, y - (five ? 3 : 1.5), five ? w : w * 0.42, five ? 6 : 3);
      c.fillStyle = '#1b1f26'; c.fillRect(0, y - ppm / 2 - 1, w * 0.22, 2);
      if (five && m > 0) { c.fillStyle = '#12171d'; c.font = `800 ${Math.min(58, ppm * 0.86)}px ${FONT}`; c.fillText(String(m), w * 0.6, y - ppm * 0.52); }
    }
  }, { aniso: 16 });
}
function signTexture(lines, { bg = '#18202a', fg = '#e8eef4', accent = '#39d0c0', w = 512, h = 160 } = {}) {
  return canvasTex(w, h, (c) => {
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    c.fillStyle = accent; c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = fg; c.font = `800 ${Math.round(h * 0.42)}px ${FONT}`; c.fillText(lines[0], w / 2, h * (lines[1] ? 0.4 : 0.52));
    if (lines[1]) { c.fillStyle = accent; c.font = `700 ${Math.round(h * 0.17)}px ${FONT}`; c.fillText(lines[1], w / 2, h * 0.76); }
  });
}

// ---------------------------------------------------------------------------------------------- shared props
const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Everything that stands on the floor registers a soft contact shade here (drawn as one instanced mesh by buildHall).
let GROUND = [];
const gnd = (x, z, sx, sz = sx, ry = 0, a = 1) => { GROUND.push([x, z, sx, sz, ry, a]); };

function addTruss(b, a, c, depth, color, bays = 10, w = 0.3) {
  // planar truss between a and c (bottom chord), top chord `depth` above, with diagonals
  const up = V(0, depth, 0), A2 = a.clone().add(up), C2 = c.clone().add(up);
  b.beam('steel', a, c, w, w, color); b.beam('steel', A2, C2, w, w, color);
  for (let i = 0; i <= bays; i++) {
    const p0 = a.clone().lerp(c, i / bays), p1 = p0.clone().add(up);
    b.beam('steel', p0, p1, w * 0.6, w * 0.6, color);
    if (i < bays) { const n0 = a.clone().lerp(c, (i + 1) / bays); b.beam('steel', i % 2 ? p0 : p1, i % 2 ? n0.clone().add(up) : n0, w * 0.5, w * 0.5, color); }
  }
}
function addRailing(b, a, c, color = C.amber, h = 1.1) {
  const n = Math.max(1, Math.round(a.distanceTo(c) / 2.4));
  for (let i = 0; i <= n; i++) { const p = a.clone().lerp(c, i / n); b.box('paint', 0.07, h, 0.07, p.x, p.y + h / 2, p.z, color); }
  b.beam('paint', a.clone().add(V(0, h, 0)), c.clone().add(V(0, h, 0)), 0.07, 0.07, color);
  b.beam('paint', a.clone().add(V(0, h * 0.5, 0)), c.clone().add(V(0, h * 0.5, 0)), 0.045, 0.045, color);
}
function addToolChest(b, x, z, ry, color = C.red) {
  gnd(x, z, 2.6, 1.9, ry);
  const cs = Math.cos(ry), sn = Math.sin(ry);
  b.box('paint', 1.5, 0.95, 0.65, x, 0.67, z, color, ry);
  b.box('paint', 1.2, 0.5, 0.55, x, 1.4, z, color, ry);
  b.box('steel', 1.56, 0.05, 0.7, x, 1.16, z, C.steelLight, ry);
  for (let k = 0; k < 4; k++) b.box('steel', 1.3, 0.03, 0.03, x + sn * 0.335, 0.36 + k * 0.2, z + cs * 0.335, C.steelLight, ry);
  for (const [dx, dz] of [[-0.6, -0.25], [0.6, -0.25], [-0.6, 0.25], [0.6, 0.25]]) b.cyl('rubber', 0.09, 0.07, x + dx * cs + dz * sn, 0.09, z - dx * sn + dz * cs, C.rubber, { rx: Math.PI / 2, ry, seg: 10 });
}
function addCrateStack(b, x, z, r, n = 3) {
  gnd(x, z, 4.2, 4.2, 0, 0.9);
  const cols = [C.wood, 0x8c6a42, 0x6f7f52, 0x3d5f78, C.wood];
  let y = 0.14;
  b.box('paint', 1.5, 0.14, 1.3, x, 0.07, z, 0x7a5a36, r() * 0.3);
  for (let i = 0; i < n; i++) {
    const s = 0.8 + r() * 0.5, hh = 0.6 + r() * 0.5, ry = (r() - 0.5) * 0.5;
    b.box('paint', s, hh, s * (0.8 + r() * 0.3), x + (r() - 0.5) * 0.2, y + hh / 2, z + (r() - 0.5) * 0.2, cols[Math.floor(r() * cols.length)], ry);
    b.box('paint', s * 1.03, 0.05, 0.09, x, y + hh * 0.3, z, C.dark, ry);
    y += hh;
  }
}
function addDrums(b, x, z, r, n = 4) {
  gnd(x, z, 4.0, 4.0, 0, 0.8);
  const cols = [C.white, C.teal, C.amber, C.blue];
  for (let i = 0; i < n; i++) {
    const dx = (i % 2) * 0.98 + (r() - 0.5) * 0.1, dz = Math.floor(i / 2) * 0.98 + (r() - 0.5) * 0.1, col = cols[Math.floor(r() * cols.length)];
    b.cyl('paint', 0.44, 1.25, x + dx, 0.625, z + dz, col, { seg: 18 });
    for (const yy of [0.32, 0.92]) b.cyl('steel', 0.455, 0.05, x + dx, yy, z + dz, C.steelDark, { seg: 18 });
    b.cyl('steel', 0.06, 0.05, x + dx + 0.25, 1.27, z + dz, C.steelLight, { seg: 8 });
  }
}
function addCone(b, x, z) { gnd(x, z, 1.1, 1.1, 0, 0.8); b.cyl('paint', 0.2, 0.6, x, 0.32, z, C.orange, { rTop: 0.03, seg: 12 }); b.box('paint', 0.42, 0.04, 0.42, x, 0.02, z, C.orange); b.cyl('paint', 0.125, 0.1, x, 0.38, z, C.white, { rTop: 0.1, seg: 12 }); }
function addTug(b, x, z, ry, color = C.amber) {
  gnd(x, z, 5.2, 3.4, ry);
  const cs = Math.cos(ry), sn = Math.sin(ry), at = (dx, dz) => [x + dx * cs + dz * sn, z - dx * sn + dz * cs];
  b.box('paint', 3.0, 0.7, 1.6, x, 0.75, z, color, ry);
  let [px, pz] = at(-0.7, 0); b.box('paint', 1.1, 0.9, 1.4, px, 1.5, pz, C.white, ry);
  b.box('glass', 1.12, 0.5, 1.2, px, 1.62, pz, 0x1c2a36, ry);
  [px, pz] = at(1.0, 0); b.box('paint', 0.9, 0.25, 1.3, px, 1.2, pz, C.steelDark, ry);
  for (const [dx, dz] of [[-1, 0.8], [1, 0.8], [-1, -0.8], [1, -0.8]]) { [px, pz] = at(dx, dz); b.cyl('rubber', 0.42, 0.34, px, 0.42, pz, C.rubber, { rx: Math.PI / 2, ry, seg: 16 }); b.cyl('steel', 0.2, 0.36, px, 0.42, pz, C.steelLight, { rx: Math.PI / 2, ry, seg: 10 }); }
  [px, pz] = at(2.3, 0); b.box('steel', 1.6, 0.08, 0.1, px, 0.45, pz, C.steelDark, ry);
  [px, pz] = at(-1.45, 0.5); b.cyl('emit', 0.09, 0.06, px, 1.99, pz, 0xffb347, { seg: 8 });
}
function addScissorLift(b, x, z, ry, lift = 3.2) {
  gnd(x, z, 5.4, 3.6, ry);
  b.box('paint', 2.6, 0.5, 1.3, x, 0.5, z, C.blue, ry);
  for (const [dx, dz] of [[-0.95, 0.6], [0.95, 0.6], [-0.95, -0.6], [0.95, -0.6]]) b.cyl('rubber', 0.26, 0.2, x + dx * Math.cos(ry) + dz * Math.sin(ry), 0.26, z - dx * Math.sin(ry) + dz * Math.cos(ry), C.rubber, { rx: Math.PI / 2, ry, seg: 12 });
  const cs = Math.cos(ry), sn = Math.sin(ry), n = 3, seg = (lift - 0.8) / n;
  for (let i = 0; i < n; i++) for (const s of [-1, 1]) for (const side of [-0.5, 0.5]) {
    const y0 = 0.8 + i * seg, a = V(x - s * 1.1 * cs + side * sn, y0, z + s * 1.1 * sn + side * cs), c2 = V(x + s * 1.1 * cs + side * sn, y0 + seg, z - s * 1.1 * sn + side * cs);
    b.beam('steel', a, c2, 0.08, 0.05, C.steelLight);
  }
  b.box('paint', 2.7, 0.12, 1.4, x, lift + 0.06, z, C.blue, ry);
  const cnr = [[-1.3, -0.65], [1.3, -0.65], [1.3, 0.65], [-1.3, 0.65]].map(([dx, dz]) => V(x + dx * cs + dz * sn, lift + 0.12, z - dx * sn + dz * cs));
  for (let i = 0; i < 4; i++) addRailing(b, cnr[i], cnr[(i + 1) % 4], C.amber, 1.05);
}
/** A spare tank lying on a transport dolly. */
function addDolly(b, x, z, ry, len = 5, rad = 0.72, color = C.white) {
  gnd(x, z, len + 2.4, rad * 2 + 2.6, ry);
  const cs = Math.cos(ry), sn = Math.sin(ry);
  b.box('paint', len + 0.8, 0.18, 1.5, x, 0.6, z, C.amber, ry);
  for (const dx of [-len * 0.36, len * 0.36]) {
    for (const dz of [-0.78, 0.78]) b.cyl('rubber', 0.36, 0.26, x + dx * cs + dz * sn, 0.36, z - dx * sn + dz * cs, C.rubber, { rx: Math.PI / 2, ry, seg: 14 });
    b.box('steel', 0.3, 0.5, 1.5, x + dx * cs, 0.85, z - dx * sn, C.steelDark, ry);
  }
  b.cyl('paint', rad, len, x, 1.05 + rad, z, color, { rz: Math.PI / 2, ry, seg: 28 });
  for (const k of [-0.32, 0.36]) b.cyl('paint', rad * 1.012, 0.28, x + k * len * cs, 1.05 + rad, z - k * len * sn, C.teal, { rz: Math.PI / 2, ry, seg: 28 });
  for (const k of [-0.5, 0.5]) b.cyl('steel', rad * 0.96, 0.08, x + k * (len + 0.06) * cs, 1.05 + rad, z - k * (len + 0.06) * sn, C.steelDark, { rz: Math.PI / 2, ry, seg: 28 });
}
function addDesk(b, x, z, ry) {
  gnd(x, z, 4.4, 3.0, ry, 0.9);
  const cs = Math.cos(ry), sn = Math.sin(ry);
  b.box('paint', 2.4, 0.08, 0.9, x, 0.95, z, C.steelLight, ry);
  b.box('paint', 2.3, 0.9, 0.06, x - sn * 0.4, 0.47, z - cs * 0.4, C.steelDark, ry);
  for (const dx of [-0.6, 0.35]) {
    b.box('paint', 0.8, 0.5, 0.06, x + dx * cs - sn * 0.25, 1.32, z - dx * sn - cs * 0.25, C.dark, ry);
    b.box('emit', 0.72, 0.42, 0.02, x + dx * cs - sn * 0.21, 1.32, z - dx * sn - cs * 0.21, dx < 0 ? 0x39d0c0 : 0x6cb6ff, ry);
  }
}
/** Open service tower: `levels` decks `step` metres apart, footprint s × s, with stairs and bracing. */
function addTower(b, x, z, s, step, levels, face /* +1: arms reach toward +x */, armLen = 3.2) {
  gnd(x, z, s + 5, s + 5);
  const hs = s / 2, H = step * levels;
  for (const [dx, dz] of [[-hs, -hs], [hs, -hs], [-hs, hs], [hs, hs]]) b.box('steel', 0.34, H + 1.2, 0.34, x + dx, (H + 1.2) / 2, z + dz, C.steel);
  for (let i = 1; i <= levels; i++) {
    const y = i * step;
    b.box('paint', s + 0.3, 0.16, s + 0.3, x, y, z, C.steelDark);
    for (const [ax, az, cx, cz] of [[-hs, -hs, hs, -hs], [hs, -hs, hs, hs], [hs, hs, -hs, hs], [-hs, hs, -hs, -hs]]) {
      if ((face > 0 && ax === hs && cx === hs) || (face < 0 && ax === -hs && cx === -hs)) continue;   // open toward the craft
      addRailing(b, V(x + ax, y + 0.08, z + az), V(x + cx, y + 0.08, z + cz));
    }
    // cross bracing on the two side faces, alternating
    for (const sz of [-hs, hs]) b.beam('steel', V(x - hs, y - step, z + sz), V(x + hs, y, z + sz), 0.12, 0.12, C.steel);
    b.beam('steel', V(x - face * hs, y - step, z - hs), V(x - face * hs, y, z + hs), 0.12, 0.12, C.steel);
    // stair flight inside
    const up = i % 2 ? 1 : -1;
    b.beam('paint', V(x - face * hs * 0.5, y - step + 0.1, z - up * hs * 0.75), V(x - face * hs * 0.5, y + 0.05, z + up * hs * 0.75), 0.9, 0.08, C.steelLight);
    // swing arm toward the craft with a folding tip
    if (i % 2 === 0 || step > 5.5) {
      const ax = x + face * (hs + armLen / 2);
      b.box('paint', armLen, 0.14, 1.5, ax, y, z, C.steelDark);
      addRailing(b, V(x + face * hs, y + 0.07, z - 0.75), V(x + face * (hs + armLen), y + 0.07, z - 0.75));
      addRailing(b, V(x + face * hs, y + 0.07, z + 0.75), V(x + face * (hs + armLen), y + 0.07, z + 0.75));
      b.beam('steel', V(x + face * hs, y - 1.6, z), V(x + face * (hs + armLen * 0.8), y - 0.1, z), 0.1, 0.1, C.steel);
      b.box('paint', 0.5, 0.06, 1.5, x + face * (hs + armLen + 0.22), y + 0.2, z, C.amber, 0, 0, face * 0.6);
    }
  }
  b.box('paint', s + 1, 0.3, s + 1, x, 0.15, z, C.steelDark);
  b.box('emit', 0.5, 0.5, 0.06, x + face * (hs + 0.05), 2.2, z - hs + 0.6, 0x39d0c0, Math.PI / 2);
}

const PIP_FEET = 0.45;
function pipAt(group, meshApi, x, z, ry, y = 0) {
  if (!meshApi || typeof meshApi.buildPipMesh !== 'function') return null;
  try {
    const p = meshApi.buildPipMesh();
    p.position.set(x, y + PIP_FEET, z); p.rotation.y = ry;
    if (y < 0.5) gnd(x, z, 1.25, 1.25, 0, 0.85);
    p.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    p.userData.foreign = true;
    group.add(p); return p;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------- the halls
export function buildHall(renderer, { site = 'pad', meshApi = null, quality = 'high' } = {}) {
  // quality 'low' (software rendering, weak GPUs): diffuse-only hall materials and a small, hard-edged shadow map.
  // Per-pixel PBR over a whole interior is ten times slower without a GPU; the craft itself keeps its full materials.
  const low = quality === 'low';
  ANISO_CAP = low ? 1 : 16;
  const std = params => {
    if (!low) return new THREE.MeshStandardMaterial(params);
    const { roughness, metalness, roughnessMap, envMapIntensity, bumpMap, bumpScale, ...rest } = params;
    if (rest.map && rest.vertexColors) delete rest.map;        // the grime overlay on vertex-coloured steelwork: a texture fetch per pixel for little
    const m = new THREE.MeshLambertMaterial(rest);
    if (metalness > 0.4 && m.color && !rest.vertexColors) m.color.multiplyScalar(0.8);
    return m;
  };
  const plane = site === 'runway';
  GROUND = [];
  const S = plane ? { w: 150, d: 104, h: 30, eave: 17 } : { w: 88, d: 112, h: 76, eave: 76 };
  const door = plane ? { w: 112, h: 15.5 } : { w: 30, h: 64 };
  const group = new THREE.Group(); group.name = plane ? 'spaceplane_hangar' : 'assembly_hall';
  const owned = [];                                   // textures / materials / geometries to dispose
  const keep = o => { owned.push(o); return o; };
  const aniso = low ? 1 : Math.min(16, renderer ? renderer.capabilities.getMaxAnisotropy() : 4);
  const b = makeBatch();
  const r = rng(plane ? 404 : 303);
  const hw = S.w / 2, hd = S.d / 2;

  // ---- materials
  const grime = keep(grimeTexture()); grime.anisotropy = aniso;
  const mats = {
    paint: keep(std({ map: grime, vertexColors: true, roughness: 0.62, metalness: 0.18 })),
    steel: keep(std({ map: grime, vertexColors: true, roughness: 0.5, metalness: 0.6 })),
    rubber: keep(std({ vertexColors: true, roughness: 0.92, metalness: 0 })),
    glass: keep(std({ vertexColors: true, roughness: 0.12, metalness: 0.7 })),
    emit: keep(new THREE.MeshBasicMaterial({ vertexColors: true })),
  };

  // ---- floor
  const span = Math.max(S.w, S.d) + 8;
  const floorTex = keep(floorTexture(span, (c, ppm, cx, cy) => {
    const line = (x0, y0, x1, y1, col, wd, dash) => { c.strokeStyle = col; c.lineWidth = wd * ppm; c.setLineDash(dash ? dash.map(v => v * ppm) : []); c.beginPath(); c.moveTo(cx + x0 * ppm, cy + y0 * ppm); c.lineTo(cx + x1 * ppm, cy + y1 * ppm); c.stroke(); c.setLineDash([]); };
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (!plane) {
      // the assembly bay: dark sealed disc, hazard ring, degree ticks, crosshair
      c.fillStyle = 'rgba(38,44,52,0.85)'; c.beginPath(); c.arc(cx, cy, 13 * ppm, 0, 7); c.fill();
      c.save(); c.beginPath(); c.arc(cx, cy, 13 * ppm, 0, 7); c.arc(cx, cy, 11.8 * ppm, 0, 7, true); c.clip();
      hazardBand(c, cx - 13 * ppm, cy - 13 * ppm, 26 * ppm, 26 * ppm, 1.2 * ppm); c.restore();
      c.strokeStyle = '#39d0c0'; c.lineWidth = 0.22 * ppm; c.beginPath(); c.arc(cx, cy, 7.5 * ppm, 0, 7); c.stroke();
      c.strokeStyle = 'rgba(232,238,244,0.7)'; c.lineWidth = 0.1 * ppm; c.beginPath(); c.arc(cx, cy, 3.2 * ppm, 0, 7); c.stroke();
      for (let k = 0; k < 24; k++) {
        const a = k * Math.PI / 12, long = k % 6 === 0;
        c.strokeStyle = long ? '#e0a236' : 'rgba(57,208,192,0.85)'; c.lineWidth = (long ? 0.24 : 0.12) * ppm;
        c.beginPath(); c.moveTo(cx + Math.cos(a) * (long ? 5.6 : 6.7) * ppm, cy + Math.sin(a) * (long ? 5.6 : 6.7) * ppm); c.lineTo(cx + Math.cos(a) * 7.5 * ppm, cy + Math.sin(a) * 7.5 * ppm); c.stroke();
      }
      line(-2.4, 0, 2.4, 0, 'rgba(232,238,244,0.6)', 0.08); line(0, -2.4, 0, 2.4, 'rgba(232,238,244,0.6)', 0.08);
      // roll-out lane to the doors (−Z is up on the canvas)
      c.fillStyle = 'rgba(40,46,54,0.6)'; c.fillRect(cx - 9 * ppm, 0, 18 * ppm, cy - 13.4 * ppm);
      for (const sx of [-9, 9]) line(sx, -13.6, sx, -hd, '#e0a236', 0.3);
      line(0, -14.5, 0, -hd, 'rgba(232,238,244,0.7)', 0.22, [2.4, 1.6]);
      for (const rail of [-3.6, 3.6]) { line(rail, -13, rail, -hd, 'rgba(20,22,26,0.9)', 0.42); line(rail, -13, rail, -hd, 'rgba(150,158,166,0.9)', 0.12); }
      hazardBand(c, cx - 15 * ppm, cy - (hd - 0.2) * ppm, 30 * ppm, 1.6 * ppm, 1.1 * ppm);
      c.fillStyle = 'rgba(232,238,244,0.72)'; c.font = `800 ${Math.round(3.2 * ppm)}px ${FONT}`; c.fillText('BAY 1', cx, cy + 17 * ppm);
      c.fillStyle = 'rgba(57,208,192,0.78)'; c.font = `700 ${Math.round(1.15 * ppm)}px ${FONT}`; c.fillText('STARWRIGHT  ·  VEHICLE ASSEMBLY', cx, cy + 20 * ppm);
      // walkways and parking boxes
      for (const sx of [-1, 1]) { line(sx * 22, -44, sx * 22, 46, 'rgba(116,221,146,0.6)', 0.18); line(sx * 24.4, -44, sx * 24.4, 46, 'rgba(116,221,146,0.6)', 0.18); }
      c.strokeStyle = 'rgba(224,162,54,0.85)'; c.lineWidth = 0.18 * ppm;
      for (const [x, y, w2, h2] of [[26, 8, 10, 7], [26, 18, 10, 7], [-36, 10, 9, 12], [26, -30, 10, 8], [-36, -26, 9, 9]]) c.strokeRect(cx + x * ppm, cy + y * ppm, w2 * ppm, h2 * ppm);
    } else {
      // taxi centreline out of the door, nose-wheel T, wing-span arcs, a length scale beside the centreline
      line(0, 30, 0, -hd, '#e0a236', 0.3);
      line(-1.2, 30, 1.2, 30, '#e0a236', 0.3);
      for (const sx of [-1, 1]) line(sx * 0.45, 30, sx * 0.45, -hd, 'rgba(20,22,26,0.7)', 0.08);
      c.strokeStyle = 'rgba(232,238,244,0.5)'; c.lineWidth = 0.14 * ppm; c.setLineDash([1.2 * ppm, 0.9 * ppm]);
      for (const rad of [10, 20, 30]) { c.beginPath(); c.arc(cx, cy, rad * ppm, Math.PI * 0.08, Math.PI * 0.92); c.stroke(); c.beginPath(); c.arc(cx, cy, rad * ppm, Math.PI * 1.08, Math.PI * 1.92); c.stroke(); }
      c.setLineDash([]);
      for (let m = -30; m <= 30; m++) {
        const five = m % 5 === 0;
        line(3.2, m, 3.2 + (five ? 1.3 : 0.6), m, five ? '#e0a236' : 'rgba(232,238,244,0.6)', five ? 0.12 : 0.06);
        if (five && m !== 0) { c.fillStyle = 'rgba(224,162,54,0.9)'; c.font = `800 ${Math.round(1.1 * ppm)}px ${FONT}`; c.fillText(String(Math.abs(m)), cx + 5.6 * ppm, cy + m * ppm); }
      }
      c.strokeStyle = '#39d0c0'; c.lineWidth = 0.2 * ppm; c.strokeRect(cx - 34 * ppm, cy - 26 * ppm, 68 * ppm, 58 * ppm);
      hazardBand(c, cx - 58 * ppm, cy - (hd - 0.2) * ppm, 116 * ppm, 1.4 * ppm, 1.1 * ppm);
      c.fillStyle = 'rgba(232,238,244,0.72)'; c.font = `800 ${Math.round(3.0 * ppm)}px ${FONT}`; c.fillText('HANGAR 2', cx - 22 * ppm, cy + 38 * ppm);
      c.fillStyle = 'rgba(57,208,192,0.78)'; c.font = `700 ${Math.round(1.1 * ppm)}px ${FONT}`; c.fillText('STARWRIGHT  ·  SPACEPLANE WORKS', cx - 22 * ppm, cy + 41 * ppm);
      for (const sx of [-1, 1]) { line(sx * 40, -40, sx * 40, 44, 'rgba(116,221,146,0.6)', 0.18); line(sx * 42.4, -40, sx * 42.4, 44, 'rgba(116,221,146,0.6)', 0.18); }
      c.strokeStyle = 'rgba(224,162,54,0.85)'; c.lineWidth = 0.18 * ppm;
      for (const [x, y, w2, h2] of [[46, 6, 12, 8], [46, 18, 12, 8], [-60, 0, 12, 14], [46, -30, 12, 9], [-60, -30, 12, 10]]) c.strokeRect(cx + x * ppm, cy + y * ppm, w2 * ppm, h2 * ppm);
    }
  }));
  floorTex.anisotropy = aniso;
  const detail = keep(concreteDetail());
  const floorMat = keep(std({ map: floorTex, roughnessMap: detail, bumpMap: detail, bumpScale: 0.6, roughness: 0.62, metalness: 0.0, envMapIntensity: 0.9 }));
  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(span, span)), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.name = 'hall_floor'; group.add(floor);

  // ---- outside: backdrop, apron, daylight
  const backTex = keep(backdropTexture(site));
  const back = new THREE.Mesh(keep(new THREE.PlaneGeometry(plane ? 520 : 300, plane ? 180 : 190)), keep(new THREE.MeshBasicMaterial({ map: backTex, fog: false, toneMapped: false })));
  back.position.set(0, plane ? 28 : 46, -hd - 120); group.add(back);
  const apron = new THREE.Mesh(keep(new THREE.PlaneGeometry(plane ? 520 : 300, 130)), keep(new THREE.MeshBasicMaterial({ color: 0xb4b3a8, fog: false })));
  apron.rotation.x = -Math.PI / 2; apron.position.set(0, -0.02, -hd - 65); group.add(apron);

  // ---- walls
  const wallTex = keep(wallTexture(plane ? '#56626e' : '#4e5a66')); wallTex.anisotropy = aniso;
  const wallMat = (rw, rh) => { const t = keep(wallTex.clone()); t.needsUpdate = true; t.repeat.set(rw / 8, rh / 8); return keep(std({ map: t, roughness: 0.8, metalness: 0.25 })); };
  const wall = (w, h, x, y, z, ry) => { const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, h)), wallMat(w, h)); m.position.set(x, y, z); m.rotation.y = ry; m.receiveShadow = true; group.add(m); return m; };
  const wallH = S.eave;
  wall(S.w, wallH, 0, wallH / 2, hd, Math.PI);
  wall(S.d, wallH, -hw, wallH / 2, 0, Math.PI / 2);
  wall(S.d, wallH, hw, wallH / 2, 0, -Math.PI / 2);
  const sideW = (S.w - door.w) / 2;
  wall(sideW, wallH, -hw + sideW / 2, wallH / 2, -hd, 0);
  wall(sideW, wallH, hw - sideW / 2, wallH / 2, -hd, 0);
  if (wallH - door.h > 0.5) wall(door.w, wallH - door.h, 0, door.h + (wallH - door.h) / 2, -hd, 0);
  // door frame, tracks and the slid-open leaves
  b.box('paint', 1.4, door.h + 1.4, 1.6, -door.w / 2 - 0.7, (door.h + 1.4) / 2, -hd + 0.4, C.amber);
  b.box('paint', 1.4, door.h + 1.4, 1.6, door.w / 2 + 0.7, (door.h + 1.4) / 2, -hd + 0.4, C.amber);
  b.box('paint', door.w + 4.2, 1.6, 1.8, 0, door.h + 0.8, -hd + 0.4, C.amber);
  for (let k = 0; k < Math.floor(door.w / 6); k++) b.box('emit', 0.5, 0.25, 0.1, -door.w / 2 + 3 + k * 6, door.h + 0.8, -hd + 1.32, k % 2 ? 0xff5a4a : 0xffd27a);
  const leafW = Math.min(sideW - 1, door.w / 2), leafN = plane ? 2 : 1;
  for (const sx of [-1, 1]) for (let k = 0; k < leafN; k++) {
    const lx = sx * (door.w / 2 + 1.4 + leafW / 2 - k * 1.5), lz = -hd + 1.5 + k * 0.7;
    b.box('paint', leafW, door.h, 0.5, lx, door.h / 2, lz, 0x5d6b78);
    for (let y = 2; y < door.h; y += plane ? 3.8 : 5) b.box('steel', leafW, 0.3, 0.62, lx, y, lz, C.steelDark);
    b.box('paint', leafW, 1.1, 0.56, lx, 1.1, lz, C.amber);
  }

  // ---- structure: columns, girts, roof
  const colStep = plane ? 12.5 : 11.2;
  for (let z = -hd + 2; z <= hd - 1; z += colStep) for (const sx of [-1, 1]) {
    b.box('steel', 1.0, wallH, 1.3, sx * (hw - 0.55), wallH / 2, z, C.steel);
    b.box('steel', 1.5, wallH, 0.14, sx * (hw - 0.55), wallH / 2, z - 0.65, C.steelDark);
    b.box('steel', 1.5, wallH, 0.14, sx * (hw - 0.55), wallH / 2, z + 0.65, C.steelDark);
    b.box('paint', 1.1, 1.4, 1.34, sx * (hw - 0.55), 0.7, z, C.amber);
  }
  for (let x = -hw + 8; x <= hw - 8; x += colStep) b.box('steel', 1.2, wallH, 1.0, x, wallH / 2, hd - 0.55, C.steel);
  const roofMat = keep(std({ color: 0x2a323c, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide }));
  const lampSpots = [];
  if (!plane) {
    const roof = new THREE.Mesh(keep(new THREE.PlaneGeometry(S.w, S.d)), roofMat); roof.rotation.x = Math.PI / 2; roof.position.y = S.h; group.add(roof);
    for (let z = -hd + 5.6; z < hd; z += colStep) {
      addTruss(b, V(-hw + 1, S.h - 5.2, z), V(hw - 1, S.h - 5.2, z), 4.6, C.steel, 14, 0.42);
      for (const x of [-24, -8, 8, 24]) lampSpots.push([x, S.h - 9.5, z]);
    }
    for (const x of [-30, -15, 0, 15, 30]) b.box('steel', 0.3, 0.4, S.d - 2, x, S.h - 0.8, 0, C.steelDark);
    for (let z = -hd + 11.2; z < hd - 6; z += colStep * 2) b.box('emit', S.w * 0.62, 0.1, 3.0, 0, S.h - 0.12, z, 0xcfe6ff);   // skylights
    // clerestory windows and girts on the side walls
    for (const sx of [-1, 1]) {
      for (let y = 8; y < wallH - 4; y += 8) b.box('steel', 0.3, 0.5, S.d - 2, sx * (hw - 0.2), y, 0, C.steelDark);
      for (let z = -hd + 7.6; z < hd - 5; z += colStep) b.box('emit', 0.12, 5.2, 7.2, sx * (hw - 0.08), wallH - 9, z, 0xbcd9f5);
    }
  } else {
    // arched roof: ribs from the eaves to the crown, purlins, a ridge skylight
    const arcY = x => S.eave + (S.h - S.eave) * Math.cos(x / hw * Math.PI / 2);
    const N = 20;
    for (let z = -hd + 0.6; z <= hd; z += colStep / 2) {
      const full = Math.abs(Math.round((z + hd - 0.6) / (colStep / 2))) % 2 === 0;
      for (let i = 0; i < N; i++) {
        const x0 = -hw + i * S.w / N, x1 = x0 + S.w / N;
        b.beam('steel', V(x0, arcY(x0) - 0.4, z), V(x1, arcY(x1) - 0.4, z), full ? 0.7 : 0.3, full ? 0.4 : 0.25, C.steel);
        if (full && i % 2 === 0) b.beam('steel', V(x0, arcY(x0) - 0.4, z), V(x1, arcY(x1) - 2.6, z), 0.16, 0.16, C.steel);
        if (full && i % 2 === 1) b.beam('steel', V(x0, arcY(x0) - 2.6, z), V(x1, arcY(x1) - 0.4, z), 0.16, 0.16, C.steel);
        if (full) b.beam('steel', V(x0, arcY(x0) - 2.6, z), V(x1, arcY(x1) - 2.6, z), 0.22, 0.22, C.steel);
      }
      if (full) for (const x of [-48, -24, 0, 24, 48]) lampSpots.push([x, arcY(x) - 5.2, z]);
    }
    const shape = [];
    for (let i = 0; i <= N; i++) { const x = -hw + i * S.w / N; shape.push(x, arcY(x)); }
    const pos = [], idx = [], uvs = [];
    for (let i = 0; i <= N; i++) { pos.push(shape[i * 2], shape[i * 2 + 1], -hd, shape[i * 2], shape[i * 2 + 1], hd); uvs.push(i / N, 0, i / N, 1); }
    for (let i = 0; i < N; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    const rg = keep(new THREE.BufferGeometry()); rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); rg.setIndex(idx); rg.computeVertexNormals();
    group.add(new THREE.Mesh(rg, roofMat));
    // gable ends above the eaves
    for (const z of [-hd, hd]) {
      const gp = [], gi = [];
      for (let i = 0; i <= N; i++) { const x = -hw + i * S.w / N; gp.push(x, S.eave, z, x, arcY(x), z); }
      for (let i = 0; i < N; i++) gi.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      const gg = keep(new THREE.BufferGeometry()); gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)); gg.setIndex(gi); gg.computeVertexNormals();
      group.add(new THREE.Mesh(gg, keep(std({ color: 0x46525e, roughness: 0.85, metalness: 0.2, side: THREE.DoubleSide }))));
    }
    for (let z = -hd + 9; z < hd - 6; z += colStep) b.box('emit', 9, 0.1, 5.5, 0, S.h - 0.5, z, 0xcfe6ff);
    for (const sx of [-1, 1]) for (let z = -hd + 7; z < hd - 5; z += colStep) b.box('emit', 0.12, 3.0, 7.5, sx * (hw - 0.08), S.eave - 3.2, z, 0xbcd9f5);
  }

  // ---- catwalks along the side walls and across the back
  const cwLevels = plane ? [9] : [14, 28, 42, 56];
  for (const y of cwLevels) {
    for (const sx of [-1, 1]) {
      const x = sx * (hw - 2.2);
      b.box('paint', 2.6, 0.16, S.d - 6, x, y, 0, C.steelDark);
      addRailing(b, V(x - sx * 1.3, y + 0.08, -hd + 3), V(x - sx * 1.3, y + 0.08, hd - 3));
      for (let z = -hd + 2; z <= hd - 1; z += colStep) b.beam('steel', V(sx * (hw - 1), y - 2.4, z), V(x - sx * 1.2, y - 0.1, z), 0.14, 0.14, C.steel);
    }
    b.box('paint', S.w - 6, 0.16, 2.6, 0, y, hd - 2.2, C.steelDark);
    addRailing(b, V(-hw + 3, y + 0.08, hd - 3.5), V(hw - 3, y + 0.08, hd - 3.5));
  }
  // cable trays and pipes along the walls
  for (const sx of [-1, 1]) {
    b.box('steel', 0.5, 0.12, S.d - 4, sx * (hw - 1.4), 5.2, 0, C.steelLight);
    b.cyl('paint', 0.16, S.d - 4, sx * (hw - 0.9), 3.6, 0, C.teal, { rx: Math.PI / 2, seg: 8 });
    b.cyl('paint', 0.12, S.d - 4, sx * (hw - 0.9), 4.1, 0, C.red, { rx: Math.PI / 2, seg: 8 });
  }

  // ---- the height scale
  const rulerLen = plane ? 20 : 65;
  const rulerTex = keep(rulerTexture(rulerLen)); rulerTex.anisotropy = aniso;
  const rulerMat = keep(std({ map: rulerTex, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide }));
  const mast = new THREE.Group(); mast.name = 'height_mast';
  const mw = plane ? 0.7 : 1.1;
  for (const ry of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const f = new THREE.Mesh(keep(new THREE.PlaneGeometry(mw, rulerLen)), rulerMat);
    f.position.set(Math.sin(ry) * mw / 2, rulerLen / 2, Math.cos(ry) * mw / 2); f.rotation.y = ry; f.castShadow = true; mast.add(f);
  }
  mast.position.set(plane ? -24 : -19, 0, plane ? 2 : -14); mast.rotation.y = 0.5; group.add(mast);
  b.box('paint', mw + 1.4, 0.3, mw + 1.4, mast.position.x, 0.15, mast.position.z, C.steelDark, 0.5);
  b.box('emit', mw * 0.7, 0.12, mw * 0.7, mast.position.x, rulerLen + 0.06, mast.position.z, 0xff5a4a, 0.5);

  // ---- service structures
  let crane = null;
  if (!plane) {
    addTower(b, -15.5, 3, 6.5, 6, 10, 1, 4.2);
    addTower(b, 16, -6, 6.5, 6, 9, -1, 4.2);
    // umbilical mast with hose loops
    // (behind the craft as seen from the default camera, so it never stands in front of the work)
    b.box('steel', 0.7, 44, 0.7, 11, 22, -9.5, C.steelDark);
    for (let y = 8; y <= 40; y += 8) { b.box('paint', 2.6, 0.2, 0.5, 9.7, y, -9.5, C.amber); b.cyl('rubber', 0.09, 2.2, 8.5, y - 1.1, -9.5, C.rubber, { seg: 6 }); }
  } else {
    // low work stands and mobile stairs beside the centreline
    for (const [x, z, ry, n] of [[-17, -8, 0.0, 3], [17, 6, Math.PI, 3]]) {
      const sgn = Math.cos(ry);
      b.box('paint', 5.5, 0.14, 2.4, x, 2.6, z, C.steelDark);
      for (const [dx, dz] of [[-2.6, -1.1], [2.6, -1.1], [-2.6, 1.1], [2.6, 1.1]]) b.box('steel', 0.14, 2.6, 0.14, x + dx, 1.3, z + dz, C.steel);
      addRailing(b, V(x - 2.75, 2.67, z - 1.2), V(x + 2.75, 2.67, z - 1.2)); addRailing(b, V(x - sgn * 2.75, 2.67, z - 1.2), V(x - sgn * 2.75, 2.67, z + 1.2));
      b.beam('paint', V(x - sgn * 2.7, 2.6, z + 1.7), V(x - sgn * 7, 0.1, z + 1.7), 0.08, 1.0, C.steelLight);
      for (let k = 0; k < n; k++) b.beam('steel', V(x - 2.6 + k * 2.6, 0.1, z - 1.1), V(x - 2.6 + k * 2.6 + 1.4, 2.5, z - 1.1), 0.08, 0.08, C.steel);
    }
    // tripod jacks for the wings and tail
    for (const [x, z] of [[-9, 4], [9, 4], [-6, -9], [6, -9], [0, 14]]) {
      b.cyl('steel', 0.09, 1.5, x, 0.85, z, C.steelLight, { seg: 8 }); b.cyl('paint', 0.2, 0.9, x, 0.5, z, C.red, { seg: 10 });
      for (let k = 0; k < 3; k++) { const a = k * 2.094; b.beam('paint', V(x, 0.9, z), V(x + Math.cos(a) * 0.8, 0.03, z + Math.sin(a) * 0.8), 0.07, 0.07, C.red); }
      b.box('rubber', 0.3, 0.06, 0.3, x, 1.62, z, C.rubber);
    }
    // mezzanine offices along the back wall
    b.box('paint', 70, 0.3, 9, 0, 6, hd - 5, C.steelDark);
    b.box('paint', 70, 5.5, 0.3, 0, 9, hd - 9.3, 0x56636f);
    for (let x = -32; x <= 32; x += 8) { b.box('emit', 5.6, 2.2, 0.1, x, 9.3, hd - 9.48, x % 16 ? 0xfff0c8 : 0xcde8ff); b.box('steel', 0.4, 6, 0.4, x + 4, 3, hd - 9.2, C.steel); }
    addRailing(b, V(-35, 6.15, hd - 9.6), V(35, 6.15, hd - 9.6));
  }
  // bridge crane (the hook is animated)
  const craneY = plane ? S.eave - 1.2 : S.h - 13;
  for (const sx of [-1, 1]) {
    b.box('steel', 1.0, 1.1, S.d - 4, sx * (hw - 2.2), craneY, 0, C.steelDark);
    for (let z = -hd + 2; z <= hd - 1; z += colStep) b.box('steel', 2.0, 0.9, 1.2, sx * (hw - 1.4), craneY - 1, z, C.steel);
  }
  crane = new THREE.Group(); crane.name = 'bridge_crane';
  {
    const cb = makeBatch(), span2 = S.w - 4.4;
    for (const dz of [-1.3, 1.3]) cb.box('paint', span2, 1.8, 0.8, 0, 0.4, dz, C.amber);
    for (const sx of [-1, 1]) cb.box('paint', 1.6, 2.0, 4.4, sx * (span2 / 2 - 0.6), 0.2, 0, C.steelDark);
    for (let x = -span2 / 2 + 4; x < span2 / 2; x += 8) cb.box('paint', 0.5, 0.5, 0.1, x, 0.4, 1.72, C.dark);
    cb.build(mats, crane);
  }
  crane.position.set(0, craneY + 1.4, 0); group.add(crane);
  const trolley = new THREE.Group();
  {
    const tb = makeBatch();
    tb.box('paint', 3.2, 1.3, 3.6, 0, 1.6, 0, C.steelDark); tb.box('paint', 2.2, 0.9, 2.2, 0, 2.6, 0, C.teal);
    tb.cyl('steel', 0.7, 2.4, 0, 0.7, 0, C.steelLight, { rz: Math.PI / 2, seg: 16 });
    tb.build(mats, trolley);
  }
  crane.add(trolley);
  const cableMat = keep(std({ color: 0x2a2f36, roughness: 0.5, metalness: 0.7 }));
  const cable = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.05, 0.05, 1, 6)), cableMat); cable.castShadow = true; trolley.add(cable);
  const hook = new THREE.Group();
  {
    const hb = makeBatch();
    hb.box('paint', 1.1, 0.9, 0.5, 0, 0.45, 0, C.amber); hb.cyl('steel', 0.32, 0.56, 0, 0.5, 0, C.steelLight, { rx: Math.PI / 2, seg: 14 });
    hb.cyl('steel', 0.09, 0.7, 0, -0.3, 0, C.steelDark, { seg: 8 });
    hb.geo('steel', new THREE.TorusGeometry(0.3, 0.085, 8, 16, Math.PI * 1.4), new THREE.Matrix4().compose(V(0, -0.9, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -2.2)), V(1, 1, 1)), C.steelDark);
    hb.build(mats, hook);
  }
  trolley.add(hook);

  // ---- floor clutter
  const pips = [];
  if (!plane) {
    addToolChest(b, 9.5, 7.5, -0.6); addToolChest(b, -9, 9.5, 0.5, C.blue); addToolChest(b, 11.5, -9.5, 2.2);
    addCrateStack(b, 30, 11, r, 3); addCrateStack(b, 32.2, 12.8, r, 2); addCrateStack(b, 30.4, 21, r, 4); addCrateStack(b, -32, 14, r, 3); addCrateStack(b, -33.5, 17.5, r, 2); addCrateStack(b, 31, -26, r, 3);
    addDrums(b, -33, -22, r, 6); addDrums(b, 28.5, -31, r, 4); addDrums(b, -30.5, 20.5, r, 3);
    addTug(b, 22, 16, -2.3); addTug(b, -24, -12, 0.5, C.teal);
    addScissorLift(b, -10.5, -10, 0.9, 4.6); addScissorLift(b, 12.5, 12.5, -0.4, 2.2);
    addDolly(b, 27, 0, 1.45, 7.5, 0.95); addDolly(b, -27, 2, 1.62, 5, 0.7, 0xd9dee2); addDolly(b, -30, -34, 0.2, 9, 1.3);
    addDesk(b, 7, 16.5, Math.PI); addDesk(b, -19, 22, 2.4);
    for (const [x, z] of [[10.8, 3.5], [-11, 2.4], [7.5, -10.8], [-7.5, 11], [3, 12.6], [-3.5, -12.8], [12.2, -4.5], [9.8, -15], [-9.8, -15], [9.8, -28], [-9.8, -28]]) addCone(b, x, z);
    for (const [x, z, ry, y] of [[8.2, 15.2, 0.2, 0], [5.2, 8.6, -2.2, 0], [-8.4, 7.9, 2.4, 0], [21.5, 13.6, 1.0, 0], [-12.4, 3.4, 1.6, 12.08], [13.2, -5.4, -1.5, 18.08], [-26.5, 5.5, -0.6, 0]]) pips.push(pipAt(group, meshApi, x, z, ry, y));
  } else {
    addToolChest(b, 12, 10, -0.5); addToolChest(b, -12.5, 2, 0.6, C.blue); addToolChest(b, 10.5, -11, 2.4); addToolChest(b, -10, -14, 0.9);
    addCrateStack(b, 50, 9, r, 3); addCrateStack(b, 53, 11.5, r, 2); addCrateStack(b, 51, 21, r, 3); addCrateStack(b, -54, 5, r, 3); addCrateStack(b, -56, 9.5, r, 2); addCrateStack(b, 50, -26, r, 3);
    addDrums(b, -56, -26, r, 6); addDrums(b, 48, -34, r, 4);
    addTug(b, 24, 18, -2.6); addTug(b, -30, -16, 0.4, C.teal); addTug(b, 4, -34, Math.PI / 2, C.white);
    addScissorLift(b, -20, 12, 0.3, 2.6);
    addDolly(b, 50, 0, 1.5, 6, 0.9); addDolly(b, -52, -8, 1.62, 5, 0.7, 0xd9dee2); addDolly(b, -30, 30, 0.1, 8, 1.1);
    addDesk(b, 16, 24, Math.PI); addDesk(b, -24, 26, 2.6);
    for (const [x, z] of [[14, 3], [-14, -3], [8, -16], [-8, 16], [16, -10], [-16, 10], [5, 26], [-5, 26], [20, -30], [-20, -30]]) addCone(b, x, z);
    for (const [x, z, ry, y] of [[17, 22.5, 0.3, 0], [9.5, 9, -2.2, 0], [-13.5, 4, 2.2, 0], [22.6, 16, 1.2, 0], [-17, -8, 1.6, 2.67], [-26, 23.6, -0.7, 0]]) pips.push(pipAt(group, meshApi, x, z, ry, y));
  }
  // wall cabinets, extinguishers, lit signs
  for (let z = -hd + 2 + colStep; z < hd - 4; z += colStep * 2) for (const sx of [-1, 1]) {
    b.box('paint', 0.3, 0.9, 0.5, sx * (hw - 1.3), 1.5, z + 0.95, C.red);
    b.box('paint', 0.5, 2.0, 1.4, sx * (hw - 1.4), 1.0, z - 2.2, C.steelLight);
    b.box('emit', 0.06, 0.5, 1.0, sx * (hw - 1.14), 3.3, z, 0x74dd92);
  }
  const signs = [
    [plane ? ['HANGAR 2', 'SPACEPLANE WORKS'] : ['BAY 1', 'VEHICLE ASSEMBLY'], 0, plane ? 13 : 20, hd - 1.2, Math.PI, plane ? 22 : 26],
    [['HARD HATS', 'BEYOND THIS LINE'], -hw + 1.25, 7, plane ? 10 : 18, Math.PI / 2, 9, '#e0a236'],
    [['MIND THE HOOK', 'CRANE OVERHEAD'], hw - 1.25, 7, plane ? -8 : -14, -Math.PI / 2, 9, '#e0a236'],
  ];
  for (const [lines, x, y, z, ry, w, accent] of signs) {
    const t = keep(signTexture(lines, accent ? { accent, fg: '#e8eef4' } : {})); t.anisotropy = aniso;
    const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, w * 160 / 512)), keep(std({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.35, roughness: 0.6 })));
    m.position.set(x, y, z); m.rotation.y = ry; group.add(m);
  }

  // ---- build the merged static meshes
  b.build(mats, group, { emit: { cast: false, receive: false }, glass: { cast: false } });

  // ---- hanging lamps (instanced): shade, lens, glow card, light cone
  const lampN = lampSpots.length;
  const shadeGeo = keep(new THREE.CylinderGeometry(0.35, 0.95, 0.8, 14, 1, true));
  const shade = new THREE.InstancedMesh(shadeGeo, keep(std({ color: 0x20262d, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })), lampN);
  const lens = new THREE.InstancedMesh(keep(new THREE.CircleGeometry(0.86, 16)), keep(new THREE.MeshBasicMaterial({ color: 0xfff3d6, toneMapped: false })), lampN);
  const rod = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.035, 0.035, 1, 5)), mats.steel, lampN);
  const glowTex = keep(glowTexture());
  const coneGeo = keep(new THREE.CylinderGeometry(0.7, plane ? 6 : 9, 1, 20, 1, true));
  const coneTex = keep(shaftTexture());
  const cone = new THREE.InstancedMesh(coneGeo, keep(new THREE.MeshBasicMaterial({ map: coneTex, color: 0xffe9c4, transparent: true, opacity: plane ? 0.05 : 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })), lampN);
  const glows = [], pools = [];        // [x, y, z, size, r, g, b, gain] billboards; lamp pools on the floor
  const m4 = new THREE.Matrix4(), qd = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), one = V(1, 1, 1);
  const coneLen = plane ? 12 : 26;
  lampSpots.forEach(([x, y, z], i) => {
    shade.setMatrixAt(i, m4.makeTranslation(x, y, z));
    lens.setMatrixAt(i, m4.compose(V(x, y - 0.36, z), qd, one));
    rod.setMatrixAt(i, m4.compose(V(x, y + 0.4 + 2.2, z), new THREE.Quaternion(), V(1, 4.4, 1)));
    cone.setMatrixAt(i, m4.compose(V(x, y - 0.4 - coneLen / 2, z), new THREE.Quaternion(), V(1, coneLen, 1)));
    glows.push([x, y - 0.42, z, 2.6, 1.0, 0.86, 0.6, 1.5], [x, y - 0.5, z, plane ? 11 : 15, 1.0, 0.82, 0.52, 0.34]);
    pools.push([x, z]);
  });
  cone.renderOrder = 3;
  group.add(shade, lens, rod, cone);

  // ---- daylight through the door: floor pool and shafts
  const poolTex = keep(canvasTex(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,244,214,0.95)'); g.addColorStop(0.35, 'rgba(255,240,206,0.42)'); g.addColorStop(1, 'rgba(255,240,206,0)');
    c.fillStyle = g; c.beginPath(); c.moveTo(w * 0.18, 0); c.lineTo(w * 0.82, 0); c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fill();
    const s = c.createLinearGradient(0, 0, w, 0); s.addColorStop(0, 'rgba(0,0,0,1)'); s.addColorStop(0.22, 'rgba(0,0,0,0)'); s.addColorStop(0.78, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,1)');
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = s; c.fillRect(0, 0, w, h);
  }));
  const poolLen = plane ? 46 : 70;
  const pool = new THREE.Mesh(keep(new THREE.PlaneGeometry(door.w * 1.5, poolLen)), keep(new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: plane ? 0.3 : 0.34, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
  pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.03, -hd + poolLen / 2); pool.renderOrder = 1; group.add(pool);
  const shaftMat = keep(new THREE.MeshBasicMaterial({ map: coneTex, color: 0xfff1d0, transparent: true, opacity: plane ? 0.05 : 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  const shaftN = plane ? 7 : 5, shaftLen = plane ? 34 : 86;
  for (let i = 0; i < shaftN; i++) {
    const sw = door.w / shaftN * 1.5;
    const s = new THREE.Mesh(keep(new THREE.PlaneGeometry(sw, shaftLen)), shaftMat);
    const x = -door.w / 2 + (i + 0.5) * door.w / shaftN, tilt = plane ? 1.08 : 0.9;
    s.position.set(x * 1.06, door.h - Math.cos(tilt) * shaftLen / 2 - 0.5, -hd + Math.sin(tilt) * shaftLen / 2);
    s.rotation.set(-tilt, 0, 0, 'YXZ'); s.renderOrder = 4; group.add(s);
  }

  // ---- pools of lamplight on the floor (one instanced draw)
  {
    const pm = new THREE.InstancedMesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffe2b0, transparent: true, opacity: plane ? 0.16 : 0.12, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })), pools.length);
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    pools.forEach(([x, z], i) => pm.setMatrixAt(i, m4.compose(V(x, 0.035, z), flat, V(plane ? 20 : 26, plane ? 20 : 26, 1))));
    pm.renderOrder = 1; pm.name = 'lamp_pools'; group.add(pm);
  }

  // ---- grounding: a soft contact shade under everything on the floor, dark seams where floor meets wall and column
  const shadeTex = keep(shadeTexture());
  const shadeMat = keep(new THREE.MeshBasicMaterial({ map: shadeTex, color: 0x000000, transparent: true, opacity: 0.62, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  for (let z = -hd + 2; z <= hd - 1; z += colStep) for (const sx of [-1, 1]) gnd(sx * (hw - 0.6), z, 5.5, 5.5, 0, 0.9);
  gnd(mast.position.x, mast.position.z, 4.2, 4.2, 0, 0.9);
  {
    const sm = new THREE.InstancedMesh(keep(new THREE.PlaneGeometry(1, 1)), shadeMat, GROUND.length);
    const q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
    GROUND.forEach(([x, z, sx, sz, ry, a], i) => {
      q.setFromEuler(e.set(-Math.PI / 2, ry, 0, 'YXZ'));
      sm.setMatrixAt(i, m4.compose(V(x, 0.02, z), q, V(sx, sz, 1)));
    });
    sm.renderOrder = 2; sm.name = 'contact_shade'; group.add(sm);
  }
  // the craft's own occlusion patch: follows the work, widens with its footprint
  const craftShade = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.MeshBasicMaterial({ map: shadeTex, color: 0x000000, transparent: true, opacity: 0.0, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })));
  craftShade.rotation.x = -Math.PI / 2; craftShade.position.y = 0.025; craftShade.renderOrder = 2; craftShade.name = 'craft_shade'; group.add(craftShade);
  {
    // seams: floor strips along the four walls and wall strips above them, one mesh
    const sp = [], su = [], si = [];
    const quad = (a, b2, c2, d) => { const n = sp.length / 3; for (const v of [a, b2, c2, d]) sp.push(v.x, v.y, v.z); su.push(0, 0, 1, 0, 1, 1, 0, 1); si.push(n, n + 1, n + 2, n, n + 2, n + 3); };
    const fw = plane ? 7 : 8, wh = plane ? 5 : 9, e = 0.04;
    for (const sx of [-1, 1]) {
      const x = sx * (hw - e);
      quad(V(x, 0.03, -hd), V(x, 0.03, hd), V(x - sx * fw, 0.03, hd), V(x - sx * fw, 0.03, -hd));
      quad(V(x, 0, -hd), V(x, 0, hd), V(x, wh, hd), V(x, wh, -hd));
    }
    quad(V(-hw, 0.03, hd - e), V(hw, 0.03, hd - e), V(hw, 0.03, hd - fw), V(-hw, 0.03, hd - fw));
    quad(V(-hw, 0, hd - e), V(hw, 0, hd - e), V(hw, wh, hd - e), V(-hw, wh, hd - e));
    for (const sx of [-1, 1]) {
      const x0 = sx * door.w / 2, x1 = sx * hw;
      quad(V(x0, 0.03, -hd + e), V(x1, 0.03, -hd + e), V(x1, 0.03, -hd + fw), V(x0, 0.03, -hd + fw));
      quad(V(x0, 0, -hd + e), V(x1, 0, -hd + e), V(x1, wh, -hd + e), V(x0, wh, -hd + e));
    }
    const sg = keep(new THREE.BufferGeometry());
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2)); sg.setIndex(si);
    const seam = new THREE.Mesh(sg, keep(new THREE.MeshBasicMaterial({ map: keep(seamTexture()), color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
    seam.renderOrder = 1; seam.name = 'corner_shade'; group.add(seam);
  }

  // ---- warning beacons: on the crane bridge (they ride with it), over the door and on the tugs
  const beacons = [];                                  // { i: index into glows, phase, rate, crane: bool, z0 }
  const beacon = (x, y, z, phase, onCrane = false, rate = 1) => {
    beacons.push({ i: glows.length, phase, rate, crane: onCrane, z0: z, core: glows.length + 1 });
    glows.push([x, y, z, 5.5, 1.0, 0.56, 0.1, 1], [x, y, z, 1.1, 1.0, 0.7, 0.25, 1]);
  };
  {
    const bb = makeBatch(), span2 = S.w - 4.4;
    for (const sx of [-1, 1]) for (const dz of [-1.75, 1.75]) {
      bb.cyl('paint', 0.16, 0.12, sx * (span2 / 2 - 5), -0.56, dz, C.dark, { seg: 10 });
      bb.cyl('emit', 0.13, 0.26, sx * (span2 / 2 - 5), -0.74, dz, 0xffa531, { seg: 10 });
      beacon(sx * (span2 / 2 - 5), craneY + 1.4 - 0.76, dz, (sx > 0 ? 0 : 1.6) + (dz > 0 ? 0.8 : 0), true);
    }
    bb.build(mats, crane, { emit: { cast: false, receive: false } });
    const db = makeBatch();
    for (const sx of [-1, 1]) {
      const x = sx * (door.w / 2 + 0.7), y = door.h + 1.75, z = -hd + 1.5;
      db.cyl('paint', 0.2, 0.14, x, y - 0.08, z, C.dark, { seg: 10 }); db.cyl('emit', 0.16, 0.3, x, y + 0.14, z, 0xffa531, { seg: 10 });
      beacon(x, y + 0.14, z, sx > 0 ? 0.4 : 2.1, false, 0.8);
    }
    for (const [x, z, ph] of (plane ? [[24, 18, 0.2], [-30, -16, 1.9], [4, -34, 3.1]] : [[22, 16, 0.2], [-24, -12, 1.9]])) {
      db.cyl('paint', 0.03, 0.5, x, 1.75, z, C.dark, { seg: 6 }); db.cyl('emit', 0.1, 0.18, x, 2.08, z, 0xffa531, { seg: 8 });
      beacon(x, 2.08, z, ph, false, 1.25);
    }
    db.build(mats, group, { emit: { cast: false, receive: false } });
  }

  // ---- every glow in the hall (lamp bloom, beacons) as camera-facing instanced cards: one draw call
  const glowN = glows.length;
  const gOff = new Float32Array(glowN * 3), gTint = new Float32Array(glowN * 4);
  glows.forEach(([x, y, z, size, cr, cg, cb, gain], i) => { gOff.set([x, y, z], i * 3); gTint.set([cr * gain, cg * gain, cb * gain, size], i * 4); });
  const glowGeo = keep(new THREE.InstancedBufferGeometry());
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  glowGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  glowGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const offAttr = new THREE.InstancedBufferAttribute(gOff, 3), tintAttr = new THREE.InstancedBufferAttribute(gTint, 4);
  offAttr.setUsage(THREE.DynamicDrawUsage); tintAttr.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('aOffset', offAttr); glowGeo.setAttribute('aTint', tintAttr);
  glowGeo.instanceCount = glowN;
  const bloomTex = keep(bloomTexture());
  const glowCards = new THREE.Mesh(glowGeo, keep(new THREE.ShaderMaterial({
    uniforms: { map: { value: bloomTex } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aOffset; attribute vec4 aTint;
      varying vec2 vUv; varying vec3 vTint;
      void main() {
        vUv = uv; vTint = aTint.rgb;
        vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
        mv.xy += position.xy * aTint.w;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map;
      varying vec2 vUv; varying vec3 vTint;
      void main() {
        #include <logdepthbuf_fragment>
        float a = texture2D(map, vUv).a;
        gl_FragColor = vec4(vTint * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  })));
  glowCards.frustumCulled = false; glowCards.renderOrder = 5; glowCards.name = 'hall_glows'; group.add(glowCards);

  // ---- the floor crew: some stand at their posts, some walk a beat along the marked walkways
  const crew = pips.filter(Boolean).map((p, i) => ({ p, t: i * 1.7, path: null }));
  {
    const wx = plane ? 41.2 : 23.2;
    const beats = plane
      ? [[[wx, -36], [wx, 40], [wx - 14, 40], [wx - 14, 30], [wx, 30]], [[-wx, 38], [-wx, -34]], [[-30, 34], [30, 34]]]
      : [[[wx, -38], [wx, 40]], [[-wx, 42], [-wx, -30], [-wx + 6, -36], [-wx, -40]], [[-14, 30], [14, 30], [14, 36], [-14, 36]]];
    beats.forEach((pts, k) => {
      const p = pipAt(group, meshApi, pts[0][0], pts[0][1], 0, 0); if (!p) return;
      GROUND.pop();                                    // a walker carries its own shade
      const sh = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.25, 1.25)), shadeMat);
      sh.rotation.x = -Math.PI / 2; sh.position.y = -PIP_FEET + 0.022; sh.renderOrder = 2; p.add(sh);
      const closed = pts.length > 2;
      crew.push({ p, t: k * 2.3, path: { pts, closed, seg: 0, dir: 1, u: 0, speed: 1.0 + k * 0.12, wait: k * 1.5, yaw: 0 } });
    });
  }

  // ---- lights
  const hemi = new THREE.HemisphereLight(0xb9d0ea, 0x4a4238, plane ? 1.15 : 0.95); group.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xfff0d8, plane ? 2.3 : 2.5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
  const sc = keyLight.shadow.camera, ext = plane ? 46 : 38;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 2; sc.far = 260;
  keyLight.shadow.bias = -0.00035; keyLight.shadow.normalBias = 0.05; keyLight.shadow.radius = 4;
  const keyDir = plane ? V(0.42, 0.82, 0.38) : V(0.36, 0.84, 0.4);
  keyLight.position.copy(keyDir).multiplyScalar(120); group.add(keyLight, keyLight.target);
  const sun = new THREE.DirectionalLight(0xfff6e2, plane ? 1.5 : 1.25); sun.position.set(18, 26, -120); group.add(sun);   // daylight from the doors
  const bounce = new THREE.DirectionalLight(0x8fb7d6, 0.5); bounce.position.set(-60, 20, 40); group.add(bounce);

  // ---- small environment for reflections (bright door, skylights, lamps, grey floor)
  let envMap = null, envRT = null;
  if (renderer) {
    try {
      const es = new THREE.Scene();
      es.background = new THREE.Color(0x232b35);
      const quad = (w, h, col, x, y, z, rx, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); es.add(m); return m; };
      quad(60, 60, 0x565c63, 0, -6, 0, -Math.PI / 2, 0);                                       // floor
      const doorQ = quad(door.w * 0.5, Math.min(door.h, 30) * 0.9, 0xffffff, 0, 6, -30, 0, 0); doorQ.material.color.setRGB(5, 4.8, 4.4);
      const sky = quad(26, 5, 0xffffff, 0, 24, 0, Math.PI / 2, 0); sky.material.color.setRGB(2.6, 3.0, 3.4);
      for (const [x, z] of [[-12, -10], [12, -10], [-12, 10], [12, 10], [0, 18]]) { const l = quad(3, 3, 0xffffff, x, 22, z, Math.PI / 2, 0); l.material.color.setRGB(9, 8, 6.4); }
      quad(60, 30, 0x3b4651, 30, 8, 0, 0, Math.PI / 2); quad(60, 30, 0x3b4651, -30, 8, 0, 0, Math.PI / 2); quad(60, 30, 0x343e48, 0, 8, 30, 0, 0);
      const pm = new THREE.PMREMGenerator(renderer);
      envRT = pm.fromScene(es, 0.03, 0.1, 200);
      envMap = envRT.texture;
      pm.dispose();
      es.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    } catch (err) { console.warn('[hall] environment map unavailable:', err && err.message); }
  }

  const tmp = new THREE.Vector3();
  let hookY = craneY - 6, tX = 0, tZ = 0, clock = 0, shadeScale = 6, lastCZ = 0, lastTX = 0, craneBusy = 0;
  const animate = meshApi && typeof meshApi.animatePip === 'function' ? meshApi.animatePip : null;
  return {
    group, site: plane ? 'runway' : 'pad', size: { w: S.w, d: S.d, h: plane ? S.eave : S.h }, keyLight, envMap,
    floorClear: plane ? 1.3 : 1.0,
    update(dt, { top = null, focus = null } = {}) {
      // the crane parks its hook a little above the craft
      const want = top ? tmp.copy(top) : tmp.set(0, craneY - 8, 0);
      const k = Math.min(1, dt * 2.2);
      tX += (THREE.MathUtils.clamp(want.x, -hw + 8, hw - 8) - tX) * k; tZ += (THREE.MathUtils.clamp(want.z, -hd + 6, hd - 6) - tZ) * k;
      hookY += (THREE.MathUtils.clamp(want.y + 2.4, 3, craneY - 2.5) - hookY) * k;
      crane.position.z = tZ; trolley.position.x = tX;
      const len = Math.max(0.5, crane.position.y - hookY - 0.9);
      cable.scale.y = len; cable.position.y = -len / 2 + 0.6;
      hook.position.y = hookY - crane.position.y;
      if (focus) { keyLight.target.position.copy(focus); keyLight.position.copy(focus).addScaledVector(keyDir, 130); }
      clock += dt;
      // grounding patch under the work
      if (focus) {
        const span3 = top ? Math.max(6, Math.min(26, (top.y - 0) * 0.34 + 6)) : 6;
        craftShade.position.x += (focus.x - craftShade.position.x) * k; craftShade.position.z += (focus.z - craftShade.position.z) * k;
        shadeScale += (span3 - shadeScale) * k; craftShade.scale.set(shadeScale, shadeScale, 1);
        craftShade.material.opacity += ((top ? 0.5 : 0) - craftShade.material.opacity) * k;
      }
      // beacons sweep like a rotating lamp; the crane's flash faster while the bridge is travelling
      const moving = Math.min(1, (Math.abs(crane.position.z - lastCZ) + Math.abs(trolley.position.x - lastTX)) / Math.max(dt, 1e-3) / 1.5);
      lastCZ = crane.position.z; lastTX = trolley.position.x;
      craneBusy += (moving - craneBusy) * Math.min(1, dt * 3);
      for (const bc of beacons) {
        const rate = bc.rate * (bc.crane ? 2.2 + craneBusy * 3.5 : 2.6);
        const sweep = Math.pow(Math.max(0, Math.sin(clock * rate + bc.phase)), 5);
        const lvl = (bc.crane ? 0.1 + 0.35 * craneBusy : 0.12) + sweep * (bc.crane ? 0.35 + 0.9 * craneBusy : 0.9);
        gTint[bc.i * 4] = 1.0 * lvl * 0.7; gTint[bc.i * 4 + 1] = 0.5 * lvl * 0.7; gTint[bc.i * 4 + 2] = 0.08 * lvl * 0.7;
        gTint[bc.core * 4] = 1.0 * lvl * 2.2; gTint[bc.core * 4 + 1] = 0.66 * lvl * 2.2; gTint[bc.core * 4 + 2] = 0.2 * lvl * 2.2;
        if (bc.crane) { gOff[bc.i * 3 + 2] = bc.z0 + crane.position.z; gOff[bc.core * 3 + 2] = bc.z0 + crane.position.z; }
      }
      tintAttr.needsUpdate = true; offAttr.needsUpdate = true;
      // the crew
      for (const m of crew) {
        m.t += dt;
        let walk = 0;
        const pa = m.path;
        if (pa) {
          if (pa.wait > 0) pa.wait -= dt;
          else {
            const n = pa.pts.length;
            const ia = pa.seg, ib = pa.closed ? (pa.seg + 1) % n : pa.seg + pa.dir;
            const a = pa.pts[ia], c = pa.pts[ib];
            const len2 = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
            pa.u += pa.speed * dt / len2; walk = 1;
            const want2 = Math.atan2(c[0] - a[0], c[1] - a[1]);
            let d = want2 - pa.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); pa.yaw += d * Math.min(1, dt * 6);
            if (pa.u >= 1) {
              pa.u = 0; pa.seg = ib;
              if (!pa.closed && (ib === 0 || ib === n - 1)) { pa.dir = -pa.dir; pa.wait = 2.5 + (ib ? 1.5 : 0); }
              m.p.position.x = c[0]; m.p.position.z = c[1];
            } else { m.p.position.x = a[0] + (c[0] - a[0]) * pa.u; m.p.position.z = a[1] + (c[1] - a[1]) * pa.u; }
            m.p.rotation.y = pa.yaw;
          }
          pa.blend = (pa.blend || 0) + (walk - (pa.blend || 0)) * Math.min(1, dt * 8); walk = pa.blend;
        }
        if (animate) animate(m.p, { walk, t: m.t });
      }
    },
    dispose() {
      const walk = o => { if (o.userData && o.userData.foreign) return; if (o.isMesh && o.geometry && !owned.includes(o.geometry)) o.geometry.dispose(); for (const c of o.children) walk(c); };
      walk(group);
      for (const o of owned) o.dispose();
      if (envRT) envRT.dispose();
      keyLight.shadow.map && keyLight.shadow.map.dispose();
    },
  };
}
