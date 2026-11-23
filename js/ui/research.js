// Starwright — Research Lab: the tech tree as a node graph.
//   createResearchScreen(app)
//
// The screen opens at the Research Lab (js/ui/interior.js parks the live 3D camera there). Nodes are compact tiles that
// carry the real mesh of their headline part (partmesh thumbnails), joined by squared-off connectors; hovering a node
// shows what it unlocks, clicking selects it for the side panel.
import { el, svg, clear, fmt, icon, uiScale } from './dom.js';
import { TECH_TREE } from '../core/career.js';
import { PARTS, CATEGORIES } from '../core/parts.js';
import { interiorFrame, partIcon } from './interior.js';

const NODE_W = 140, NODE_H = 60, COL = 160, ROW = 88, PAD = 12;
const CAT_NAME = Object.fromEntries(CATEGORIES.map(c => [c.id, c.name]));
const CAT_COLOR = { command: '#ffb347', tanks: '#e8eef4', engines: '#ff7b6b', structure: '#93a3b3', aero: '#6cb6ff', utility: '#39d0c0', science: '#b79cff' };
const CAT_ABBR = { command: 'CMD', tanks: 'TNK', engines: 'ENG', structure: 'STR', aero: 'AER', utility: 'UTL', science: 'SCI' };

const REASONS = {
  owned: 'Already researched.',
  prereq: 'Research the earlier nodes first.',
  science: 'Not enough science yet.',
  unknown: 'Unknown technology.',
};

export function createResearchScreen(app) {
  let frame = null, treeBox = null, treeEl = null, treeHolder = null, side = null, tip = null, meter = null, selected = null, lastKey = '', sized = false;
  const nodeEls = new Map();
  const edgeEls = [];

  const career = () => app.career;
  function stateOf(n) {
    const c = career();
    if (c.tech.has(n.id)) return 'owned';
    return n.requires.every(r => c.tech.has(r)) ? 'available' : 'locked';
  }
  function canUnlock(n) {
    const c = career();
    if (typeof c.canUnlockTech === 'function') return c.canUnlockTech(n.id);
    const st = stateOf(n);
    if (st === 'owned') return { ok: false, reason: 'owned' };
    if (st === 'locked') return { ok: false, reason: 'prereq' };
    if (c.mode !== 'sandbox' && c.science < n.cost) return { ok: false, reason: 'science' };
    return { ok: true, reason: null };
  }
  const stateKey = () => [...career().tech].sort().join(',') + '|' + career().science;

  // Layout: grid coordinates → pixels.
  const xs = TECH_TREE.map(n => n.x), ys = TECH_TREE.map(n => n.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  const px = n => PAD + (n.x - minX) * COL;
  const py = n => PAD + (n.y - minY) * ROW;
  const treeW = PAD * 2 + (maxX - minX) * COL + NODE_W;
  const treeH = PAD * 2 + (maxY - minY) * ROW + NODE_H;
  const byId = Object.fromEntries(TECH_TREE.map(n => [n.id, n]));

  /** The part that stands for a node on its tile: the dearest engine / pod / anything, in that order. */
  function headline(n) {
    const defs = n.parts.map(id => PARTS[id]).filter(Boolean);
    const rank = d => (d.engine ? 3 : d.crew || d.cat === 'command' ? 2 : d.cat === 'science' || d.cat === 'utility' ? 1 : 0) * 1e6 + (d.cost || 0);
    return defs.sort((a, b) => rank(b) - rank(a))[0] || null;
  }
  function nodeIcon(n) {
    // Use the most common category among the node's parts.
    const count = {};
    for (const id of n.parts) { const d = PARTS[id]; if (d) count[d.cat] = (count[d.cat] || 0) + 1; }
    const cat = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    return { command: 'crew', tanks: 'hangar', engines: 'rocket', structure: 'engineer', aero: 'pilot', utility: 'gear', science: 'science' }[cat] || 'star';
  }

  function buildTree() {
    nodeEls.clear(); edgeEls.length = 0;
    const lines = svg('svg', { width: treeW, height: treeH, viewBox: `0 0 ${treeW} ${treeH}` });
    const box = el('div', { class: 'sw-tree', style: { width: treeW + 'px', height: treeH + 'px' } }, lines);
    for (const n of TECH_TREE) {
      for (const rid of n.requires) {
        const r = byId[rid];
        if (!r) continue;
        // squared-off run: out of the parent's right edge, along a vertical bus, into the child's left edge
        let d;
        const y1 = py(r) + NODE_H / 2, y2 = py(n) + NODE_H / 2;
        if (r.x < n.x) {
          const x1 = px(r) + NODE_W, x2 = px(n), bus = x2 - 14 - 5 * ((n.requires.indexOf(rid)) % 2), c = Math.min(7, Math.abs(y2 - y1) / 2), sg = Math.sign(y2 - y1);
          d = sg === 0 ? `M${x1} ${y1} H${x2}` : `M${x1} ${y1} H${bus - c} Q${bus} ${y1} ${bus} ${y1 + sg * c} V${y2 - sg * c} Q${bus} ${y2} ${bus + c} ${y2} H${x2}`;
        } else {
          const x = px(r) + NODE_W / 2, down = r.y < n.y;
          d = `M${x} ${py(r) + (down ? NODE_H : 0)} V${py(n) + (down ? 0 : NODE_H)}`;
        }
        const path = svg('path', { d });
        lines.appendChild(path);
        edgeEls.push({ path, from: r, to: n });
      }
    }
    for (const n of TECH_TREE) {
      const small = el('small'), head = headline(n);
      const node = el('button', { class: 'sw-node', attrs: { type: 'button', 'data-tech': n.id, 'aria-label': n.name },
        style: { left: px(n) + 'px', top: py(n) + 'px' },
        on: { click: () => select(n.id), mouseenter: () => hover(n, node), mouseleave: () => hover(null), focus: () => hover(n, node), blur: () => hover(null) } },
        el('span', { class: 'ico' }, head ? partIcon(app, head, 40) : icon(nodeIcon(n))),
        el('span', { class: 'txt' }, el('b', { text: n.name }), el('span', { class: 'row' }, small, el('span', { class: 'cnt', text: '×' + n.parts.length, tip: n.parts.length + ' parts' }))),
        el('i', { class: 'lamp' }));
      nodeEls.set(n.id, { node, small });
      box.appendChild(node);
    }
    return box;
  }

  function refreshTree() {
    const c = career();
    lastKey = stateKey();
    for (const n of TECH_TREE) {
      const st = stateOf(n);
      const { node, small } = nodeEls.get(n.id);
      const affordable = st === 'available' && canUnlock(n).ok;
      node.className = 'sw-node ' + st + (affordable ? ' affordable' : '') + (selected === n.id ? ' selected' : '');
      node.dataset.state = st;
      small.textContent = st === 'owned' ? 'Researched' : (c.mode === 'sandbox' ? 'Free' : fmt.num(n.cost) + ' sci');
    }
    for (const e of edgeEls) {
      const a = stateOf(e.from), b = stateOf(e.to);
      e.path.setAttribute('class', a === 'owned' && b === 'owned' ? 'owned' : (a === 'owned' && b === 'available' ? 'available' : ''));
    }
    frame.stats.refresh();
    const owned = TECH_TREE.filter(n => c.tech.has(n.id)).length, ready = TECH_TREE.filter(n => canUnlock(n).ok).length;
    frame.setSubtitle(`${owned} of ${TECH_TREE.length} technologies researched`);
    frame.setStatus(c.mode === 'sandbox' ? 'All technology open' : ready ? `${ready} ready to research` : 'Bring back more science', ready ? 'teal' : '');
    if (meter) {
      meter.firstChild.style.width = (owned / TECH_TREE.length * 100).toFixed(1) + '%';
      meter.nextSibling.textContent = `${owned}/${TECH_TREE.length}`;
    }
  }

  // ---- hover card: what a node unlocks, without leaving the tree
  function hover(n, node) {
    if (!tip) return;
    if (!n) { tip.classList.remove('show'); return; }
    clear(tip);
    const st = stateOf(n), parts = n.parts.map(id => PARTS[id]).filter(Boolean);
    tip.append(
      el('div', { class: 'head' }, el('b', { text: n.name }), el('span', { class: 'st ' + st, text: st === 'owned' ? 'Researched' : st === 'available' ? 'Available' : 'Locked' })),
      el('div', { class: 'desc', text: n.desc || '' }),
      el('div', { class: 'icons' }, parts.slice(0, 12).map(d => partIcon(app, d, 30)), parts.length > 12 ? el('span', { class: 'more', text: '+' + (parts.length - 12) }) : null),
      st === 'locked' ? el('div', { class: 'need', text: 'Needs ' + n.requires.filter(r => !career().tech.has(r)).map(r => byId[r] ? byId[r].name : r).join(' + ') }) : '');
    // viewport rectangles → the interface's own (zoomed) pixels
    const z = uiScale(), sc = q => { const b = q.getBoundingClientRect(); return { left: b.left / z, top: b.top / z, bottom: b.bottom / z, width: b.width / z, height: b.height / z }; };
    const wrap = sc(treeBox), r = sc(node);
    const w = 268, x = Math.max(6, Math.min(wrap.width - w - 6, r.left - wrap.left + r.width / 2 - w / 2));
    const below = r.bottom - wrap.top + 150 < wrap.height;
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = below ? Math.round(r.bottom - wrap.top + 8) + 'px' : ''; tip.style.bottom = below ? '' : Math.round(wrap.height - (r.top - wrap.top) + 8) + 'px';
    tip.classList.add('show');
  }

  function partFacts(d) {
    const out = [[fmt.mass((d.mass || 0) * 1000), 'Dry mass']];
    if (d.engine) { out.push([fmt.num(d.engine.thrust) + ' kN', 'Thrust']); if (d.engine.ispVac) out.push([fmt.num(d.engine.ispVac) + ' s', 'Vacuum Isp']); }
    if (d.res) for (const [k, v] of Object.entries(d.res)) if (v) out.push([fmt.num(v), { fuel: 'Fuel', mono: 'Monoprop', xenon: 'Xenon', elec: 'Charge', solid: 'Solid fuel', ox: 'Oxidiser', lox: 'Liquid oxygen', ch4: 'Methane' }[k] || k]);
    if (d.crew) out.push([String(d.crew), d.crew === 1 ? 'Seat' : 'Seats']);
    if (d.wing) out.push([fmt.num(d.wing.area, 1) + ' m²', 'Wing area']);
    return out.slice(0, 4);
  }

  function drawSide() {
    clear(side);
    const n = byId[selected];
    if (!n) { side.appendChild(el('div', { class: 'sw-empty', text: 'Pick a technology to see what it unlocks.' })); return; }
    const c = career();
    const st = stateOf(n);
    const check = canUnlock(n);
    const chip = st === 'owned' ? el('span', { class: 'sw-chip teal' }, 'Researched')
      : st === 'available' ? el('span', { class: 'sw-chip amber' }, 'Available')
        : el('span', { class: 'sw-chip' }, 'Locked');

    const parts = n.parts.map(id => PARTS[id]).filter(Boolean);
    const detail = el('div', { class: 'sw-part-detail', data: { role: 'part-detail' } });
    const show = d => {
      clear(detail);
      for (const t of list.children) t.classList.toggle('on', t.dataset.part === d.id);
      detail.append(
        el('div', { class: 'head' }, el('b', { text: d.name }), el('span', { class: 'cat', text: CAT_ABBR[d.cat] || '', style: { color: CAT_COLOR[d.cat] || '' }, tip: CAT_NAME[d.cat] || d.cat }), el('span', { class: 'cost', text: fmt.funds(d.cost), tip: 'Cost per part' })),
        el('p', { text: d.desc || '' }),
        el('div', { class: 'facts' }, partFacts(d).map(([v, k]) => el('span', null, el('b', { text: v }), k))));
    };
    const list = el('div', { class: 'sw-part-grid sw-scroll' },
      parts.length ? parts.map(d => el('button', { class: 'sw-part', attrs: { type: 'button', 'aria-label': d.name }, data: { part: d.id },
        on: { mouseenter: () => show(d), focus: () => show(d), click: () => show(d) } },
        partIcon(app, d, 46), el('span', { class: 'nm', text: d.name })))
        : el('div', { class: 'sw-empty', text: 'No parts in this node.' }));
    if (parts.length) show(parts[0]);

    let hint = null;
    if (st !== 'owned' && !check.ok) {
      let text = REASONS[check.reason] || 'Cannot research this yet.';
      if (check.reason === 'science') text = `Needs ${fmt.num(n.cost)} science — you have ${fmt.num(c.science, c.science % 1 ? 1 : 0)}. Run experiments and complete milestones to earn more.`;
      if (check.reason === 'prereq') text = 'Requires: ' + n.requires.filter(r => !c.tech.has(r)).map(r => byId[r] ? byId[r].name : r).join(', ') + '.';
      hint = el('div', { class: 'sw-msg warn', text, data: { reason: check.reason } });
    }
    const btn = st === 'owned' ? null : el('button', {
      class: 'sw-btn primary big', disabled: !check.ok, attrs: { type: 'button', 'data-action': 'unlock' },
      on: { click: () => unlock(n) },
    }, icon(check.ok ? 'science' : 'lock'), c.mode === 'sandbox' ? 'Research' : `Research for ${fmt.num(n.cost)} science`);

    side.append(
      el('div', { class: 'sw-ihead' }, el('span', { text: 'Technology' }), el('span', { class: 'id', text: 'T-' + String(TECH_TREE.indexOf(n) + 1).padStart(2, '0') })),
      el('div', { class: 'sw-row', style: { justifyContent: 'space-between', gap: '10px' } }, el('div', { class: 'sw-title big', text: n.name }), chip),
      el('p', { class: 'sw-dim', style: { margin: '4px 0 10px', fontSize: '12.5px' }, text: n.desc || '' }),
      el('div', { class: 'sw-label', style: { marginBottom: '6px' }, text: `Unlocks ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}` }),
      list, detail,
      el('div', { class: 'sw-col', style: { marginTop: '10px' } }, hint, btn));
  }

  function select(id) {
    selected = id;
    refreshTree();
    drawSide();
  }

  function unlock(n) {
    const res = career().unlockTech(n.id);
    if (res && res.ok) {
      app.toast(`${n.name} researched — ${n.parts.length} new ${n.parts.length === 1 ? 'part' : 'parts'} in the hangar.`, 'good');
      app.audio.play('success');
      app.save(true);
    } else {
      app.toast(REASONS[res && res.reason] || 'Cannot research this yet.', 'warn');
    }
    refreshTree();
    drawSide();
  }

  return {
    is3D: true, capturesKeys: false,
    enter(params = {}) {
      sized = false;
      frame = interiorFrame(app, { name: 'research', building: 'research', title: 'Research Lab', code: 'R&D' });
      treeEl = buildTree();
      treeHolder = el('div', { class: 'sw-tree-holder' }, treeEl);
      treeBox = el('div', { class: 'sw-tree-wrap sw-scroll', style: { display: 'flex' } }, treeHolder);
      tip = el('div', { class: 'sw-node-tip', attrs: { 'aria-hidden': 'true' } });
      meter = el('div', { class: 'sw-bar thin' }, el('i'));
      const wrap = el('div', { class: 'sw-ipanel glass sw-grow', style: { position: 'relative', display: 'flex', flexDirection: 'column', minHeight: '0' } },
        el('div', { class: 'sw-ihead' }, el('span', { text: 'Technology tree' }), el('span', { class: 'sw-grow' }),
          el('span', { class: 'sw-legend' },
            el('span', null, el('i', { class: 'owned' }), 'Researched'),
            el('span', null, el('i', { class: 'available' }), 'Available'),
            el('span', null, el('i', { class: 'locked' }), 'Locked')),
          el('span', { class: 'meter' }, meter, el('span', { class: 'id' }))),
        el('div', { class: 'sw-grow', style: { position: 'relative', display: 'flex', minHeight: '0' } }, treeBox, tip));
      side = el('div', { class: 'sw-ipanel sw-side' });
      frame.page.append(wrap, side);
      app.uiRoot.appendChild(frame.root);
      // Start on the cheapest thing you could research next, else the first node.
      const avail = TECH_TREE.filter(n => stateOf(n) === 'available').sort((a, b) => a.cost - b.cost)[0];
      selected = (params.node && byId[params.node] ? params.node : null) || (avail ? avail.id : TECH_TREE[0].id);
      refreshTree();
      drawSide();
      this.resize();
    },
    exit() { if (frame) frame.dispose(); frame = treeBox = treeEl = treeHolder = side = tip = meter = null; },
    // Scale the whole tree to fit the panel (never past 1.3) so no scrolling is needed.
    resize(w, h) {
      if (frame && w) frame.resize(w, h);
      if (!treeBox) return;
      const bw = treeBox.clientWidth - 8, bh = treeBox.clientHeight - 8;
      if (bw <= 0 || bh <= 0) return;
      const k = Math.max(0.74, Math.min(1.3, bw / treeW, bh / treeH));
      treeEl.style.transform = `scale(${k.toFixed(4)})`;
      treeHolder.style.width = Math.ceil(treeW * k) + 'px';
      treeHolder.style.height = Math.ceil(treeH * k) + 'px';
      // a narrow window scrolls sideways rather than shrinking the tiles to nothing: keep the selected node in view
      const sel = nodeEls.get(selected);
      if (sel && treeW * k > bw + 8) treeBox.scrollLeft = Math.max(0, (parseFloat(sel.node.style.left) + NODE_W / 2) * k - bw / 2);
    },
    update(dt) {
      if (!frame) return;
      if (app.input.pressed('Escape')) { app.goto('hub'); return; }
      frame.update(dt);
      if (!sized && treeBox && treeBox.clientWidth > 0) { sized = true; this.resize(); }
      if (stateKey() !== lastKey) { refreshTree(); drawSide(); }
    },
    render() { if (frame) frame.render(); },
  };
}
