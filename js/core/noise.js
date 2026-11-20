// Deterministic seeded gradient noise (pure maths, no DOM).

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small deterministic PRNG, exported for other sim modules that need seeded randomness. */
export function makeRandom(seed) {
  return mulberry32(seed);
}

// 12 edge-midpoint gradients (padded to 16 so we can mask with & 15).
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1]);

export function makeNoise(seed = 1) {
  const rnd = mulberry32((seed | 0) ^ 0x9e3779b9);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  function noise3(x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    const v = y * y * y * (y * (y * 6 - 15) + 10);
    const w = z * z * z * (z * (z * 6 - 15) + 10);
    const A = perm[X] + Y, B = perm[X + 1] + Y;
    const AA = perm[A] + Z, AB = perm[A + 1] + Z, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    const x1 = x - 1, y1 = y - 1, z1 = z - 1;
    let h;
    h = perm[AA] & 15; const n000 = GX[h] * x + GY[h] * y + GZ[h] * z;
    h = perm[BA] & 15; const n100 = GX[h] * x1 + GY[h] * y + GZ[h] * z;
    h = perm[AB] & 15; const n010 = GX[h] * x + GY[h] * y1 + GZ[h] * z;
    h = perm[BB] & 15; const n110 = GX[h] * x1 + GY[h] * y1 + GZ[h] * z;
    h = perm[AA + 1] & 15; const n001 = GX[h] * x + GY[h] * y + GZ[h] * z1;
    h = perm[BA + 1] & 15; const n101 = GX[h] * x1 + GY[h] * y + GZ[h] * z1;
    h = perm[AB + 1] & 15; const n011 = GX[h] * x + GY[h] * y1 + GZ[h] * z1;
    h = perm[BB + 1] & 15; const n111 = GX[h] * x1 + GY[h] * y1 + GZ[h] * z1;
    const a0 = n000 + u * (n100 - n000), a1 = n010 + u * (n110 - n010);
    const b0 = n001 + u * (n101 - n001), b1 = n011 + u * (n111 - n011);
    const c0 = a0 + v * (a1 - a0), c1 = b0 + v * (b1 - b0);
    const r = c0 + w * (c1 - c0);
    return r > 1 ? 1 : r < -1 ? -1 : r;
  }

  function fbm(x, y, z, octaves = 5, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise3(x, y, z);
      norm += amp;
      amp *= gain;
      // offset each octave so lattice points do not line up
      x = x * lacunarity + 17.13; y = y * lacunarity + 5.71; z = z * lacunarity + 9.37;
    }
    return norm > 0 ? sum / norm : 0;
  }

  return { noise3, fbm };
}
