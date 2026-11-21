// Starwright — live environment probe: what the surroundings actually look like, for reflections and ambient light.
//
// A small cube map of a scene (the flight screen's far scene: sky, sun, terrain, other worlds) drawn from one point,
// then filtered into the roughness-mip layout three's standard materials sample (PMREM). It replaces a fixed painted
// sky, so metal reflects the grey ground on a moon, the blue of an ocean world, and the black of space.
//
// The first refresh draws all six faces at once; later ones draw one face per call, so a refresh costs one small
// extra scene draw in each of six frames, and nothing at all between refreshes.
//
//   const probe = createEnvProbe(renderer, { size: 64 })
//   probe.update(scene, position, { force, near, far }) → true on the call the filtered texture changed
//   probe.texture        the filtered map (null until the first refresh); the same object after every refresh
//   probe.cube           the raw cube render target (tests read it)
//   probe.busy           a refresh is under way
//   probe.dispose()
import * as THREE from '../lib/three.module.min.js';

export function createEnvProbe(renderer, { size = 64 } = {}) {
  const cube = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  cube.texture.name = 'flight.envprobe';
  const rig = new THREE.CubeCamera(0.5, 2e9, cube);
  rig.coordinateSystem = renderer.coordinateSystem; rig.updateCoordinateSystem();
  const pmrem = new THREE.PMREMGenerator(renderer);
  let filtered = null, face = 0, running = false;

  function drawFace(scene, i) {
    const cam = rig.children[i];
    const rt = renderer.getRenderTarget(), cf = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel(), auto = renderer.autoClear, xr = renderer.xr.enabled;
    renderer.xr.enabled = false; renderer.autoClear = true;
    renderer.setRenderTarget(cube, i);
    renderer.render(scene, cam);
    renderer.setRenderTarget(rt, cf, mip);
    renderer.autoClear = auto; renderer.xr.enabled = xr;
  }
  function filter() {
    const rt = renderer.getRenderTarget(), cf = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    filtered = pmrem.fromCubemap(cube.texture, filtered);
    filtered.texture.name = 'flight.envprobe.pmrem';
    renderer.setRenderTarget(rt, cf, mip);
  }

  return {
    cube,
    get texture() { return filtered ? filtered.texture : null; },
    get busy() { return running; },
    update(scene, position, { force = false, near = 0.5, far = 2e9 } = {}) {
      if (!running) { if (!force && filtered) return false; running = true; face = 0; }
      if (face === 0) {
        // the viewpoint is fixed for the whole refresh, so the six faces fit together
        rig.position.copy(position); rig.updateMatrixWorld(true);
        for (const c of rig.children) if (c.near !== near || c.far !== far) { c.near = near; c.far = far; c.updateProjectionMatrix(); }
      }
      if (!filtered) { for (let i = 0; i < 6; i++) drawFace(scene, i); face = 6; }
      else drawFace(scene, face++);
      if (face < 6) return false;
      filter(); running = false; face = 0;
      return true;
    },
    dispose() { cube.dispose(); if (filtered) filtered.dispose(); pmrem.dispose(); filtered = null; },
  };
}
