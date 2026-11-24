// Starwright: the cloth and lines of a parachute, as numbers. No THREE, no DOM (js/render/partmesh.js wraps these
// arrays in meshes; tests/verify/checks_parachute.mjs reads them directly).
//
// One function writes BOTH the canopy and its suspension lines from one shape (js/core/parachute.js `chuteShape`, the
// same shape the flight physics flies), and a line's upper end is not computed a second time: it is copied from the
// skirt vertex of the seam it is sewn to. So whatever the canopy does (fill, breathe, lean in a cluster) the lines end
// on the cloth.
//
// Frame of one canopy: origin at the confluence (where its lines meet), +Y along its axis. The skirt hangs at
// y = shape.h, the widest circle at y = shape.h + shape.drop, the apex at y = shape.h + shape.drop + shape.c.
// A canopy is `gores` panels of cloth between radial seams. Along a seam the cloth lies on the ellipsoid; between two
// seams it billows outward, and at the hem it arches up between the two lines that hold it (the scallops).

const TAU = Math.PI * 2;

/** Mesh layout of one canopy: `gores` panels, each `sub` quads wide and `rings` quads from the vent to the hem. */
export function canopyLayout(kind = 'main', quality = 2) {
  const gores = kind === 'drogue' ? 12 : kind === 'cluster' ? 20 : 24;
  const sub = quality >= 2 ? 4 : quality === 1 ? 3 : 2, rings = quality >= 2 ? 18 : quality === 1 ? 12 : 8;
  const cols = sub + 1, rows = rings + 1;
  return { gores, sub, rings, cols, rows, verts: gores * cols * rows, tris: gores * sub * rings * 2, lines: gores };
}

/** Triangle indices (two per quad). */
export function canopyIndex(lay) {
  const idx = new (lay.verts > 65535 ? Uint32Array : Uint16Array)(lay.tris * 3);
  let k = 0;
  for (let g = 0; g < lay.gores; g++) for (let i = 0; i < lay.sub; i++) for (let j = 0; j < lay.rings; j++) {
    const a = (g * lay.cols + i) * lay.rows + j, b = a + lay.rows, c = a + 1, d = b + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  return idx;
}

/**
 * Vertex colours: `a` and `b` alternate gore by gore, the crown ring is `crown`, and the hem band swaps the two
 * (`a`, `b`, `crown` are [r, g, b] in 0..1). A thin darker line is laid on each seam.
 */
export function canopyColors(lay, a, b, crown, hemBand = true) {
  const col = new Float32Array(lay.verts * 3);
  const crownRows = Math.max(1, Math.round(lay.rings * 0.12)), hemRow = lay.rings - Math.max(1, Math.round(lay.rings * 0.1));
  for (let g = 0; g < lay.gores; g++) for (let i = 0; i < lay.cols; i++) for (let j = 0; j < lay.rows; j++) {
    const k = ((g * lay.cols + i) * lay.rows + j) * 3;
    let c = g % 2 ? b : a;
    if (j <= crownRows) c = crown; else if (hemBand && j > hemRow) c = g % 2 ? a : b;
    const seam = i === 0 || i === lay.sub ? 0.8 : 1;
    col[k] = c[0] * seam; col[k + 1] = c[1] * seam; col[k + 2] = c[2] * seam;
  }
  return col;
}

/**
 * Write one canopy and its lines.
 *   shape   chuteShape(): { rm, c, delta, h, drop }
 *   lay     canopyLayout()
 *   pos, nrm, uv   Float32Array(lay.verts × 3 | 3 | 2), written in place (nrm and uv may be null)
 *   line    Float32Array(lay.lines × 6): each line is [confluence, skirt at a seam]
 *   breath  the canopy's width is multiplied by this (1 = as the physics has it)
 *   phase   turns the seams about the axis (rad)
 * → the largest distance between a line's upper end and the skirt vertex it should be on (0 by construction).
 */
export function writeCanopy(shape, lay, pos, nrm, uv, line, breath = 1, phase = 0) {
  const { gores, sub, rings, cols, rows } = lay;
  const rm = shape.rm * breath, c = shape.c, yEq = shape.h + shape.drop;
  const end = Math.PI / 2 + shape.delta, vent = 0.05 + 0.03 * Math.min(1, shape.rm / Math.max(shape.c, 1e-6));
  const half = Math.PI / gores;                       // half the angle one gore spans
  // how far the cloth billows between seams, as a share of the local half-width of the gore: taut when fully open,
  // looser while it is still narrow
  const slack = Math.min(1, Math.max(0, 1 - shape.rm / Math.max(shape.c, 1e-6)));
  const billow = 0.16 + 0.22 * slack, scallop = 0.55;
  // cloth texture: three tiles across a gore, and as many down it as keeps them about square
  const vTile = Math.max(3, Math.round(3 * (shape.c + shape.rm) / Math.max(shape.rm * 2 * half, 0.05) / 4));
  let k = 0, u = 0;
  for (let g = 0; g < gores; g++) {
    for (let i = 0; i < cols; i++) {
      const s = i / sub, th = phase + (g + s) * TAU / gores, ct = Math.cos(th), st = Math.sin(th);
      const arch = Math.sin(Math.PI * s);            // 0 on the seams, 1 mid-gore
      for (let j = 0; j < rows; j++) {
        const t = j / rings, ph = vent + (end - vent) * t, sp = Math.sin(ph), cp = Math.cos(ph);
        const r0 = rm * sp, w = r0 * half;            // radius on the seam, half-width of the gore here
        const hem = t * t * t * t;                    // the scallop lives in the last rings before the hem
        const r = r0 + billow * w * arch * Math.sin(Math.min(1, t * 1.6) * Math.PI / 2);
        const y = yEq + c * cp + scallop * w * arch * hem;
        pos[k] = r * ct; pos[k + 1] = y; pos[k + 2] = r * st; k += 3;
        if (uv) { uv[u++] = (g + s) * 3; uv[u++] = t * vTile; }
      }
    }
  }
  if (nrm) {
    // normals from the grid itself, gore by gore (so a seam stays a crease), pointing out of the canopy
    for (let g = 0; g < gores; g++) for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const at = (ii, jj) => ((g * cols + ii) * rows + jj) * 3;
      const i0 = at(Math.max(i - 1, 0), j), i1 = at(Math.min(i + 1, sub), j), j0 = at(i, Math.max(j - 1, 0)), j1 = at(i, Math.min(j + 1, rings));
      const ax = pos[i1] - pos[i0], ay = pos[i1 + 1] - pos[i0 + 1], az = pos[i1 + 2] - pos[i0 + 2];
      const bx = pos[j1] - pos[j0], by = pos[j1 + 1] - pos[j0 + 1], bz = pos[j1 + 2] - pos[j0 + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const o = at(i, j), l = Math.hypot(nx, ny, nz) || 1;
      // outward: away from the axis above the widest circle, and never into it
      const out = nx * pos[o] + nz * pos[o + 2] + ny * (pos[o + 1] - yEq);
      const sgn = out < 0 ? -1 / l : 1 / l;
      nrm[o] = nx * sgn; nrm[o + 1] = ny * sgn; nrm[o + 2] = nz * sgn;
    }
  }
  // the lines: from the confluence to the hem vertex on each seam (column 0 of each gore, last row), copied not recomputed
  let worst = 0;
  if (line) for (let g = 0; g < gores; g++) {
    const o = ((g * cols) * rows + rings) * 3, l = g * 6;
    line[l] = 0; line[l + 1] = 0; line[l + 2] = 0;
    line[l + 3] = pos[o]; line[l + 4] = pos[o + 1]; line[l + 5] = pos[o + 2];
    // the same seam seen from the gore before it (its last column) must be the same point
    const p = ((((g + gores - 1) % gores) * cols + sub) * rows + rings) * 3;
    worst = Math.max(worst, Math.hypot(pos[o] - pos[p], pos[o + 1] - pos[p + 1], pos[o + 2] - pos[p + 2]));
  }
  return worst;
}

/**
 * Where the canopies of a parachute sit: → [{ ax, az (unit axis about which canopy k leans), tilt (rad), phase }].
 * One canopy stands straight; the canopies of a cluster lean out from the shared confluence by shape.tilt.
 */
export function canopyPlacement(shape) {
  const n = shape.count || 1, out = [];
  for (let k = 0; k < n; k++) {
    const a = k * TAU / n;
    // leaning toward (cos a, 0, sin a) is a rotation about the axis (sin a, 0, -cos a)... for +Y toward +dir: axis = Y x dir
    out.push({ dx: Math.cos(a), dz: Math.sin(a), tilt: n > 1 ? shape.tilt : 0, phase: a });
  }
  return out;
}
