// Starwright — per-body look-up of render style (pure data; shared by the main thread and the bake workers).
// Colours are linear-ish display colours [r, g, b] in 0..1 (sRGB values, converted in the shaders).

const DEFAULT = {
  rock: [0.42, 0.40, 0.38],     // colour of steep slopes
  rockSlope: [0.28, 0.5],       // slope (1 − n·up) range over which rock takes over
  strata: 0,                    // 0..1 strength of horizontal banding on cliffs
  emissive: 0,                  // strength of glow for lava-coloured ground
  fill: 0.16,                   // ambient floor so the night side stays readable
  bump: 1,                      // strength of the baked normal map on the globe
  detail: 1,                    // strength of the close-range detail normals
  gloss: 0,                     // 0 matte regolith … 1 wet ice
  clouds: null,                 // { cover, color, seed, speed (rad/s relative to the ground), alt (m), streak }
                                // clouds.high: a thin layer far above the deck (ice streaks, veils, blown dust), drawn with it:
                                // { alt (m), cover (0 rare … 1 most of the sky), opacity (of its thickest parts), streak (0 even
                                //   veil … 1 separate streaks), color, drift (rad/s relative to the deck), phase (rad) }
  water: null,                  // { shallow, deep, clarity (m) }
  snow: null,                   // { line (m), latDrop (m per unit |sin lat|), color }
  scatter: null,                // ground clutter: { rocks: density per 100 m², rockColor, grass, trees }
  ring: null,                   // { colors: [...], seed }
  // what covers the ground close up (terrain shader): two tints the surface drifts between in patches, patches of
  // another material ("dirt": bare earth, dark gravel, …; dirtT is the noise threshold, lower = more of it), and
  // whether all that follows the green of the biome colour (veg) or lies everywhere
  ground: { tintA: [1.1, 1.09, 1.06], tintB: [0.78, 0.78, 0.81], vary: 0.8, dirt: [0.3, 0.3, 0.3], dirtT: 9, dirtK: 1, veg: 0, grain: 1 },
};

const STYLE = {
  sear: { rock: [0.22, 0.17, 0.16], strata: 0.2, emissive: 1.2, gloss: 0.25, scatter: { rocks: 5, rockColor: [0.2, 0.17, 0.17] } },
  cindra: { rock: [0.30, 0.22, 0.17], emissive: 1.1, scatter: { rocks: 7, rockColor: [0.26, 0.2, 0.17] } },
  murk: { rock: [0.30, 0.22, 0.17], emissive: 1.2, strata: 0.25, fill: 0.05,
    clouds: { cover: 0.97, color: [0.74, 0.60, 0.38], seed: 77, speed: 2.2e-5, alt: 56000, streak: 1, soft: 1 },
    scatter: { rocks: 6, rockColor: [0.3, 0.24, 0.2] } },
  verda: { rock: [0.40, 0.37, 0.33], rockSlope: [0.2, 0.42], strata: 0.15, fill: 0.05, bump: 2.2,
    clouds: { cover: 0.3, color: [1, 1, 1], seed: 11, speed: 1.2e-5, alt: 7000, streak: 0, phase: 5.16,       // phase: fair weather over the space centre for the first days
      high: { alt: 13000, cover: 0.2, opacity: 0.42, streak: 1, color: [1, 1, 1], drift: 0.9e-5 } },          // ice streaks in the jet stream
    water: { shallow: [0.10, 0.50, 0.55], deep: [0.012, 0.07, 0.19], clarity: 14 },
    snow: { line: 2500, latDrop: 2600, color: [0.93, 0.95, 0.98] },
    ground: { tintA: [1.2, 1.06, 0.7], tintB: [0.62, 0.8, 0.6], vary: 0.9, dirt: [0.43, 0.35, 0.25], dirtT: 0.5, veg: 1, grain: 1 },
    scatter: { rocks: 1.2, rockColor: [0.45, 0.43, 0.4], grass: 60, grassColor: [0.34, 0.46, 0.2], dryColor: [0.62, 0.57, 0.3], trees: 0.5 } },
  pell: { rock: [0.50, 0.50, 0.50], rockSlope: [0.35, 0.6], ground: { tintA: [1.1, 1.09, 1.07], tintB: [0.74, 0.74, 0.78], vary: 0.9, dirt: [0.22, 0.22, 0.24], dirtT: 0.3, dirtK: 0.3, veg: 0, grain: 1 }, scatter: { rocks: 8, rockColor: [0.48, 0.48, 0.5] } },
  ost: { rock: [0.55, 0.70, 0.85], gloss: 0.7, rockSlope: [0.3, 0.55], scatter: { rocks: 3, rockColor: [0.8, 0.88, 0.95] } },
  rusk: { rock: [0.42, 0.20, 0.13], rockSlope: [0.18, 0.4], strata: 0.8,
    ground: { tintA: [1.12, 1.03, 0.9], tintB: [0.74, 0.68, 0.7], vary: 1, dirt: [0.26, 0.13, 0.1], dirtT: 0.3, dirtK: 0.4, veg: 0, grain: 1 },
    clouds: { cover: 0.1, color: [0.78, 0.60, 0.46], seed: 5, speed: 1e-5, alt: 9000, streak: 0.5,
      high: { alt: 17000, cover: 0.26, opacity: 0.32, streak: 0.55, color: [0.84, 0.66, 0.5], drift: 1.4e-5 } },  // dust the wind has lifted and drawn out
    scatter: { rocks: 9, rockColor: [0.47, 0.25, 0.17] } },
  dray: { rock: [0.36, 0.31, 0.32], scatter: { rocks: 9, rockColor: [0.4, 0.35, 0.35] } },
  tiv: { rock: [0.45, 0.42, 0.18], emissive: 0.9, strata: 0.3, scatter: { rocks: 5, rockColor: [0.62, 0.58, 0.25] } },
  marn: { rock: [0.30, 0.29, 0.34], rockSlope: [0.2, 0.42], strata: 0.2, gloss: 0.15,
    ground: { tintA: [1.14, 1.08, 0.9], tintB: [0.72, 0.74, 0.86], vary: 1, dirt: [0.2, 0.19, 0.22], dirtT: 0.3, dirtK: 0.4, veg: 0, grain: 1 },
    clouds: { cover: 0.22, color: [0.95, 0.96, 1], seed: 31, speed: 1.6e-5, alt: 6000, streak: 0.3,
      high: { alt: 11000, cover: 0.24, opacity: 0.5, streak: 0.8, color: [0.94, 0.96, 1], drift: 0.7e-5 } },    // ice veils in the cold upper air
    snow: { line: 2100, latDrop: 2300, color: [0.9, 0.93, 0.97] },
    scatter: { rocks: 4, rockColor: [0.33, 0.32, 0.37], grass: 22, grassColor: [0.36, 0.33, 0.42] } },
  slate: { rock: [0.55, 0.60, 0.66], rockSlope: [0.3, 0.55], strata: 0.3, scatter: { rocks: 8, rockColor: [0.27, 0.3, 0.36] } },
  nock: { rock: [0.30, 0.28, 0.28], scatter: { rocks: 12, rockColor: [0.24, 0.22, 0.22] } },
  brim: { rock: [0.60, 0.74, 0.88], gloss: 0.85, rockSlope: [0.3, 0.6],
    water: { shallow: [0.05, 0.18, 0.28], deep: [0.008, 0.03, 0.07], clarity: 30 },
    scatter: { rocks: 3, rockColor: [0.82, 0.88, 0.94] } },
  quell: { rock: [0.62, 0.62, 0.68], gloss: 0.45, rockSlope: [0.3, 0.55], scatter: { rocks: 4, rockColor: [0.7, 0.62, 0.6] } },
  nym: { rock: [0.44, 0.44, 0.47], scatter: { rocks: 8, rockColor: [0.42, 0.42, 0.45] } },
  wend: { rock: [0.20, 0.19, 0.19], gloss: 0.2, scatter: { rocks: 14, rockColor: [0.16, 0.15, 0.15] } },
  thal: { clouds: null },
  orrin: { ring: { colors: [[0.86, 0.78, 0.62], [0.70, 0.60, 0.46], [0.95, 0.90, 0.80]], seed: 9 } },
  helion: {},
};

/** Render style of a body (by id), with defaults filled in. */
export function styleOf(id) {
  const s = STYLE[id];
  if (s && s._full) return s._full;
  const full = { ...DEFAULT, ...(s || {}) };
  full.ground = { ...DEFAULT.ground, ...((s && s.ground) || {}) };
  if (s) Object.defineProperty(s, '_full', { value: full, enumerable: false });
  return full;
}

/** Rotation (rad, about the spin axis, relative to the ground) of a body's cloud deck at time ut. */
export function cloudAngle(style, ut) {
  const c = style.clouds;
  return c ? ((c.phase || 0) + c.speed * ut) % (Math.PI * 2) : 0;
}

/** Rotation (rad, about the spin axis, relative to the deck) of a body's high cloud layer at time ut: it has its own wind. */
export function highCloudAngle(style, ut) {
  const h = style.clouds && style.clouds.high;
  return h ? ((h.phase || 0) + h.drift * ut) % (Math.PI * 2) : 0;
}

/** True when a surface colour (0..1 display rgb) on a body with `emissive` style is glowing lava. */
export function lavaMask(r, g, b) {
  let k = (r - 0.7) / 0.15;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  let j = (0.5 * r - b) / (0.25 * r);
  j = j < 0 ? 0 : j > 1 ? 1 : j;
  return k * j;
}
