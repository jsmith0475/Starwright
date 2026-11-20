// Starwright — Mission Board: contracts, milestones and the science archive.
//   createMissionsScreen(app)      enter({ tab: 'contracts' | 'milestones' | 'science' })
import { el, clear, fmt, icon } from './dom.js';
import { interiorFrame } from './interior.js';
import { MILESTONES, EXPERIMENTS } from '../core/career.js';
import { VERDA_DAY } from '../core/contracts.js';
import { rewardChip } from './careerui.js';

const BODY_NAMES = { helion: 'Helion', cindra: 'Cindra', verda: 'Verda', pell: 'Pell', ost: 'Ost', rusk: 'Rusk', thal: 'Thal', tiv: 'Tiv' };
const SITUATION_LABEL = {
  landed: 'Landed', splashed: 'Splashed down', flyingLow: 'Flying low', flyingHigh: 'Flying high',
  spaceLow: 'Low space', spaceHigh: 'High space',
};
const CONTRACT_KIND = {
  reach: ['Altitude', 'rocket'], test: ['Part test', 'gear'], science: ['Science', 'science'], flag: ['Flag', 'flag'],
  recover: ['Recovery', 'target'], orbit: ['Orbit', 'orbit'], tour: ['Crew tour', 'crew'], satellite: ['Satellite', 'dish'], explore: ['Exploration', 'compass'],
};
const title = s => String(s || '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

/** "crew_report@verda:landed" → { experiment, body, situation } (tolerant of other separators). */
export function parseScienceKey(key) {
  const m = /^([^@:|/]+)[@:|/]([^@:|/]+)[@:|/](.+)$/.exec(String(key));
  if (!m) return { experiment: String(key), body: '', situation: '' };
  return { experiment: m[1], body: m[2], situation: m[3] };
}

/** "12 days" / "3h 20m" for a span of game time. */
function span(seconds) {
  if (!(seconds > 0)) return '0s';
  const days = seconds / VERDA_DAY;
  if (days >= 2) return Math.floor(days) + ' days';
  return fmt.time(seconds).replace(/ \d+s$/, '');
}

export function createMissionsScreen(app) {
  let frame = null, content = null, tabs = null, banner = null, program = null, tab = 'contracts', lastKey = '', showHistory = false, programOpen = false, spotlight = false;

  const board = () => app.career.contracts;
  const key = () => {
    const c = app.career, b = board();
    const k = b ? [b.offered.map(x => x.id).join(','), b.active.map(x => x.id + x.objectives.filter(o => o.done).length).join(','), b.completed.length, b.failed.length, b.maxActive].join('/') : '';
    return [tab, c.milestones.size, Object.keys(c.scienceLog).length, c.science, k, Math.floor(c.funds), c.reputation, Math.floor((c.ut || 0) / 600), c.grantOffer() ? 1 : 0, showHistory, programOpen].join('|');
  };

  // ------------------------------------------------------------------ program grant (safety net)
  function drawBanner() {
    clear(banner);
    const c = app.career;
    const g = typeof c.grantOffer === 'function' ? c.grantOffer() : null;
    banner.classList.toggle('sw-hidden', !g);
    if (!g) return;
    banner.append(
      (() => { const i = icon('funds'); i.style.color = 'var(--sw-amber)'; return i; })(),
      el('div', { class: 'sw-grow' },
        el('b', { text: 'Program grant available' }),
        el('div', { text: `The coffers cannot cover even the cheapest rocket (${fmt.funds(g.need)}). The Verda Council will put up ${fmt.funds(g.amount)} to keep the program flying. It will be noted in the minutes (−${g.repCost} reputation).` })),
      el('button', { class: 'sw-btn primary', attrs: { type: 'button', 'data-action': 'grant' }, on: { click: () => {
        const r = c.acceptGrant();
        if (r.ok) { app.toast('Grant received: ' + fmt.funds(r.amount) + '. Spend it wisely.', 'good'); app.audio.play('success'); app.save(true); }
        draw();
      } } }, 'Accept ' + fmt.funds(g.amount)));
  }

  // ------------------------------------------------------------------ the flight program (fixed chain of milestone missions)
  function payChips(r) {
    return [r.funds ? rewardChip('amber', 'funds', fmt.num(r.funds), 'Funds when it is flown') : null,
      r.science ? rewardChip('teal', 'science', fmt.num(r.science), 'Science when it is flown') : null,
      r.rep ? rewardChip('violet', 'rep', '+' + fmt.num(r.rep), 'Reputation when it is flown') : null];
  }
  function drawProgram() {
    clear(program);
    const c = app.career, st = c.programStatus(), next = st.next;
    program.classList.toggle('spot', spotlight);
    program.classList.toggle('open', programOpen);
    const chapter = next ? st.steps.filter(s => s.chapter === next.chapter) : [];
    const head = el('div', { class: 'sw-program-head' },
      el('span', { class: 'sw-label', text: 'Flight program' }),
      el('span', { class: 'sw-program-chapter', text: next ? next.chapter : 'Complete', data: { role: 'program-chapter' } }),
      el('div', { class: 'sw-bar thin green sw-grow' }, el('i', { style: { width: (st.total ? st.done / st.total * 100 : 0).toFixed(1) + '%' } })),
      el('span', { class: 'sw-value', text: `${st.done} / ${st.total}`, data: { role: 'program-count' } }),
      el('button', { class: 'sw-btn ghost small', attrs: { type: 'button', 'data-action': 'program-all' }, tip: 'Every mission of the program, from the first launch to the far worlds',
        on: { click: () => { programOpen = !programOpen; draw(); } } }, programOpen ? 'Show less' : 'Whole program'));
    program.appendChild(head);
    if (!next) {
      program.appendChild(el('div', { class: 'sw-program-next' }, el('div', { class: 'sw-grow' }, el('h3', { text: 'Every mission is flown' }),
        el('p', { text: 'From the first launch to the far worlds: the whole program is complete.' }))));
    } else {
      const modeNote = c.mode === 'career' ? '' : c.mode === 'science' ? 'Science mode: missions pay science only.' : 'Sandbox: missions are tracked, nothing needs paying for.';
      program.appendChild(el('div', { class: 'sw-program-next', data: { programNext: next.id } },
        el('div', { class: 'sw-program-num', text: String(next.index + 1) }),
        el('div', { class: 'sw-grow' },
          el('div', { class: 'sw-program-kicker', text: 'Next mission' }),
          el('h3', { text: next.title }),
          el('p', { text: next.desc }),
          next.how ? el('p', { class: 'how', text: next.how }) : null),
        el('div', { class: 'sw-program-side' },
          el('div', { class: 'sw-rewards' }, payChips(c.programRewards(next))),
          modeNote ? el('div', { class: 'sw-dim', data: { role: 'program-mode' }, text: modeNote }) : null,
          el('div', { class: 'sw-dim', text: 'No signing, no deadline: fly it and it counts.' }))));
      program.appendChild(el('div', { class: 'sw-program-steps' }, chapter.map(s => el('span', {
        class: 'sw-program-step' + (s.done ? ' done' : s.id === next.id ? ' next' : ''), data: { programStep: s.id, done: s.done ? '1' : '0' }, tip: s.desc },
        el('i', { text: s.done ? '✓' : String(s.index + 1) }), s.title))));
    }
    if (programOpen) {
      const list = el('div', { class: 'sw-program-all sw-scroll', data: { role: 'program-list' } });
      let chap = '';
      for (const s of st.steps) {
        if (s.chapter !== chap) { chap = s.chapter; list.appendChild(el('div', { class: 'sw-label', text: chap })); }
        list.appendChild(el('div', { class: 'sw-program-row' + (s.done ? ' done' : next && s.id === next.id ? ' next' : ''), data: { programStep: s.id, done: s.done ? '1' : '0' } },
          el('i', { text: s.done ? '✓' : String(s.index + 1) }),
          el('div', { class: 'sw-grow' }, el('b', { text: s.title }), el('span', { text: s.desc })),
          el('div', { class: 'sw-rewards' }, payChips(c.programRewards(s)))));
      }
      program.appendChild(list);
    }
  }

  // ------------------------------------------------------------------ contracts
  function rewardRow(k, { advance = true } = {}) {
    return el('div', { class: 'sw-rewards' },
      advance && k.advance ? rewardChip('', 'funds', fmt.num(k.advance) + ' now', 'Advance: paid when you accept') : null,
      k.reward.funds ? rewardChip('amber', 'funds', fmt.num(k.reward.funds), 'Paid on completion') : null,
      k.reward.science ? rewardChip('teal', 'science', fmt.num(k.reward.science, k.reward.science % 1 ? 1 : 0), 'Science on completion') : null,
      k.reward.rep ? rewardChip('violet', 'rep', '+' + fmt.num(k.reward.rep), 'Reputation on completion') : null);
  }

  function head(k) {
    const [kind, ico] = CONTRACT_KIND[k.type] || [title(k.type), 'contract'];
    const dots = el('span', { class: 'sw-diff', tip: ['', 'Routine', 'Demanding', 'Hard', 'Expedition'][k.difficulty] || 'Routine' });
    for (let i = 1; i <= 4; i++) dots.appendChild(el('i', { class: i <= (k.difficulty || 1) ? 'on' : '' }));
    return [
      el('div', { class: 'sw-contract-top' }, el('span', { class: 'sw-chip teal' }, icon(ico), kind),
        k.bodyId && k.bodyId !== 'verda' ? el('span', { class: 'sw-chip', text: BODY_NAMES[k.bodyId] || k.bodyId }) : null, dots),
      el('h3', { text: k.title }),
      el('div', { class: 'sw-contract-client', text: 'for ' + k.agency }),
    ];
  }

  function objectives(k) {
    return el('ul', { class: 'sw-objectives' }, k.objectives.map(o => el('li', { class: o.done ? 'done' : '', data: { done: o.done ? '1' : '0' } },
      (() => { const i = icon(o.done ? 'check' : 'open'); return i; })(), el('span', { text: o.label }))));
  }

  function offerCard(k) {
    const b = board(), c = app.career;
    const full = b.active.length >= b.maxActive;
    const left = k.expiresAt != null ? k.expiresAt - (c.ut || 0) : null;
    return el('div', { class: 'sw-contract offer', data: { contract: k.id, type: k.type } },
      ...head(k),
      el('p', { text: k.text }),
      objectives(k),
      rewardRow(k),
      el('div', { class: 'sw-contract-foot' },
        el('span', { class: 'sw-dim' }, icon('clock'),
          (k.days ? `${k.days} days to finish` : 'No deadline') + (left != null ? ` · offer open ${span(left)}` : '')),
        el('span', { class: 'sw-grow' }),
        el('button', { class: 'sw-btn ghost small', attrs: { type: 'button', 'data-action': 'decline' }, tip: 'Take it off the board; something else will be posted',
          on: { click: () => { b.decline(k.id); app.save(true); draw(); } } }, 'Decline'),
        el('button', { class: 'sw-btn primary small', disabled: full, attrs: { type: 'button', 'data-action': 'accept' },
          tip: full ? `You can run ${b.maxActive} contracts at once. Finish one first (reputation raises the limit).` : `Sign: ${fmt.funds(k.advance)} is paid now`,
          on: { click: () => {
            const r = b.accept(k.id);
            if (r.ok) { app.toast(`Signed: ${k.title}. Advance ${fmt.funds(k.advance)} received.`, 'good'); app.audio.play('success'); app.save(true); }
            else app.toast(r.reason === 'full' ? 'Your contract book is full.' : 'That contract is no longer available.', 'warn');
            draw();
          } } }, 'Accept')));
  }

  function activeCard(k) {
    const b = board(), c = app.career;
    const done = k.objectives.filter(o => o.done).length, total = k.objectives.length;
    const left = k.deadlineAt != null ? k.deadlineAt - (c.ut || 0) : null;
    const frac = k.deadlineAt != null && k.days ? Math.max(0, Math.min(1, left / (k.days * VERDA_DAY))) : 1;
    const urgent = left != null && frac < 0.25;
    return el('div', { class: 'sw-contract active' + (urgent ? ' urgent' : ''), data: { contract: k.id, type: k.type } },
      ...head(k),
      objectives(k),
      el('div', { class: 'sw-row', style: { gap: '10px' } },
        el('div', { class: 'sw-bar thin sw-grow' + (done === total ? ' green' : '') }, el('i', { style: { width: (total ? done / total * 100 : 0).toFixed(0) + '%' } })),
        el('span', { class: 'sw-dim', style: { fontSize: '12px', fontVariantNumeric: 'tabular-nums' }, text: `${done} / ${total}` })),
      rewardRow(k, { advance: false }),
      el('div', { class: 'sw-contract-foot' },
        el('span', { class: urgent ? 'sw-amber' : 'sw-dim', data: { role: 'deadline' } }, icon('clock'), left == null ? 'No deadline' : left > 0 ? span(left) + ' left' : 'Overdue'),
        el('span', { class: 'sw-grow' }),
        el('button', { class: 'sw-btn ghost small', attrs: { type: 'button', 'data-action': 'cancel' }, tip: 'Give the job up',
          on: { click: async () => {
            const sure = await app.confirm('Cancel this contract?',
              `"${k.title}" will be marked as failed. You repay the advance of ${fmt.funds(k.penalty.funds)} and lose ${k.penalty.rep} reputation.`,
              { okLabel: 'Cancel the contract', cancelLabel: 'Keep it', danger: true });
            if (!sure || !frame) return;
            const r = b.cancel(k.id);
            if (r.ok) { app.toast('Contract cancelled: ' + k.title, 'warn'); app.save(true); }
            draw();
          } } }, 'Cancel')));
  }

  function historyRow(k) {
    const ok = k.state === 'completed';
    const label = ok ? 'Completed' : k.reason === 'cancelled' ? 'Cancelled' : 'Missed deadline';
    const [kind] = CONTRACT_KIND[k.type] || [title(k.type)];
    return el('div', { class: 'sw-history-row', data: { contract: k.id, outcome: ok ? 'completed' : 'failed' } },
      (() => { const i = icon(ok ? 'check' : 'open'); i.style.color = ok ? 'var(--sw-green)' : 'var(--sw-red)'; return i; })(),
      el('div', { class: 'sw-grow' }, el('b', { text: k.title }),
        el('div', { class: 'sw-dim', text: `${kind} · ${k.agency} · ${fmt.date(k.closedAt || 0).replace(/, \d\d:\d\d:\d\d$/, '')}` })),
      el('span', { class: 'sw-chip ' + (ok ? 'green' : 'red'), text: label }),
      el('span', { class: 'sw-history-pay ' + (ok ? 'sw-amber' : 'sw-red'), text: ok ? fmt.funds(k.advance + k.reward.funds) : (k.paidBack ? '−' + fmt.num(k.paidBack) : '—') }));
  }

  function drawContracts() {
    const c = app.career, b = board();
    if (c.mode !== 'career' || !b) {
      content.appendChild(el('div', { class: 'sw-ipanel sw-grow', style: { display: 'grid', placeItems: 'center' } },
        el('div', { class: 'sw-empty' },
          el('div', { class: 'sw-title', text: 'Contracts are part of Career mode' }),
          el('p', { style: { marginTop: '6px', maxWidth: '460px' }, data: { role: 'career-only' },
            text: `Paid contracts need a budget, and a ${c.mode === 'science' ? 'Science' : 'Sandbox'} program has none. The flight program above is tracked in every mode and always names your next mission; milestones and the science archive are in the other tabs. For paid work, start a Career game from the title screen.` }))));
      return;
    }
    // a deadline that ran out while the player was at the Flight Center is said out loud, not just filed under History
    for (const n of b.refresh()) if (n && n.outcome === 'failed') { app.toast(n.title + (n.funds ? '  ·  −' + fmt.funds(Math.abs(n.funds)) : '') + (n.rep ? '  −' + Math.abs(n.rep) + ' reputation' : ''), 'bad', 8000); app.save(true); }
    const history = [...b.completed, ...b.failed].sort((x, y) => (y.closedAt || 0) - (x.closedAt || 0));
    const factor = b.fundsFactor;
    const offers = el('div', { class: 'sw-contract-col sw-ipanel' },
      el('div', { class: 'sw-col-head sw-ihead' }, el('span', { text: 'Contracts on offer' }),
        el('span', { class: 'id', style: { marginLeft: '0' }, text: `${b.offered.length} posted` }),
        el('span', { class: 'sw-grow' }),
        el('span', { class: 'sw-chip violet', tip: 'Reputation raises contract fees, the number of offers and how many contracts you can run at once', data: { role: 'rep-factor' } },
          icon('rep'), `Fees ${factor >= 1 ? '+' : '−'}${Math.abs(Math.round((factor - 1) * 100))}%`)),
      el('div', { class: 'sw-contract-list sw-scroll' },
        b.offered.length ? b.offered.map(offerCard) : el('div', { class: 'sw-empty', text: 'Nothing posted right now. Fly something and check back.' })));

    const toggle = (id, label, n) => el('button', { class: 'sw-tab' + ((id === 'history') === showHistory ? ' active' : ''), attrs: { type: 'button', 'data-sub': id },
      on: { click: () => { showHistory = id === 'history'; draw(); } } }, label, el('small', { text: String(n) }));
    const right = el('div', { class: 'sw-contract-col narrow sw-ipanel' },
      el('div', { class: 'sw-col-head sw-ihead' }, el('span', { text: 'Contract book' }), el('span', { class: 'sw-grow' }),
        el('div', { class: 'sw-tabs small' }, toggle('active', 'Active', `${b.active.length}/${b.maxActive}`), toggle('history', 'History', history.length))),
      el('div', { class: 'sw-contract-list sw-scroll' },
        showHistory
          ? (history.length ? history.map(historyRow) : el('div', { class: 'sw-empty', text: 'No finished contracts yet.' }))
          : (b.active.length ? b.active.map(activeCard)
            : el('div', { class: 'sw-empty' }, el('div', { class: 'sw-title', text: 'No active contracts' }),
              el('p', { style: { marginTop: '6px' }, text: `Accept up to ${b.maxActive} offers. Progress is tracked while you fly; you will hear about it the moment an objective is met.` })))));
    content.appendChild(el('div', { class: 'sw-contracts' }, offers, right));
  }

  // ------------------------------------------------------------------ milestones
  function drawMilestones() {
    const c = app.career;
    const done = MILESTONES.filter(m => c.milestones.has(m.id));
    const open = MILESTONES.filter(m => !c.milestones.has(m.id));
    const pct = MILESTONES.length ? done.length / MILESTONES.length : 0;
    const head = el('div', { class: 'sw-progress' },
      el('span', { class: 'sw-label', text: 'Completed' }),
      el('div', { class: 'sw-bar green' }, el('i', { style: { width: (pct * 100).toFixed(1) + '%' } })),
      el('span', { class: 'sw-value', text: `${done.length} / ${MILESTONES.length}`, data: { role: 'milestone-count' } }));
    const card = (m, isDone) => el('div', { class: 'sw-mission' + (isDone ? ' done' : ''), data: { milestone: m.id, done: isDone ? '1' : '0' } },
      el('h3', null, (() => { const i = icon(isDone ? 'check' : 'open'); i.style.color = isDone ? 'var(--sw-green)' : 'var(--sw-amber)'; return i; })(), m.title),
      el('p', { text: m.desc }),
      el('div', { class: 'sw-rewards' },
        isDone ? el('span', { class: 'sw-chip green', text: 'Completed' }) : null,
        c.mode === 'career' && m.funds ? rewardChip('amber', 'funds', fmt.num(m.funds)) : null,
        c.mode !== 'sandbox' && m.science ? rewardChip('teal', 'science', fmt.num(m.science)) : null,
        c.mode === 'career' && m.rep ? rewardChip('violet', 'rep', '+' + fmt.num(m.rep)) : null));
    const grid = el('div', { class: 'sw-cards sw-scroll sw-grow' },
      open.map(m => card(m, false)), done.map(m => card(m, true)));
    content.append(el('div', { class: 'sw-ipanel glass sw-grow', style: { display: 'flex', flexDirection: 'column', minHeight: '0' } },
      el('div', { class: 'sw-ihead' }, el('span', { text: 'Program milestones' }), el('span', { class: 'sw-grow' }), head), grid));
  }

  // ------------------------------------------------------------------ science archive
  function drawScience() {
    const c = app.career;
    const rows = Object.entries(c.scienceLog || {}).map(([k, points]) => {
      const p = parseScienceKey(k);
      const exp = EXPERIMENTS[p.experiment];
      let full = null;
      try { const v = c.scienceValue(p.experiment, p.body, p.situation); if (v && v.valid !== false) full = v.full; } catch { /* unknown key */ }
      return { key: k, points: Number(points) || 0, full,
        experiment: exp ? exp.name : title(p.experiment), body: BODY_NAMES[p.body] || title(p.body), situation: SITUATION_LABEL[p.situation] || title(p.situation) };
    }).sort((a, b) => b.points - a.points);
    const total = rows.reduce((s, r) => s + r.points, 0);

    const head = el('div', { class: 'sw-progress' },
      el('span', { class: 'sw-label', text: 'Science gathered' }),
      el('span', { class: 'sw-value teal big', text: fmt.num(total, total % 1 ? 1 : 0), data: { role: 'science-total' } }),
      el('span', { class: 'sw-dim', text: `from ${rows.length} ${rows.length === 1 ? 'result' : 'results'}` }));
    const panel = el('div', { class: 'sw-ipanel sw-grow', style: { display: 'flex', flexDirection: 'column', minHeight: '0' } },
      el('div', { class: 'sw-ihead' }, el('span', { text: 'Science archive' }), el('span', { class: 'sw-grow' }), head));
    content.appendChild(panel);

    if (!rows.length) {
      panel.appendChild(el('div', { class: 'sw-grow', style: { display: 'grid', placeItems: 'center' } },
        el('div', { class: 'sw-empty' },
          el('div', { class: 'sw-title', text: 'The archive is empty' }),
          el('p', { style: { marginTop: '6px', maxWidth: '420px' },
            text: 'Run experiments in flight — crew reports, thermometers, sample jars — in different places and situations. Every new combination is worth science.' }))));
      return;
    }
    const table = el('table', { class: 'sw-table' },
      el('thead', null, el('tr', null,
        el('th', { text: 'Experiment' }), el('th', { text: 'World' }), el('th', { text: 'Situation' }),
        el('th', { class: 'num', text: 'Earned' }), el('th', { text: 'Completeness', style: { width: '200px' } }))),
      el('tbody', null, rows.map(r => {
        const frac = r.full ? Math.min(1, r.points / r.full) : null;
        return el('tr', { data: { key: r.key } },
          el('td', { text: r.experiment }), el('td', { text: r.body }), el('td', { text: r.situation }),
          el('td', { class: 'num', text: fmt.num(r.points, 1) }),
          el('td', null, frac == null ? '—' : el('div', { class: 'sw-row' },
            el('div', { class: 'sw-bar sw-grow' + (frac > 0.95 ? ' green' : '') }, el('i', { style: { width: (frac * 100).toFixed(0) + '%' } })),
            el('span', { class: 'sw-dim', style: { width: '38px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, text: fmt.pct(frac) }))));
      })));
    panel.appendChild(el('div', { class: 'sw-scroll sw-grow', style: { minHeight: '0' } }, table));
  }

  function draw() {
    clear(content);
    for (const b of tabs.children) b.classList.toggle('active', b.dataset.tab === tab);
    if (tab === 'contracts') drawContracts(); else if (tab === 'milestones') drawMilestones(); else drawScience();
    drawBanner();
    drawProgram();
    frame.stats.refresh();
    const c = app.career, b = board();
    const bits = [`${c.milestones.size} of ${MILESTONES.length} milestones`];
    if (c.mode === 'career' && b) bits.unshift(`${b.active.length} active ${b.active.length === 1 ? 'contract' : 'contracts'}`);
    frame.setSubtitle(bits.join(' · '));
    if (c.mode === 'career' && b) frame.setStatus(c.grantOffer() ? 'Grant waiting' : b.active.length ? `${b.active.length} of ${b.maxActive} contracts running` : b.offered.length ? `${b.offered.length} offers on the board` : 'Board is quiet', c.grantOffer() || b.active.length ? 'amber' : b.offered.length ? 'teal' : '');
    else frame.setStatus('');
    lastKey = key();
  }

  return {
    is3D: true, capturesKeys: false,
    enter(params = {}) {
      const c = app.career;
      tab = ['contracts', 'milestones', 'science'].includes(params.tab) ? params.tab : (c.mode === 'career' ? 'contracts' : 'milestones');
      showHistory = false; programOpen = false; spotlight = params.spotlight === 'program';
      frame = interiorFrame(app, { name: 'missions', building: 'missions', title: 'Mission Control', code: 'MCC' });
      const mk = (id, ico, label) => el('button', { class: 'sw-tab', attrs: { type: 'button' }, data: { tab: id },
        on: { click: () => { tab = id; draw(); } } }, icon(ico), label);
      tabs = el('div', { class: 'sw-tabs' },
        mk('contracts', 'contract', 'Contracts'), mk('milestones', 'board', 'Milestones'), mk('science', 'science', 'Science Archive'));
      for (const s of tabs.querySelectorAll('svg')) { s.style.width = '15px'; s.style.height = '15px'; }
      banner = el('div', { class: 'sw-grant sw-hidden', data: { role: 'grant' } });
      content = el('div', { class: 'sw-missions' });
      program = el('div', { class: 'sw-program sw-ipanel', data: { role: 'program' } });
      frame.page.appendChild(el('div', { class: 'sw-missions' }, program, el('div', { class: 'sw-mc-strip' }, tabs), banner, content));
      app.uiRoot.appendChild(frame.root);
      draw();
    },
    exit() { if (frame) frame.dispose(); frame = content = tabs = banner = program = null; },
    render() { if (frame) frame.render(); },
    resize(w, h) { if (frame) frame.resize(w, h); },
    update(dt) {
      if (!frame) return;
      if (app.input.pressed('Escape')) { app.goto('hub'); return; }
      frame.update(dt);
      if (key() !== lastKey) draw();
    },
  };
}
