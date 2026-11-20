// The science reference: the TeX converter, and that every chapter, equation and worked number is sound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { texToMathML, texToText } from '../../js/ui/tex.js';
import { CHAPTERS, scienceContext, parseBody, parseInline } from '../../js/ui/sciencetext.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { G0 } from '../../js/core/parts.js';

const ctx = scienceContext(SYSTEM, G0);

test('tex: fractions, roots, scripts, accents and Greek become MathML', () => {
  const m = texToMathML(String.raw`\Delta v = v_e \ln\frac{m_0}{m_1}`, { display: true });
  assert.match(m, /^<math [^>]*display="block"/);
  assert.match(m, /<mi>Δ<\/mi><mi>v<\/mi><mo>=<\/mo><msub><mi>v<\/mi><mi>e<\/mi><\/msub>/);
  assert.match(m, /<mfrac><mrow><msub><mi>m<\/mi><mn>0<\/mn><\/msub><\/mrow><mrow><msub><mi>m<\/mi><mn>1<\/mn><\/msub><\/mrow><\/mfrac>/);
  assert.match(texToMathML(String.raw`\sqrt[3]{x}`), /<mroot><mrow><mi>x<\/mi><\/mrow><mrow><mn>3<\/mn><\/mrow><\/mroot>/);
  assert.match(texToMathML(String.raw`\ddot{\mathbf{r}}`), /<mover accent="true"><mrow><mi mathvariant="bold" class="bf">r<\/mi><\/mrow><mo>¨<\/mo><\/mover>/);
  assert.match(texToMathML('x_1^2'), /<msubsup><mi>x<\/mi><mn>1<\/mn><mn>2<\/mn><\/msubsup>/);
  assert.match(texToMathML(String.raw`\int_0^T a\,dt`, { display: true }), /<msubsup><mo>∫<\/mo><mn>0<\/mn><mi>T<\/mi><\/msubsup>/);
  assert.match(texToMathML(String.raw`\sum_{k} x_k`, { display: true }), /<munder><mo>∑<\/mo>/);
  assert.match(texToMathML(String.raw`\left(\frac{a}{b}\right)`), /<mo>\(<\/mo><mrow><mfrac>/);
  assert.match(texToMathML('v = 2,337'), /<mn>2,337<\/mn>/, 'a number with a thousands comma stays one number');
  assert.match(texToMathML('a < b'), /&lt;/, 'angle brackets are escaped');
});

test('tex: anything unknown or unbalanced throws, so a typo cannot ship', () => {
  assert.throws(() => texToMathML(String.raw`\notacommand x`), /unknown command/);
  assert.throws(() => texToMathML(String.raw`\frac{a}{b`), /missing }/);
  assert.throws(() => texToMathML('a}'), /unexpected }/);
  assert.throws(() => texToMathML(String.raw`\left( x`), /without/);
  assert.throws(() => texToMathML('x^1^2'), /double superscript/);
});

test('tex: the spoken form drops the markup', () => {
  assert.equal(texToText(String.raw`\mu = G M`), 'μ = G M');
  assert.equal(texToText(String.raw`v_e\,\ln\frac{m_0}{m_1}`), 'v_e ln frac m_0 m_1');
});

test('science: the chapters cover the subject and each has a unique id, title and lead', () => {
  assert.ok(CHAPTERS.length >= 10);
  assert.equal(new Set(CHAPTERS.map(c => c.id)).size, CHAPTERS.length);
  for (const want of ['gravity', 'conics', 'visviva', 'kepler', 'rocket', 'maneuvers', 'transfers', 'ascent', 'atmosphere', 'landing', 'rendezvous', 'numerics']) {
    assert.ok(CHAPTERS.some(c => c.id === want), 'chapter ' + want);
  }
  for (const c of CHAPTERS) { assert.ok(c.title.length > 5 && c.lead.length > 20, c.id); }
});

test('science: every equation and inline formula converts, and no computed number is missing', () => {
  let equations = 0, words = 0;
  for (const ch of CHAPTERS) {
    const body = ch.body(ctx);
    assert.doesNotMatch(body, /undefined|NaN|\[object|Infinity/, ch.id + ': a computed value is missing');
    const blocks = parseBody(body);
    assert.ok(blocks.filter(b => b.type === 'h').length >= 3, ch.id + ' has sections');
    assert.ok(blocks.filter(b => b.type === 'eq').length >= 2, ch.id + ' has equations');
    assert.ok(blocks.some(b => b.type === 'game'), ch.id + ' says what the game does');
    for (const b of blocks) {
      if (b.type === 'eq') { equations++; assert.doesNotThrow(() => texToMathML(b.text, { display: true }), ch.id + ': ' + b.text); continue; }
      if (b.type === 'calc') { assert.ok(['rocket', 'transfer'].includes(b.text), 'calculator ' + b.text); continue; }
      const spans = parseInline(b.text);
      for (const s of spans) {
        if (s.math !== undefined) assert.doesNotThrow(() => texToMathML(s.math), ch.id + ': ' + s.math);
        else words += String(s.t || s.b || s.i).split(/\s+/).length;
      }
      const rest = spans.filter(s => s.math === undefined).map(s => s.t || s.b || s.i).join('');
      assert.doesNotMatch(rest, /[$\\]|\*\*/, ch.id + ': stray markup in "' + b.text.slice(0, 60) + '"');
    }
  }
  assert.ok(equations >= 60, equations + ' displayed equations');
  assert.ok(words >= 5000, words + ' words: a real explanation, not a glossary');
});

test('science: the worked numbers agree with the game\'s own worlds and orbit code', () => {
  const { home, moon, star, far, parkAlt } = ctx;
  assert.equal(home, SYSTEM.home);
  const r = home.radius + parkAlt;
  // circular speed and period against the game's Orbit class
  const o = moon.orbit;
  assert.ok(Math.abs(ctx.period(home.gm, o.a) - o.period) / o.period < 1e-9);
  assert.ok(Math.abs(ctx.vcirc(home, parkAlt) - Math.sqrt(home.gm / r)) < 1e-9);
  assert.ok(Math.abs(ctx.vesc(home, parkAlt) / ctx.vcirc(home, parkAlt) - Math.SQRT2) < 1e-12);
  // Hohmann: the transfer ellipse really touches both orbits (vis-viva at each end) and energy rises monotonically outward
  const h = ctx.hohmann(star.gm, home.orbit.a, far.orbit.a);
  assert.ok(Math.abs(h.a - (home.orbit.a + far.orbit.a) / 2) < 1);
  assert.ok(Math.abs(h.vp * home.orbit.a - h.va * far.orbit.a) / (h.vp * home.orbit.a) < 1e-12, 'angular momentum is the same at both ends');
  assert.ok(Math.abs((h.vp * h.vp / 2 - star.gm / home.orbit.a) - (-star.gm / (2 * h.a))) < 1e-3, 'energy is −μ/2a');
  assert.ok(h.dv1 > 0 && h.dv2 > 0 && h.tof > 0);
  // ejection: with no excess speed the burn is exactly escape minus circular
  assert.ok(Math.abs(ctx.eject(home, parkAlt, 0) - (ctx.vesc(home, parkAlt) - ctx.vcirc(home, parkAlt))) < 1e-9);
  // the sphere of influence quoted is the one the game patches at
  assert.ok(Math.abs(home.soi - home.orbit.a * Math.pow(home.gm / star.gm, 0.4)) < 1e-3);
  assert.match(CHAPTERS.find(c => c.id === 'transfers').body(ctx), new RegExp((home.soi / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })));
});
