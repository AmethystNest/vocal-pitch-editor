'use strict';
// Deterministic async races in the real resynthesis/playback control flow.
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
const code = extract('  async function runPendingResynth() {', '  function segmentToPlain(') +
  extract('  function seekTo(t) {', "  $('playBtn').addEventListener('click'");
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
async function scenario(label, interrupt, expectRestart, pauseAtBuffer = false) {
  const render = deferred();
  const buffer = deferred();
  const S = {
    audioSessionId: 1, editRevision: 1, audioRevision: 0, playing: true,
    origChannels: [new Float32Array(400)], editedChannels: [new Float32Array(400)],
    editedBuffer: {duration: 4}, sr: 100, pendingFullResynth: true,
    pendingResynthSet: new Set(), resynthBusy: false, resynthQueued: false,
    playStartOffsetSec: 1, playbackGeneration: 0, previewSegId: null,
    audioCtx: {currentTime: 0, destination: {}, createBufferSource() {
      return {connect() {}, start() {started++;}, stop() {stopped++;}};
    }}
  };
  const document = {hidden: false};
  const buttons = {playBtn: {innerHTML: ''}};
  let started = 0, stopped = 0, rebuilt = 0;
  const context = {
    S, document, $: name => buttons[name],
    getPlayheadTime: () => S.playStartOffsetSec, doFullResynth: () => render.promise,
    doPartialResynth: async () => {},
    rebuildEditedBuffer: async () => {
      rebuilt++;
      if (pauseAtBuffer) await buffer.promise;
      S.editedBuffer = {duration: 4};
    },
    unlockAudio: async () => {}, stopReference() {},
    requestAnimationFrame() {}, tick() {}, toastMsg() {},
    render() {}, clearTimeout() {}, console
  };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.runPendingResynth = runPendingResynth; this.seekTo = seekTo;', context);
  const pending = context.runPendingResynth();
  assert.equal(S.playing, true, `${label}: existing playback continues during render`);
  assert.equal(stopped, 0, `${label}: render does not stop the active source`);
  if (label === 'stop' || label === 'seek' || label === 'hidden' || label === 'new session' || label === 'new playback') interrupt(context, S, document);
  render.resolve();
  if (pauseAtBuffer) {
    // The render has completed and buffer rebuild is pending.
    for (let i = 0; i < 6 && rebuilt === 0; i++) await Promise.resolve();
    assert.equal(rebuilt, 1, `${label}: entered buffer rebuild`);
    interrupt(context, S, document);
    buffer.resolve();
  }
  await pending;
  await Promise.resolve();
  // A seek explicitly starts the user's newly requested playback. The old
  // render must not create a second source or restore the stale position.
  assert.equal(started, expectRestart ? 1 : 0, `${label}: no obsolete playback`);
  if (expectRestart) {
    assert.equal(S.playStartOffsetSec, 1, `${label}: resumes saved position`);
    assert.equal(S.playing, true, `${label}: resumes once`);
  }
  else assert.equal(S.playStartOffsetSec, label === 'seek' ? 2 : 1, `${label}: preserves current playhead`);
}
async function autoPreviewScenario(label, interrupt, expectPreview) {
  const render = deferred();
  const buffer = deferred();
  const S = {
    audioSessionId: 1, editRevision: 1, audioRevision: 0, playing: false,
    origChannels: [new Float32Array(400)], editedChannels: [new Float32Array(400)],
    editedBuffer: {duration: 4}, sr: 100, pendingFullResynth: true,
    pendingResynthSet: new Set(), resynthBusy: false, resynthQueued: false,
    previewSegId: 12, autoPreviewEnabled: true, soloPreviewGeneration: 3,
    segments: [{id: 12, startTime: 1, endTime: 2}]
  };
  let rebuilt = false, previews = 0;
  const document = {hidden: false};
  const context = {
    S, document, getPlayheadTime: () => 0, doFullResynth: () => render.promise,
    doPartialResynth: async () => {},
    rebuildEditedBuffer: async () => { rebuilt = true; await buffer.promise; },
    playSegmentSolo: async () => { previews++; },
    clearTimeout() {}, toastMsg() {}, console
  };
  vm.createContext(context);
  vm.runInContext(extract('  async function runPendingResynth() {', '  function segmentToPlain(') +
    '\nthis.runPendingResynth = runPendingResynth;', context);
  const pending = context.runPendingResynth();
  render.resolve();
  for (let i = 0; i < 6 && !rebuilt; i++) await Promise.resolve();
  assert.equal(rebuilt, true, `${label}: preview buffer rebuild reached`);
  interrupt(S, document);
  buffer.resolve();
  await pending;
  assert.equal(previews, expectPreview ? 1 : 0, `${label}: preview must respect interruption`);
}
(async () => {
  await scenario('normal', () => {}, true);
  await scenario('stop', c => c.stopPlayback(), false);
  await scenario('seek', (c, s) => { c.stopPlayback(true); s.playStartOffsetSec = 2; }, false);
  await scenario('hidden', (c, s, d) => { d.hidden = true; c.stopPlayback(); }, false);
  await scenario('new session', (c, s) => { s.audioSessionId++; c.stopPlayback(); }, false);
  await scenario('new playback', (c, s) => { s.playbackGeneration++; }, true);
  await scenario('buffer rebuild interrupted', c => c.stopPlayback(), false, true);
  await autoPreviewScenario('normal preview', () => {}, true);
  await autoPreviewScenario('hidden preview', (s, d) => { d.hidden = true; s.soloPreviewGeneration++; }, false);
  await autoPreviewScenario('superseded preview', s => { s.soloPreviewGeneration++; }, false);
  await autoPreviewScenario('replaced session preview', s => { s.audioSessionId++; }, false);
  console.log('resynth-playback-regression: PASS (continuous render playback, stop, seek, hidden, session, new play, async buffer swap)');
})().catch(err => { console.error(err); process.exitCode = 1; });
