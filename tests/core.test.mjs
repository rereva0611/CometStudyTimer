import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const coreURL = new URL('../frontend/core.mjs', import.meta.url);
assert.ok(existsSync(coreURL), '学习记录、日期与计时领域功能尚未实现');
const c = await import(coreURL);

test('calendar includes every actual date of leap year in weekday positions', () => {
  const cells = c.calendarCells(2024);
  assert.equal(cells.filter(Boolean).length, 366);
  assert.equal(cells.find(x => x?.key === '2024-02-29').weekday, 4);
  assert.equal(cells.length % 7, 0);
});
test('invalid and future manual dates are rejected', () => {
  assert.throws(() => c.setRecord({}, '2026-02-30', 120, '', 'replace', '2026-10-10'));
  assert.throws(() => c.setRecord({}, '2026-10-11', 120, '', 'replace', '2026-10-10'));
  assert.throws(() => c.setRecord({}, '2026-10-10', -1, '', 'replace', '2026-10-10'));
});
test('manual addition and replacement have different results', () => {
  let records = c.setRecord({}, '2026-10-10', 3600, '数学', 'add', '2026-10-10');
  records = c.setRecord(records, '2026-10-10', 1800, '阅读', 'add', '2026-10-10');
  assert.equal(records['2026-10-10'].seconds, 5400);
  records = c.setRecord(records, '2026-10-10', 1200, '', 'replace', '2026-10-10');
  assert.equal(records['2026-10-10'].seconds, 1200);
  assert.throws(() => c.setRecord(records, '2026-10-10', 86400, '', 'add', '2026-10-10'));
});
test('timer crosses local midnight and splits time between dates', () => {
  const from = new Date(2026, 9, 9, 23, 50).getTime();
  const to = new Date(2026, 9, 10, 0, 10).getTime();
  assert.deepEqual(c.splitInterval(from, to), {'2026-10-09':600000,'2026-10-10':600000});
});
test('paused time is excluded and resumed state survives JSON round trip', () => {
  const start = new Date(2026, 9, 10, 10).getTime();
  let timer = c.startTimer(c.emptyTimer(), start);
  timer = c.pauseTimer(timer, start + 600000);
  assert.equal(c.timerMilliseconds(timer, start + 1200000), 600000);
  timer = c.startTimer(JSON.parse(JSON.stringify(timer)), start + 1800000);
  assert.equal(c.timerMilliseconds(timer, start + 2100000), 900000);
  const result = c.finishTimer({}, timer, start + 2100000, '2026-10-10');
  assert.equal(result['2026-10-10'].seconds, 900);
});
test('current streak includes yesterday when today is still empty', () => {
  const records = {'2026-10-08':{seconds:100},'2026-10-09':{seconds:200},'2026-10-05':{seconds:300}};
  const stats = c.statistics(records, '2026-10-10');
  assert.equal(stats.streak, 2);
  assert.equal(stats.longest, 2);
  assert.equal(stats.total, 600);
  assert.equal(stats.week, 600);
});
test('backup rejects bad dates, durations, future dates and wrong versions', () => {
  for(const b of [
    {version:2,records:{}},
    {version:1,records:{'2026-02-30':{seconds:60}}},
    {version:1,records:{'2026-10-10':{seconds:'60'}}},
    {version:1,records:{'2026-10-10':{seconds:86401}}},
    {version:1,records:{'2027-01-01':{seconds:10}}},
    {version:1,records:[]},
  ]) assert.throws(() => c.validateBackup(b, '2026-10-10'));
  assert.deepEqual(c.validateBackup({version:1,records:{'2026-10-10':{seconds:60,note:'读书'}}}, '2026-10-10').records,
    {'2026-10-10':{seconds:60,note:'读书'}});
});
test('timer state validation rejects corrupt persisted timestamps', () => {
  assert.equal(c.validTimer({startedAt:'bad',allocations:{}}), false);
  assert.equal(c.validTimer({startedAt:null,allocations:{'2026-02-30':200}}), false);
  assert.equal(c.validTimer(c.emptyTimer()), true);
});
