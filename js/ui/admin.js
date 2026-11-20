// Starwright — Administration: facility upgrades, the program ledger, settings and the way out.
//   createAdminScreen(app)        registered as app.screens.admin by js/ui/hub.js
//
// Facilities (career games): each building has three levels (js/core/career.js FACILITIES). An upgrade costs funds and
// lifts one limit: pad and runway mass, parts per design, the tracking station's reach, the research bonus, crew beds.
// Science and sandbox games run with everything at the top level.
import { el, clear, fmt, icon, isModalOpen } from './dom.js';
import { FACILITIES, FACILITY_IDS, FACILITY_MAX, MILESTONES, TECH_TREE } from '../core/career.js';
import { interiorFrame } from './interior.js';
import { downloadText } from './careerui.js';

const FAC_ICON = { pad: 'rocket', hangar: 'hangar', runway: 'pilot', tracking: 'dish', lab: 'lab', crew: 'crew' };
const dist = m => (m >= 1e9 ? fmt.num(m / 1e9, m >= 1e10 ? 0 : 1) + ' Gm' : m >= 1e6 ? fmt.num(m / 1e6) + ' Mm' : fmt.num(m / 1e3) + ' km');
/** A facility limit in words, e.g. facilityValue('pad', 40) → "40 t". */
export function facilityValue(id, v) {
  if (v === Infinity) return 'no limit';
  if (id === 'tracking') return dist(v);
  if (id === 'lab') return '+' + Math.round(v * 100) + '%';
  if (id === 'crew') return v + ' Pips';
  if (id === 'hangar') return v + ' parts';
  return v + ' t';
}
const EFFECT = {
  pad: 'Heaviest rocket the pad will bear', hangar: 'Most parts in one design', runway: 'Heaviest aircraft the runway will bear',
  tracking: 'Reach of the ground station (beyond it a vessel needs its own dish)', lab: 'Bonus on all science banked', crew: 'Beds in the Crew Quarters',
};

export function createAdminScreen(app) {
  let frame = null, facBox = null, ledger = null, lastKey = '', hubMod = null;
  const key = () => { const c = app.career; return [Math.floor(c.funds), c.science, c.reputation, FACILITY_IDS.map(id => c.facilityLevel(id)).join(''), c.mode].join('|'); };

  function drawFacilities() {
    const c = app.career;
    clear(facBox);
    if (!c.usesFunds) {
      facBox.appendChild(el('div', { class: 'sw-msg', data: { role: 'fac-note' }, style: { color: 'var(--sw-dim)', marginBottom: '4px' },
        text: 'This program has no budget, so every building is already at its best. Start a Career game to earn and spend on upgrades.' }));
    }
    for (const id of FACILITY_IDS) {
      const f = FACILITIES[id], info = c.facilityInfo(id), level = c.usesFunds ? info.level : FACILITY_MAX, top = !c.usesFunds || info.cost === null;
      const afford = !top && c.canAfford(info.cost);
      const lv = el('span', { class: 'lv', tip: `Level ${level} of ${FACILITY_MAX}` });
      for (let i = 1; i <= FACILITY_MAX; i++) lv.appendChild(el('i', { class: i <= level ? 'on' : '' }));
      const now = c.usesFunds ? info.value : c.limitOf(id);
      facBox.appendChild(el('div', { class: 'sw-fac' + (top ? ' max' : ''), data: { facility: id, level: String(level) } },
        el('span', { class: 'ico' }, icon(FAC_ICON[id] || 'star')),
        el('div', { class: 'nm' }, f.name, lv),
        el('div', { class: 'ds' }, EFFECT[id] + ': ', el('b', { text: facilityValue(id, id === 'lab' && !c.usesFunds ? 0 : now) }),
          top ? null : ' → ', top ? null : el('em', { text: facilityValue(id, info.next) })),
        top ? el('span', { class: 'sw-chip teal', style: { gridColumn: '3', gridRow: '1 / span 2' }, text: 'Top level' })
          : el('button', { class: 'sw-btn small' + (afford ? ' primary' : ''), disabled: !afford, attrs: { type: 'button', 'data-action': 'upgrade' },
            tip: afford ? `Upgrade to level ${level + 1}` : `Needs ${fmt.funds(info.cost)}`,
            on: { click: async () => {
              if (!(await app.confirm(`Upgrade the ${f.name}?`, `${EFFECT[id]}: ${facilityValue(id, info.value)} → ${facilityValue(id, info.next)}. This costs ${fmt.funds(info.cost)}.`, { okLabel: 'Upgrade' })) || !frame) return;
              const r = c.upgradeFacility(id);
              if (r.ok) { app.toast(`${f.name} upgraded to level ${r.level}.`, 'good'); app.audio.play('success'); if (app.world) app.world.commGroundRange = c.limitOf('tracking'); app.save(true); }
              else app.toast(r.reason === 'funds' ? 'Not enough funds.' : 'That cannot be upgraded.', 'warn');
              draw();
            } } }, 'Upgrade · ' + fmt.funds(info.cost))));
    }
  }

  function drawLedger() {
    const c = app.career;
    clear(ledger);
    const cell = (v, k) => el('div', null, el('b', { text: v }), k);
    const p = fmt.dateParts(c.ut || 0);
    ledger.append(
      cell(c.mode === 'career' ? fmt.num(c.funds) : '—', 'Funds'),
      cell(`${TECH_TREE.filter(n => c.tech.has(n.id)).length}/${TECH_TREE.length}`, 'Technologies'),
      cell(`${c.milestones.size}/${MILESTONES.length}`, 'Milestones'),
      cell(`Y${p.year} D${p.day}`, 'Verda date'));
  }

  function draw() {
    lastKey = key();
    drawFacilities(); drawLedger();
    frame.stats.refresh();
    const c = app.career, up = c.usesFunds ? FACILITY_IDS.filter(id => { const i = c.facilityInfo(id); return i.cost !== null && c.canAfford(i.cost); }).length : 0;
    frame.setSubtitle({ career: 'Career program', science: 'Science program', sandbox: 'Sandbox program' }[c.mode] || '');
    frame.setStatus(up ? `${up} upgrade${up === 1 ? '' : 's'} affordable` : '', 'teal');
  }

  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  return {
    is3D: true, capturesKeys: false,
    async enter() {
      if (!app.career) { app.goto('title'); return; }
      frame = interiorFrame(app, { name: 'admin', building: 'admin', title: 'Administration', code: 'ADM' });
      facBox = el('div', { class: 'sw-fac-list sw-scroll' });
      ledger = el('div', { class: 'sw-ledger' });
      const settingsBox = el('div', { class: 'sw-scroll sw-grow', style: { minHeight: '0', paddingRight: '4px' } });
      const btn = (action, ico, label, tip, fn) => el('button', { class: 'sw-btn small', attrs: { type: 'button', 'data-menu': action }, tip, on: { click: fn } }, icon(ico), label);
      const menu = el('div', { class: 'sw-admin-menu' },
        btn('controls', 'keyboard', 'Controls', 'Keyboard and mouse reference', () => hubMod && hubMod.openControls()),
        btn('settings', 'gear', 'All settings', 'Sound, graphics, hints and save files', () => hubMod && hubMod.openSettings(app).then(() => { if (frame) fillSettings(); })),
        btn('save', 'save', 'Save game', 'The game also saves by itself as you go', () => app.save(false)),
        btn('export', 'download', 'Export save', 'Download your program as a .json file', () => { app.save(true); downloadText(`starwright-${app.career.mode}-${stamp()}.json`, app.career.exportSave()); app.toast('Save file written to your downloads.', 'good'); }),
        btn('title', 'exit', 'Main menu', 'Save and return to the title screen', () => app.exitToTitle()));
      const fillSettings = () => { clear(settingsBox); if (hubMod) settingsBox.appendChild(hubMod.settingsRows(app)); };
      frame.page.appendChild(el('div', { class: 'sw-admin' },
        el('div', { class: 'col' },
          el('div', { class: 'sw-ipanel sw-grow' }, el('div', { class: 'sw-ihead' }, el('span', { text: 'Facilities' }), el('span', { class: 'id', text: 'upgrades cost funds' })), facBox)),
        el('div', { class: 'col' },
          el('div', { class: 'sw-ipanel' }, el('div', { class: 'sw-ihead' }, el('span', { text: 'Program' })), ledger, menu),
          el('div', { class: 'sw-ipanel sw-grow' }, el('div', { class: 'sw-ihead' }, el('span', { text: 'Settings' })), settingsBox))));
      app.uiRoot.appendChild(frame.root);
      draw();
      const mine = frame;
      try { hubMod = await import('./hub.js'); } catch { hubMod = null; }
      if (frame === mine) fillSettings();
    },
    exit() { if (frame) frame.dispose(); frame = facBox = ledger = null; if (app.career) { app.applySettings(); } },
    render() { if (frame) frame.render(); },
    resize(w, h) { if (frame) frame.resize(w, h); },
    update(dt) {
      if (!frame) return;
      if (app.input.pressed('Escape') && !isModalOpen()) { app.goto('hub'); return; }
      frame.update(dt);
      if (key() !== lastKey) draw();
    },
  };
}
