'use strict';
// Isolated control-flow regression; actual browser/Safari behavior needs E2E.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const start = source.indexOf('  async function playSegmentSolo(seg) {');
const end = source.indexOf('\n  function seekTo(', start);
assert(start >= 0 && end > start, 'solo implementation not found');
const code = source.slice(start, end);
const eventStart = source.indexOf("  document.addEventListener('visibilitychange', () => {");
const eventEnd = source.indexOf("  window.addEventListener('pageshow'", eventStart);
assert(eventStart >= 0 && eventEnd > eventStart, 'visibilitychange listener not found');
const eventCode = source.slice(eventStart, eventEnd);
const pending = [];
const S = {origChannels: [new Float32Array(1)], editedBuffer: {duration: 3}, soloPreviewGeneration: 0};
const listeners = {};
const document = {hidden: false, addEventListener(name, callback) {listeners[name] = callback;}};
let started = 0, stopped = 0, cancelled = 0, playbackStopped = 0, referenceStopped = 0;
S.audioCtx = {destination: {}, createBufferSource: () => ({connect() {}, start() {started++;}, stop() {stopped++;}})};
const context = {S, document, WORKER_IS_IOS: false, worker: {},
  cancelActiveInteraction: () => {cancelled++;}, stopPlayback: () => {playbackStopped++;},
  stopReference: () => {referenceStopped++;}, rebuildEditedBuffer: async () => {},
  unlockAudio: () => new Promise(resolve => pending.push(resolve))};
vm.createContext(context);
vm.runInContext(eventCode + code + '\nthis.playSegmentSolo = playSegmentSolo;', context);
const seg = {startTime: .5, endTime: 1};
(async () => {
  const first = context.playSegmentSolo(seg);
  assert.equal(pending.length, 1, 'first preview must wait for audio unlock');
  document.hidden = true;
  listeners.visibilitychange();
  assert.equal(cancelled, 1, 'hidden event cancels interactions');
  assert.equal(playbackStopped, 1, 'hidden event stops normal playback');
  assert.equal(referenceStopped, 1, 'hidden event stops reference playback');
  pending.shift()();
  await first;
  assert.equal(started, 0, 'backgrounded stale preview must not start');
  document.hidden = false;
  const second = context.playSegmentSolo(seg);
  pending.shift()();
  await second;
  assert.equal(started, 1, 'fresh foreground preview should start');
  document.hidden = true;
  listeners.visibilitychange();
  assert.equal(stopped, 1, 'hidden event must stop active solo source');
  assert.equal(S.soloSource, null, 'hidden event must clear active solo source');
  document.hidden = false;
  const third = context.playSegmentSolo(seg);
  const fourth = context.playSegmentSolo(seg);
  pending.shift()();
  await third;
  assert.equal(started, 1, 'superseded preview must not start');
  pending.shift()();
  await fourth;
  assert.equal(started, 2, 'latest preview should start');
  console.log('solo-background-regression: PASS (isolated visibility listener and async control flow)');
})().catch(err => {console.error(err); process.exitCode = 1;});
