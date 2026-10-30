import test from 'node:test';
import assert from 'node:assert/strict';
import {heatLevel,durationText,validateBackup} from '../frontend/core.mjs';

test('seven heatmap bands include exact boundaries and long study days',()=>{
  for(const [seconds,level] of [[0,0],[1,1],[1799,1],[1800,2],[7199,2],[7200,3],[14399,3],[14400,4],[21599,4],[21600,5],[28799,5],[28800,6],[86400,6]]) {
    assert.equal(heatLevel(seconds),level,`${seconds}s should belong to band ${level}`);
  }
});

test('English compact durations retain meaningful sub-minute times',()=>{
  for(const [seconds,text] of [[0,'0min'],[1,'<1min'],[59,'<1min'],[60,'1min'],[1799,'29min'],[3600,'1h'],[9000,'2h 30min'],[86400,'24h']]) {
    assert.equal(durationText(seconds),text);
  }
});

test('Comet still accepts legacy version-1 backups and user notes verbatim',()=>{
  const records={'2026-10-10':{seconds:7200,note:'数学 · 阅读'}};
  assert.deepEqual(validateBackup({version:1,goal:60,records},'2026-10-10'),{goal:60,records});
});
