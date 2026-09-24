'use strict';
// Isolated async lifecycle regression. Browser and physical Safari remain separate checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
function extract(from, until) {
  const start = source.indexOf(from);
  const end = source.indexOf(until, start);
  assert(start >= 0 && end > start, `missing source boundary: ${from}`);
  return source.slice(start, end);
}
const referenceCode = extract('  async function playReference() {', '  // Generic monotonic-time interpolation');
const playbackCode = extract('  async function startPlayback(skipFlush = false) {', "  $('playBtn').addEventListener('click'");
const visibilityCode = extract("  document.addEventListener('visibilitychange', () => {", "  window.addEventListener('pageshow'");
const pending = [];
const listeners = {};
const document = {hidden: false, addEventListener(name, fn) { listeners[name] = fn; }};
const buttons = {refPlayBtn: {}, playBtn: {}};
const S = {
  audioSessionId: 1, referenceRequestId: 1, referenceBuffer: {duration: 3},
  origChannels: [new Float32Array(1)], editedBuffer: {duration: 3},
  refAlignXs: null, playing: false, refPlaying: false, playStartOffsetSec: 0,
  audioRevision: 0, editRevision: 0, pendingResynthSet: new Set(),
  audioCtx: {currentTime: 0, destination: {}, createBufferSource() {
    return {connect() {}, start() {started++;}, stop() {stopped++;}};
  }}
};
let started = 0, stopped = 0;
const context = {
  S, document, $: name => buttons[name],
  unlockAudio: () => new Promise(resolve => pending.push(resolve)),
  getPlayheadTime: () => 0, mapVocalTimeToRefTime: () => 0,
  requestAnimationFrame() {}, tick() {}, toastMsg() {},
  rebuildEditedBuffer: async () => {}, flushResynth: async () => {},
  WORKER_IS_IOS: false, worker: {}, cancelActiveInteraction() {},
};
vm.createContext(context);
vm.runInContext(referenceCode + playbackCode + visibilityCode +
  '\nthis.playReference = playReference; this.startPlayback = startPlayback;', context);
async function resolveNext() {
  assert(pending.length, 'expected pending audio unlock');
  pending.shift()();
  await Promise.resolve();
}
(async () => {
  const oldReference = context.playReference();
  document.hidden = true;
  listeners.visibilitychange();
  await resolveNext();
  await oldReference;
  assert.equal(started, 0, 'hidden reference must not start');
  document.hidden = false;
  const newReference = context.playReference();
  await resolveNext();
  await newReference;
  assert.equal(started, 1, 'fresh reference playback starts');
  const obsoleteReference = context.playReference();
  const latestReference = context.playReference();
  await resolveNext();
  await obsoleteReference;
  assert.equal(started, 1, 'superseded reference must not start');
  await resolveNext();
  await latestReference;
  assert.equal(started, 2, 'latest reference starts');
  const oldMain = context.startPlayback();
  document.hidden = true;
  listeners.visibilitychange();
  await resolveNext();
  await oldMain;
  assert.equal(started, 2, 'hidden main playback must not start');
  document.hidden = false;
  const pendingMain = context.startPlayback();
  context.stopPlayback();
  await resolveNext();
  await pendingMain;
  assert.equal(started, 2, 'cancelled main playback must not start');
  const newMain = context.startPlayback();
  await resolveNext();
  await newMain;
  assert.equal(started, 3, 'fresh main playback starts');
  assert.equal(S.playing, true);
  console.log('playback-background-regression: PASS (main/reference background, cancellation and supersession)');
})().catch(err => { console.error(err); process.exitCode = 1; });
