// The What's New list: every entry is well formed, the list is in order, and the "what has this player not seen"
// rule does what the pop-up relies on. A pull request that adds an entry badly fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASES, unseen, recent, groupByDay, dayLabel, RECENT_DAYS } from '../../js/ui/whatsnew.js';

test('whatsnew: every entry has a unique id, a real date, a title and text', () => {
  assert.ok(RELEASES.length >= 1);
  const ids = new Set();
  for (const e of RELEASES) {
    assert.match(e.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'id is a short lower-case name: ' + e.id);
    assert.ok(!ids.has(e.id), 'id used once: ' + e.id); ids.add(e.id);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, e.id + ' has a date');
    const d = new Date(e.date + 'T00:00:00Z');
    assert.equal(d.toISOString().slice(0, 10), e.date, e.id + ': the date exists');
    assert.ok(e.title.length >= 5 && e.title.length <= 60 && !/\.$/.test(e.title), e.id + ' has a short title with no full stop');
    assert.ok(e.text.length >= 40 && e.text.length <= 420, e.id + ' has one or two sentences of text');
  }
});

test('whatsnew: newest first', () => {
  for (let i = 1; i < RELEASES.length; i++)
    assert.ok(RELEASES[i].date <= RELEASES[i - 1].date, RELEASES[i].id + ' is not dated after the entry above it');
});

test('whatsnew: no markup other than links, and no long dashes', () => {
  for (const e of RELEASES) for (const s of [e.title, e.text])
    assert.ok(!/[—–*_`#]/.test(s.replace(/\[[^\]]+\]\(https:\/\/[^)\s]+\)/g, '')), e.id + ': ' + s.slice(0, 40));
});

test('whatsnew: unseen is everything above the last entry shown', () => {
  const list = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
  assert.deepEqual(unseen('a', list).map(e => e.id), ['c', 'b']);
  assert.deepEqual(unseen('c', list), []);
  assert.deepEqual(unseen(null, list).map(e => e.id), ['c', 'b', 'a'], 'never shown anything: all of it');
  assert.deepEqual(unseen('gone', list).map(e => e.id), ['c', 'b', 'a'], 'an id no longer in the list: all of it');
  assert.deepEqual(unseen(RELEASES[0].id), [], 'the real list, fully seen');
});

test('whatsnew: entries are grouped by day in order', () => {
  const days = groupByDay([{ id: 'c', date: '2026-12-02' }, { id: 'b', date: '2026-12-02' }, { id: 'a', date: '2026-11-30' }]);
  assert.deepEqual(days.map(d => [d.label, d.entries.map(e => e.id).join()]), [['2 December 2026', 'c,b'], ['30 November 2026', 'a']]);
  assert.equal(groupByDay().reduce((n, d) => n + d.entries.length, 0), RELEASES.length);
  assert.equal(dayLabel('2026-01-09'), '9 January 2026');
});

test('whatsnew: the pop-up lists the newest days, and every day with something unseen', () => {
  const list = [];
  for (let d = 10; d >= 1; d--) for (const n of ['b', 'a']) list.push({ id: `d${d}${n}`, date: `2026-12-${String(d).padStart(2, '0')}` });
  const days = l => [...new Set(l.map(e => e.date.slice(8)))].join();
  assert.equal(days(recent('d10b', list, 6)), '10,09,08,07,06,05', 'up to date: six days of history');
  assert.equal(days(recent('d10a', list, 6)), '10,09,08,07,06,05', 'one new entry: still six days');
  assert.equal(recent('d10a', list, 6).length, 12, 'whole days, not cut part-way');
  assert.equal(days(recent('d3a', list, 6)), '10,09,08,07,06,05,04,03', 'away for longer: back to the oldest unseen day');
  assert.equal(recent(null, list, 6).length, 20, 'never shown anything: all of it');
  assert.equal(recent('d10b', list.slice(0, 4), 6).length, 4, 'a short list: all of it');
  assert.ok(RECENT_DAYS >= 5, 'several releases are shown');
  assert.ok(recent(RELEASES[0].id).length >= Math.min(RELEASES.length, 2));
});
