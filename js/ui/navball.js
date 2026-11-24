// Starwright — attitude ball ("the Compass Ball").
//
// A small three.js scene drawn into a scissor viewport of the shared renderer, plus a transparent 2D canvas
// (DOM) on top of it for the direction markers and the fixed nose reticle.
//
// Maths. The ball is the sphere of directions around the vessel, painted in the local horizon frame
// (north / east / up at the vessel) and seen FROM THE INSIDE along the nose:
//     screen-right = vessel +X ("right"),  screen-up = vessel +Z ("top"),  screen-centre = vessel +Y (nose).
// A world direction d therefore lands at  (d·X, d·Z)·R  from the centre and is visible when d·Y > 0.
// The sphere mesh is built in a frame G = (east, up, south); every frame its rotation is set to the matrix that
// takes G to the screen frame S = (X, Z, −Y) of the vessel, and an orthographic camera looks down −S.z at the
// far (inside) hemisphere (material side = BackSide). Heading grows to the right when looking at the horizon,
// like a real compass seen from inside.
//
//   const ball = createNavball()
//   ball.setAttitude(q, pos)                  vessel.q and vessel.pos (relative to the body centre, inertial)
//   ball.project(dirWorld, out) → out{x,y,front}   unit-disc coordinates (y up)
//   ball.heading / ball.pitch / ball.roll     degrees
//   ball.setMarkers([{kind, dir}])            kinds: prograde retrograde normal antinormal radialOut radialIn maneuver
//                                             target antiTarget relPrograde relRetrograde (the last two: velocity
//                                             relative to the target, drawn in the target's orchid colour)
//   ball.markerAt(kind) → {x, y, front} | null    where a marker of that kind sits on the unit disc (for tests)
//   ball.render(renderer, rectCssPx, viewportHeightCss)     draws the sphere (call after the main scene)
//   ball.drawOverlay(canvas2d)                draws markers + reticle on a square canvas covering the ball
import * as THREE from '../lib/three.module.min.js';

const DEG = Math.PI / 180;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export const MARKER_STYLE = {
  prograde: { color: '#39d0c0', label: 'Prograde' },
  retrograde: { color: '#39d0c0', label: 'Retrograde' },
  normal: { color: '#b79cff', label: 'Normal' },
  antinormal: { color: '#b79cff', label: 'Anti-normal' },
  radialOut: { color: '#6cb6ff', label: 'Radial out' },
  radialIn: { color: '#6cb6ff', label: 'Radial in' },
  maneuver: { color: '#ffb347', label: 'Maneuver' },
  target: { color: '#e879f9', label: 'Target' },
  antiTarget: { color: '#e879f9', label: 'Away from target' },
  relPrograde: { color: '#e879f9', label: 'Toward where you drift (relative to the target)' },
  relRetrograde: { color: '#e879f9', label: 'Against your drift (relative to the target)' },
  lift: { color: '#ffe066', label: 'Lift: the way the air is pushing the vessel across its path' },
};

function ballTexture() {
  // 4096 × 2048: one texel is 0.09°, so numerals stay crisp on a 2× display; mip-mapped + anisotropic for the rim.
  const W = 4096, H = 2048, U = W / 2048;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  // sky hemisphere (deep blue at the zenith to bright cyan at the horizon), ground hemisphere (sand to umber)
  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#0a3f6e'); sky.addColorStop(0.5, '#1479b8'); sky.addColorStop(0.86, '#2fb4de'); sky.addColorStop(1, '#7fe3f2');
  g.fillStyle = sky; g.fillRect(0, 0, W, H / 2);
  const gnd = g.createLinearGradient(0, H / 2, 0, H);
  gnd.addColorStop(0, '#d79a45'); gnd.addColorStop(0.14, '#b0722d'); gnd.addColorStop(0.5, '#7a4a20'); gnd.addColorStop(1, '#3d2411');
  g.fillStyle = gnd; g.fillRect(0, H / 2, W, H / 2);

  const yOf = pitch => H / 2 - (pitch / 90) * (H / 2);
  const xOf = hdg => (hdg / 360) * W;
  g.lineCap = 'butt';
  // pitch rings: full rings every 10°, short ladder rungs every 5° beside the cardinal meridians
  for (let p = -80; p <= 80; p += 10) {
    if (p === 0) continue;
    const major = p % 30 === 0;
    g.strokeStyle = p > 0 ? 'rgba(255,255,255,' + (major ? 0.9 : 0.5) + ')' : 'rgba(255,240,214,' + (major ? 0.85 : 0.45) + ')';
    g.lineWidth = (major ? 4 : 2.5) * U;
    g.beginPath(); g.moveTo(0, yOf(p)); g.lineTo(W, yOf(p)); g.stroke();
  }
  g.lineWidth = 2.5 * U;
  for (let p = -85; p <= 85; p += 10) for (let h = 0; h < 360; h += 45) {
    const half = 2.2 / Math.max(0.25, Math.cos(p * DEG));
    g.strokeStyle = p > 0 ? 'rgba(255,255,255,0.6)' : 'rgba(255,240,214,0.55)';
    for (const dx of h === 0 ? [0, W] : [0]) { g.beginPath(); g.moveTo(xOf(h - half) + dx, yOf(p)); g.lineTo(xOf(h + half) + dx, yOf(p)); g.stroke(); }
  }
  // meridians every 30°, heavier at the cardinal points; intercardinals dashed
  for (let h = 0; h < 360; h += 15) {
    const card = h % 90 === 0, main = h % 30 === 0;
    if (!main && h % 45 !== 0) continue;
    g.strokeStyle = 'rgba(255,255,255,' + (card ? 0.9 : main ? 0.4 : 0.3) + ')';
    g.lineWidth = (card ? 5 : 2.5) * U;
    g.setLineDash(main ? [] : [14 * U, 18 * U]);
    g.beginPath(); g.moveTo(xOf(h), yOf(80)); g.lineTo(xOf(h), yOf(-80)); g.stroke();
    if (h === 0) { g.beginPath(); g.moveTo(W, yOf(80)); g.lineTo(W, yOf(-80)); g.stroke(); }
  }
  g.setLineDash([]);
  // heading ticks along the horizon: every 5°, longer every 10°
  g.strokeStyle = '#ffffff';
  for (let h = 0; h < 360; h += 5) { const l = h % 10 === 0 ? 3.2 : 1.7; g.lineWidth = (h % 10 === 0 ? 3.5 : 2.5) * U; g.beginPath(); g.moveTo(xOf(h), yOf(l)); g.lineTo(xOf(h), yOf(-l)); g.stroke(); }
  // horizon band
  g.fillStyle = '#ffffff'; g.fillRect(0, H / 2 - 5 * U, W, 10 * U);
  g.fillStyle = 'rgba(11,15,20,0.7)'; g.fillRect(0, H / 2 - 1.2 * U, W, 2.4 * U);

  // labels: stretch horizontally by 1/cos(pitch) so they look right on the sphere
  const label = (text, hdg, pitch, size, color, weight = 800, plate = null) => {
    const sx = 1 / Math.max(0.2, Math.cos(pitch * DEG));
    for (const dx of [0, W]) {       // draw twice so labels straddling the seam wrap
      g.save();
      g.translate(xOf(hdg) + (hdg === 0 && dx ? dx : 0), yOf(pitch));
      g.scale(sx, 1);
      g.font = `${weight} ${size * U}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (plate) { const w = g.measureText(text).width + size * U * 0.5; g.fillStyle = plate; g.beginPath(); g.roundRect(-w / 2, -size * U * 0.62, w, size * U * 1.2, size * U * 0.25); g.fill(); }
      g.lineWidth = size * U * 0.2; g.strokeStyle = 'rgba(6,12,18,0.85)'; g.lineJoin = 'round';
      g.strokeText(text, 0, 0); g.fillStyle = color; g.fillText(text, 0, 0);
      g.restore();
      if (hdg !== 0) break;
    }
  };
  const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let h = 0; h < 360; h += 30) {
    const name = CARD[h];
    label(name || String(h).padStart(3, '0'), h, 8.2, name ? 60 : 40, name ? '#ffd27a' : '#ffffff', 850, name ? 'rgba(6,12,18,0.55)' : null);
    label(name || String(h).padStart(3, '0'), h, -8.2, name ? 54 : 38, name ? '#ffd27a' : '#fff1dc', 850, name ? 'rgba(6,12,18,0.45)' : null);
  }
  for (let p = 10; p <= 80; p += 10) {
    const big = p % 30 === 0;
    for (let h = 45; h < 360; h += (p >= 80 ? 180 : 90)) {
      label(String(p), h, p, big ? 46 : 38, '#ffffff', 800);
      label(String(p), h, -p, big ? 46 : 38, '#ffe9cc', 800);
    }
    if (p >= 20 && p <= 60) for (let h = 0; h < 360; h += 90) { label(String(p), h + 9 / Math.max(0.3, Math.cos(p * DEG)) * 0.75, p, big ? 40 : 32, '#e4f6ff', 750); label(String(p), h + 9 / Math.max(0.3, Math.cos(p * DEG)) * 0.75, -p, big ? 40 : 32, '#f6dcb8', 750); }
  }
  // zenith / nadir caps
  g.fillStyle = '#072c50'; g.fillRect(0, 0, W, yOf(86.5));
  g.fillStyle = '#ffffff'; g.fillRect(0, yOf(86.5) - 4 * U, W, 4 * U);
  g.fillStyle = '#2c190b'; g.fillRect(0, yOf(-86.5), W, H - yOf(-86.5));
  g.fillStyle = '#ffd9a3'; g.fillRect(0, yOf(-86.5), W, 4 * U);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; t.wrapS = THREE.RepeatWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Sphere in the frame G = (east, up, south) with uv = (heading/360, (pitch+90)/180). */
function ballGeometry(segW = 96, segH = 48) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= segH; j++) {
    const pitch = (j / segH - 0.5) * Math.PI, cp = Math.cos(pitch), sp = Math.sin(pitch);
    for (let i = 0; i <= segW; i++) {
      const h = (i / segW) * Math.PI * 2;
      pos.push(cp * Math.sin(h), sp, -cp * Math.cos(h));      // east, up, south components
      uv.push(i / segW, j / segH);
    }
  }
  for (let j = 0; j < segH; j++) for (let i = 0; i < segW; i++) {
    const a = j * (segW + 1) + i, b = a + 1, c = a + segW + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export function createNavball() {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
  const texture = ballTexture();
  const mesh = new THREE.Mesh(ballGeometry(), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false }));
  // Only the hemisphere beyond the centre plane is wanted: clip the near half with the camera's near plane.
  camera.near = 3; camera.far = 4.2; camera.updateProjectionMatrix();
  scene.add(mesh);

  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0), east = new THREE.Vector3(1, 0, 0), north = new THREE.Vector3(0, 0, -1), south = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  let markers = [];
  const vp = new THREE.Vector4(), sc = new THREE.Vector4();

  const toS = (v, out) => out.set(v.dot(X), v.dot(Z), -v.dot(Y));
  const cE = new THREE.Vector3(), cU = new THREE.Vector3(), cS = new THREE.Vector3();

  const ball = {
    scene, camera, mesh, heading: 0, pitch: 90, roll: 0, up, east, north,

    /** q: vessel attitude (local → inertial); pos: vessel position relative to the body centre (inertial). */
    setAttitude(q, pos) {
      X.set(1, 0, 0).applyQuaternion(q); Y.set(0, 1, 0).applyQuaternion(q); Z.set(0, 0, 1).applyQuaternion(q);
      up.copy(pos); if (up.lengthSq() < 1e-12) up.set(0, 1, 0); up.normalize();
      east.crossVectors(Y_AXIS, up); if (east.lengthSq() < 1e-12) east.set(0, 0, -1); east.normalize();
      north.crossVectors(up, east).normalize();
      south.copy(north).negate();
      toS(east, cE); toS(up, cU); toS(south, cS);
      m.makeBasis(cE, cU, cS);
      mesh.quaternion.setFromRotationMatrix(m);
      const sp = Math.max(-1, Math.min(1, Y.dot(up)));
      ball.pitch = Math.asin(sp) / DEG;
      // near the vertical the nose has no heading: use the "belly" (−Z when pitched up) instead
      let hx = Y.dot(east), hy = Y.dot(north);
      if (hx * hx + hy * hy < 4e-4) { const s = sp > 0 ? -1 : 1; hx = s * Z.dot(east); hy = s * Z.dot(north); }
      let h = Math.atan2(hx, hy) / DEG; if (h < 0) h += 360;
      ball.heading = h >= 359.95 ? 0 : h;
      // roll: angle of the vessel's right wing below the horizon, seen from behind
      // (tmp = level "right" of the nose; wings level with the top (+Z) up reads 0, right wing down is positive)
      tmp.crossVectors(Y, up);
      if (tmp.lengthSq() < 1e-8) ball.roll = 0;
      else { tmp.normalize(); ball.roll = Math.atan2(-X.dot(up), X.dot(tmp)) / DEG; }
    },

    /** World direction → unit-disc coordinates {x (right), y (up), front}. */
    project(dir, out = {}) {
      const l = dir.length() || 1;
      out.x = dir.dot(X) / l; out.y = dir.dot(Z) / l; out.front = dir.dot(Y) / l > 0;
      return out;
    },

    setMarkers(list) { markers = list || []; },
    get markers() { return markers; },
    markerAt(kind) {
      const mk = markers.find(m => m && m.kind === kind && m.dir);
      return mk ? ball.project(mk.dir, {}) : null;
    },

    /** rect = {x, y, size} in CSS pixels (top-left origin) of the square the ball fills. */
    render(renderer, rect, viewH) {
      if (!renderer || !rect || rect.size < 8) return;
      renderer.getViewport(vp); renderer.getScissor(sc);
      const prevTest = renderer.getScissorTest(), prevAuto = renderer.autoClear;
      const y = viewH - rect.y - rect.size;
      renderer.setViewport(rect.x, y, rect.size, rect.size);
      renderer.setScissor(rect.x, y, rect.size, rect.size);
      renderer.setScissorTest(true);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderer.setViewport(vp); renderer.setScissor(sc); renderer.setScissorTest(prevTest); renderer.autoClear = prevAuto;
    },

    /** Markers and the fixed nose reticle, on a square 2D canvas laid exactly over the ball. */
    drawOverlay(canvas) {
      const g = canvas.getContext('2d'), S = canvas.width, R = S / 2, k = S / 200;
      g.clearRect(0, 0, S, S);
      g.save();
      g.beginPath(); g.arc(R, R, R - 0.5, 0, Math.PI * 2); g.clip();
      // the sphere's own shading (dark toward the rim) and a glass highlight
      const sh = g.createRadialGradient(R, R, R * 0.35, R, R, R);
      sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(0.62, 'rgba(0,0,0,0.06)'); sh.addColorStop(0.88, 'rgba(0,0,0,0.38)'); sh.addColorStop(1, 'rgba(0,0,0,0.78)');
      g.fillStyle = sh; g.fillRect(0, 0, S, S);
      const hi = g.createRadialGradient(R * 0.72, R * 0.5, 0, R * 0.72, R * 0.5, R * 0.75);
      hi.addColorStop(0, 'rgba(255,255,255,0.16)'); hi.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = hi; g.fillRect(0, 0, S, S);
      const p = {};
      // back-side markers first (dim, pinned to the rim), then the visible ones
      for (const pass of [0, 1]) {
        for (const mk of markers) {
          if (!mk || !mk.dir) continue;
          ball.project(mk.dir, p);
          if ((pass === 1) !== p.front) continue;
          let x = p.x, y = p.y, alpha = 1, scale = 1;
          if (!p.front) {
            if (!mk.showBehind) continue;
            const l = Math.hypot(x, y) || 1; x = x / l * 0.93; y = y / l * 0.93; alpha = 0.55; scale = 0.6;
          } else { const l = Math.hypot(x, y); if (l > 0.93) { x *= 0.93 / l; y *= 0.93 / l; } }
          g.globalAlpha = alpha;
          drawGlyph(g, mk.kind, R + x * R, R - y * R, 12.5 * k * scale);
        }
      }
      g.globalAlpha = 1;
      g.restore();
      drawReticle(g, R, R, k);
    },

    dispose() { mesh.geometry.dispose(); mesh.material.dispose(); texture.dispose(); },
  };
  return ball;
}

function halo(g, fn) {
  g.save(); g.strokeStyle = 'rgba(6,10,14,0.85)'; g.fillStyle = 'rgba(6,10,14,0.85)'; g.lineWidth *= 2.1; fn(true); g.restore();
  fn(false);
}

/** Original marker glyphs (canvas 2D). `s` ≈ half-size in pixels. */
export function drawGlyph(g, kind, x, y, s) {
  const st = MARKER_STYLE[kind] || MARKER_STYLE.target;
  g.save();
  g.translate(x, y);
  g.lineWidth = Math.max(1.5, s * 0.2); g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = st.color; g.fillStyle = st.color;
  const poly = (pts, close = true) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0] * s, p[1] * s) : g.moveTo(p[0] * s, p[1] * s))); if (close) g.closePath(); };
  switch (kind) {
    case 'prograde': case 'relPrograde':     // "going this way": a ring around a solid pip
      halo(g, () => { g.beginPath(); g.arc(0, 0, s * 0.82, 0, Math.PI * 2); g.stroke(); });
      g.beginPath(); g.arc(0, 0, s * 0.3, 0, Math.PI * 2); g.fill();
      break;
    case 'retrograde': case 'relRetrograde': // "coming from": an open diamond with a bar
      halo(g, () => { poly([[0, -0.95], [0.95, 0], [0, 0.95], [-0.95, 0]]); g.stroke(); });
      g.beginPath(); g.moveTo(-0.42 * s, 0); g.lineTo(0.42 * s, 0); g.stroke();
      break;
    case 'normal':              // solid triangle pointing up
      halo(g, h => { poly([[0, -0.95], [0.9, 0.7], [-0.9, 0.7]]); if (h) g.stroke(); else g.fill(); });
      break;
    case 'antinormal':          // open triangle pointing down
      halo(g, () => { poly([[0, 0.95], [0.9, -0.7], [-0.9, -0.7]]); g.stroke(); });
      break;
    case 'radialOut':           // solid rounded square
      halo(g, h => { g.beginPath(); g.roundRect(-0.72 * s, -0.72 * s, 1.44 * s, 1.44 * s, 0.3 * s); if (h) g.stroke(); else g.fill(); });
      break;
    case 'radialIn':            // open rounded square with a centre dot
      halo(g, () => { g.beginPath(); g.roundRect(-0.72 * s, -0.72 * s, 1.44 * s, 1.44 * s, 0.3 * s); g.stroke(); });
      g.beginPath(); g.arc(0, 0, s * 0.2, 0, Math.PI * 2); g.fill();
      break;
    case 'maneuver': {          // the Starwright four-point star
      const pts = [];
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 - Math.PI / 2, r = i % 2 ? 0.36 : 1.15; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      halo(g, h => { poly(pts); if (h) g.stroke(); else g.fill(); });
      break;
    }
    case 'lift':                // an arrow head: the way the lift points
      halo(g, () => { poly([[-0.85, 0.55], [0, -0.75], [0.85, 0.55]], false); g.stroke(); });
      g.beginPath(); g.arc(0, 0.35 * s, s * 0.16, 0, Math.PI * 2); g.fill();
      break;
    case 'antiTarget':          // "directly away from the target": three short spokes around a hollow centre
      halo(g, () => {
        for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + i * Math.PI * 2 / 3; g.beginPath(); g.moveTo(Math.cos(a) * s * 0.42, Math.sin(a) * s * 0.42); g.lineTo(Math.cos(a) * s * 1.05, Math.sin(a) * s * 1.05); g.stroke(); }
        g.beginPath(); g.arc(0, 0, s * 0.3, 0, Math.PI * 2); g.stroke();
      });
      break;
    default:                    // target: a bracketed dot (two facing arcs)
      halo(g, () => { g.beginPath(); g.arc(0, 0, s * 0.85, 0.35, Math.PI - 0.35); g.stroke(); g.beginPath(); g.arc(0, 0, s * 0.85, Math.PI + 0.35, -0.35); g.stroke(); });
      g.beginPath(); g.arc(0, 0, s * 0.22, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** The fixed nose reticle: an amber ring with a notch on top and two level bars. */
function drawReticle(g, x, y, k) {
  g.save();
  g.translate(x, y);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const draw = () => {
    g.beginPath(); g.arc(0, 0, 7 * k, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(-34 * k, 0); g.lineTo(-13 * k, 0); g.moveTo(13 * k, 0); g.lineTo(34 * k, 0); g.stroke();
    g.beginPath(); g.moveTo(0, -7 * k); g.lineTo(0, -15 * k); g.stroke();
  };
  g.strokeStyle = 'rgba(6,10,14,0.9)'; g.lineWidth = 6 * k; draw();
  g.strokeStyle = '#ffb347'; g.lineWidth = 3 * k; draw();
  g.fillStyle = '#ffb347'; g.beginPath(); g.arc(0, 0, 1.8 * k, 0, Math.PI * 2); g.fill();
  g.restore();
}
