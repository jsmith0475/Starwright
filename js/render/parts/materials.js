// Starwright part materials: one shared instance per bucket, built lazily. Authored for the renderer
// contract in docs/SECOND_PASS.md (sRGB output, ACES tone mapping, soft shadows).
import * as THREE from '../../lib/three.module.min.js';
import { hullMaps, metalMaps, bellMaps, foilMaps, solarMaps, tileMaps, treadMaps, fabricMaps, steelMaps, hexTileMaps, glowRamp, heatRamp, decalAtlas } from './textures.js';

export const PALETTE = {
  white: 0xf2f4f5, shade: 0xd3d9de, teal: 0x39d0c0, tealDark: 0x1c8f86, gun: 0x333a44, dark: 0x1b1f26,
  cream: 0xf3e6c8, creamDark: 0xdcc9a0, amber: 0xffb347, orange: 0xff7a2a, blue: 0x16307a, grey: 0x8a929c,
  steel: 0xaab2bb, gold: 0xd9a441, red: 0xe0483a, green: 0x7bd66a, char: 0x5e4436, slate: 0x2a3442,
  // second pass additions
  hull: 0xe9ebed, hullWarm: 0xe6dfcf, foam: 0xc7702e, copper: 0xb86a3c, brass: 0xc9a25a, iron: 0x565d68, soot: 0x23262b,
  silver: 0xd6dade, rubber: 0x26282c, bluePaint: 0x2a5d9c, redPaint: 0xb8402f, yellow: 0xe8b93a, graphite: 0x5a626e,
};

const cache = {};
let envTex = null, envIntensity = 0.9;
const STD = THREE.MeshStandardMaterial, PHYS = THREE.MeshPhysicalMaterial;
const NS = (x, y = x) => new THREE.Vector2(x, y);

function make(name) {
  switch (name) {
    // painted plating with seams, rivets, grime and chips; tinted by vertex colour
    case 'hull': { const t = hullMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(0.9), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 1 }); }
    // smooth paint for small bits whose UVs are not laid out
    case 'paint': return new STD({ vertexColors: true, roughness: 0.5, metalness: 0.05 });
    // bare machined metal
    case 'metal': { const t = metalMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(0.5), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 0.92, side: THREE.DoubleSide }); }
    case 'chrome': return new STD({ vertexColors: true, roughness: 0.16, metalness: 1 });
    // engine bell with cooling channels
    case 'bell': { const t = bellMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(1.1), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 0.9, side: THREE.DoubleSide }); }
    case 'foil': { const t = foilMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(1.0), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 0.78, side: THREE.DoubleSide }); }
    case 'solar': { const t = solarMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(0.6), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 1, side: THREE.DoubleSide, emissive: 0x06103a, emissiveIntensity: 0.25 }); }
    case 'tile': { const t = tileMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(1.2), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 1 }); }
    // bare brushed stainless sheet (XXL hulls) and the black hexagonal tiles on their belly; a skirt shows its inside
    case 'steel': { const t = steelMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(0.55), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 1, side: THREE.DoubleSide }); }
    case 'hextile': { const t = hexTileMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(1.0), roughnessMap: t.ormMap, metalnessMap: t.ormMap, roughness: 1, metalness: 1, side: THREE.DoubleSide }); }
    case 'rubber': { const t = treadMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: NS(1.6), roughness: 0.92, metalness: 0 }); }
    case 'glass': return new PHYS({ vertexColors: true, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, reflectivity: 0.9, emissive: 0x07262c, emissiveIntensity: 0.55 });
    case 'jar': return new PHYS({ color: 0xc8f4ee, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.34, depthWrite: false, clearcoat: 1 });
    case 'decal': return new STD({ map: decalAtlas(), transparent: true, depthWrite: false, roughness: 0.62, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
      // one pass: a stamp never overlaps itself on screen, and the default two passes (back faces, then front) cost a
      // second draw call and two program look-ups per decal mesh per frame
      forceSinglePass: true });
    case 'lamp': return new THREE.MeshBasicMaterial({ vertexColors: true });
    // nozzle interiors: a lit dark liner whose emissive ramp is driven by throttle (cloned per part instance)
    case 'glow': return new STD({ vertexColors: true, roughness: 0.7, metalness: 0.4, emissive: 0x000000, emissiveMap: glowRamp(), side: THREE.DoubleSide });
    // lamps that switch (lights, ion grids): cloned per part instance, emissive set by state
    case 'beam': return new STD({ vertexColors: true, roughness: 0.3, metalness: 0, emissive: 0xfff2d0, emissiveIntensity: 0 });
    // re-entry glow laid over a heat shield's face: additive, radial ramp in u, opacity driven by temperature
    case 'heat': return new THREE.MeshBasicMaterial({ map: heatRamp(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, forceSinglePass: true });   // additive: order-free
    case 'canopy': { const t = fabricMaps(); return new STD({ vertexColors: true, map: t.map, normalMap: t.normalMap, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }); }
    case 'lines': return new THREE.LineBasicMaterial({ color: 0xe8e2d0, transparent: true, opacity: 0.85 });
    case 'ghost': return new THREE.MeshLambertMaterial({ color: PALETTE.teal, emissive: PALETTE.teal, emissiveIntensity: 0.35, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
    case 'ghostLine': return new THREE.LineBasicMaterial({ color: PALETTE.teal, transparent: true, opacity: 0.4 });
    // distant debris: one flat material for everything
    case 'lod': return new STD({ vertexColors: true, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide });
    default: throw new Error('unknown material ' + name);
  }
}
export function mat(name) {
  let m = cache[name];
  if (!m) { m = cache[name] = make(name); m.name = name; if (envTex && 'envMap' in m && m.isMeshStandardMaterial) { m.envMap = envTex; m.envMapIntensity = envIntensity; } }
  return m;
}
export const NO_SHADOW = new Set(['decal', 'lamp', 'jar', 'lines', 'ghost', 'ghostLine', 'heat']);
export const NO_TINT = new Set(['glow', 'lamp', 'decal', 'beam', 'jar', 'heat']);

// ---------------------------------------------------------------------------------------------
// Image-based lighting. Metal parts need something to reflect; partmesh installs this small procedural
// studio/sky environment on its own materials the first time it sees a renderer.
// ---------------------------------------------------------------------------------------------
export function hasPartEnvironment() { return !!envTex; }
export function setPartEnvironment(texture, intensity = envIntensity) {
  envTex = texture; envIntensity = intensity;
  for (const m of Object.values(cache)) if (m.isMeshStandardMaterial) { m.envMap = texture; m.envMapIntensity = intensity; m.needsUpdate = true; }
}
export function partEnvironment() { return envTex; }
export function partEnvIntensity() { return envIntensity; }
export function buildEnvironment(renderer) {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(50, 32, 16), pos = geo.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
  const top = new THREE.Color(0x6f9fd8), hor = new THREE.Color(0xdfe9f2), low = new THREE.Color(0x9a9488), bot = new THREE.Color(0x5a554e);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50;
    if (y >= 0) c.copy(hor).lerp(top, Math.pow(y, 0.55)); else c.copy(low).lerp(bot, Math.min(1, -y * 1.6));
    if (y > -0.06 && y < 0.05) c.lerp(hor, 0.6);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  // sun and two soft boxes so curved metal picks up crisp highlights
  const blob = (x, y, z, s, color, k) => { const m = new THREE.Mesh(new THREE.SphereGeometry(s, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) })); m.position.set(x, y, z); scene.add(m); };
  blob(22, 30, 26, 5, 0xfff1d8, 30); blob(-34, 14, -10, 9, 0xbfd8ff, 2.2); blob(8, 6, -40, 12, 0xffffff, 1.2);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.03);
  pm.dispose(); geo.dispose();
  return rt.texture;
}
