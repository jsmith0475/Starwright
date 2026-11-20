// The About screen's text: the sections are there, say how the game was made, and carry the not-affiliated statement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ABOUT, REPO_URL } from '../../js/ui/about.js';

const all = ABOUT.map(s => s.title + '\n' + s.paras.join('\n')).join('\n');

test('about: the five sections, each with a title and text', () => {
  assert.deepEqual(ABOUT.map(s => s.id), ['what', 'ksp1', 'ksp2', 'made', 'legal']);
  for (const s of ABOUT) {
    assert.ok(s.title.length > 5, s.id + ' has a title');
    assert.ok(s.paras.length >= 2 && s.paras.every(p => typeof p === 'string' && p.length > 40), s.id + ' has paragraphs');
  }
});

test('about: tells the history and says how Starwright was made', () => {
  for (const word of ['Kerbal Space Program', 'Kerbal Space Program 2', '2011', '2015', '2019', '2023', '2024', 'Jerry Smith', 'Claude', 'Grok', 'MIT License'])
    assert.ok(all.includes(word), 'mentions ' + word);
  assert.match(all, /still on sale and still played/);
  assert.match(all, /not written by hand/);
});

test('about: the not-affiliated statement names all four', () => {
  const legal = ABOUT.find(s => s.id === 'legal').paras.join(' ');
  assert.match(legal, /not affiliated with or endorsed by the makers of Kerbal Space Program or by SpaceX/);
  assert.match(legal, /not affiliated with or endorsed by Anthropic or xAI/);
  assert.ok(legal.includes(`](${REPO_URL})`), 'links the repository');
});

test('about: no markup other than links, and no long dashes', () => {
  for (const s of ABOUT) for (const p of s.paras) {
    assert.ok(!/[—–*_`#]/.test(p.replace(/\[[^\]]+\]\(https:\/\/[^)\s]+\)/g, '')), s.id + ': ' + p.slice(0, 40));
  }
});
