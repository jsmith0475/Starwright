// Development bench for the booster guidance (not a test): builds the test booster and exposes helpers.
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';

export const home = SYSTEM.home;
/** A first stage on its own: guidance ring, grid fins at the top, legs at the bottom. */
export function boosterCraft() {
  const c = new Craft('Test booster');
  const [core] = c.setRoot('probe_wisp');
  let cur = core, top = null, low = null;
  for (const t of ['tank_m800', 'tank_m200', 'eng_goshawk']) { const [p] = c.attachStack(t, cur.id, 'bottom'); if (!p) throw new Error('attach ' + t); if (t === 'tank_m800') top = p; if (t === 'tank_m200') low = p; cur = p; }
  c.attachRadial('fin_grid', top.id, top.pos.y + 0.8, Math.PI / 4, 4);
  c.attachRadial('leg_sprig', low.id, low.pos.y - 0.2, Math.PI / 4, 4);
  c.autoStage();
  return c;
}
/** A first stage on four Heron folding legs: guidance ring, tanks, Goshawk, grid fins. */
export function heronBooster() {
  const c = new Craft('Heron booster');
  const [core] = c.setRoot('probe_wisp');
  let cur = core, top = null, low = null;
  for (const t of ['tank_m800', 'tank_m400', 'eng_goshawk']) { const [p] = c.attachStack(t, cur.id, 'bottom'); if (!p) throw new Error('attach ' + t); if (t === 'tank_m800') top = p; if (t === 'tank_m400') low = p; cur = p; }
  c.attachRadial('fin_grid', top.id, top.pos.y + 0.8, Math.PI / 4, 4);
  const legs = c.attachRadial('leg_heron', low.id, low.pos.y - 3.75 / 2 + 1.9, Math.PI / 4, 4);   // hinge 10 cm above the foot of the tank
  if (legs.length !== 4) throw new Error('four legs');
  c.autoStage();
  return c;
}
/** The booster placed in flight: alt (m), speed (m/s), pitch above the horizon (deg) heading east, `east` m downrange, fuel fraction. */
export function dropped({ alt = 30000, speed = 1000, pitch = 45, east = 20000, fuel = 0.25, craft = boosterCraft() } = {}) {
  const w = new World();
  const v = w.launch(craft, { crew: [] });
  const R = home.radius, lon = east / R;
  const dirS = home.dirFromLatLon(0, lon), dir = home.surfaceDirToInertial(dirS, w.ut);
  const eastV = new Vector3().crossVectors(new Vector3(0, 1, 0), dir).normalize();
  const pos = dir.clone().multiplyScalar(R + alt);
  const g = pitch * Math.PI / 180;
  const wy = 2 * Math.PI / home.rotPeriod;
  const vel = dir.clone().multiplyScalar(speed * Math.sin(g)).addScaledVector(eastV, speed * Math.cos(g));
  vel.x += wy * pos.z; vel.z -= wy * pos.x;                    // surface-relative → inertial
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vel.clone().normalize());
  w.vessels.length = 0;
  w.spawn(v, { body: home, pos, vel, q });
  w.active = v;
  for (const p of v.partList) for (const k of ['fuel', 'ox']) if (p.res[k] !== undefined) p.res[k] = (p.def.res[k] || 0) * fuel;
  v._massDirty = true; v._updateMass && v._updateMass();
  v.activateNextStage && w.stage(v);
  v.ctrl.throttle = 0;
  v.updateTelemetry(w.ut);
  return { w, v };
}
