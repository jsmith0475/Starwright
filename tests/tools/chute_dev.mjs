// Parachute descent, printed. node tests/tools/chute_dev.mjs [--chute chute] [--pod pod_acorn] [--alt 6000] [--vx 0] [--vy -150] [--body verda] [--every 0.5] [--extra tank_m400,...]
import { World, SYSTEM, Vector3 } from '../verify/harness.mjs';
import { Craft } from '../../js/core/craft.js';
import { TUNING } from '../../js/core/vessel.js';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const body = SYSTEM.byId[arg('body', 'verda')], alt0 = +arg('alt', 6000), every = +arg('every', 0.5);
const c = new Craft('Drop');
const [pod] = c.setRoot(arg('pod', 'pod_acorn'));
const chute = arg('chute', 'chute');
if (chute.includes('radial')) c.attachRadial(chute, pod.id, pod.pos.y + 0.1, 0, 2); else c.attachStack(chute, pod.id, 'top');
let below = pod;
for (const id of arg('extra', 'heatshield_m').split(',').filter(Boolean)) [below] = c.attachStack(id, below.id, 'bottom');
c.autoStage();
const w = new World();
const r = body.radius + alt0, wy = 2 * Math.PI / body.rotPeriod;
const v = w.spawn(c, { crew: ['Ada'], body, pos: new Vector3(r, 0, 0), vel: new Vector3(+arg('vy', -150), 0, -wy * r + +arg('vx', 0)) });
v.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(1, 0, 0));
v.ctrl.sas = arg('sas', '1') === '1';
while (v.chuteParts.some(p => p.deployed === 'stowed')) v.activateNextStage();
console.log(`mass ${v.mass.toFixed(0)} kg on ${body.name}`);
let next = 0, peakG = 0, peakT = 0, last = '';
const ev = [];
for (let t = 0; t < +arg('time', 400) && !v.landed && !v.dead; t += 0.02) {
  w.step(0.02);
  peakG = Math.max(peakG, v.gForce); peakT = Math.max(peakT, v.chuteTension || 0);
  const p = v.chuteParts[0], st = p ? p.deployed + (p.chuteWait ? ':' + p.chuteWait : '') : '-';
  if (t >= next || st !== last) {
    next = t + every; last = st;
    const cv = p && v.chuteView(p), up = v.pos.clone().normalize().applyQuaternion(v.q.clone().invert());
    const lean = cv ? Math.acos(Math.max(-1, Math.min(1, cv.x * up.x + cv.y * up.y + cv.z * up.z))) * 57.3 : 0;
    const tilt = Math.acos(Math.max(-1, Math.min(1, up.y))) * 57.3;
    console.log(`${t.toFixed(2).padStart(7)} s  alt ${v.radarAlt.toFixed(0).padStart(6)}  v ${v.airspeed.toFixed(1).padStart(6)}  vs ${v.verticalSpeed.toFixed(1).padStart(7)}  M ${(v._envMach || 0).toFixed(2)}  ${st.padEnd(10)} fill ${(p ? p.deployT : 0).toFixed(2)}  T ${((v.chuteTension || 0) / 1000).toFixed(1).padStart(7)} kN  load ${((v.chuteLoad || 0) * 100).toFixed(0).padStart(3)}%  g ${v.gForce.toFixed(2)}  line off vertical ${lean.toFixed(1)}  craft tilt ${tilt.toFixed(1)}${cv ? `  canopy ${(cv.shape.rm * 2).toFixed(1)} m wide, ${cv.shape.L.toFixed(1)} m up` : ''}`);
  }
}
console.log(`end: ${v.dead ? 'DESTROYED' : v.landed ? 'landed' : 'flying'}  peak g ${peakG.toFixed(2)}  peak line load ${(peakT / 1000).toFixed(1)} kN`);
