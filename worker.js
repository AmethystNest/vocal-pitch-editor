importScripts('./engine.js');

self.onmessage = function (e) {
  const msg = e.data;
  try {
    if (msg.type === 'analyze') {
      const pitchTrack = PitchEngine.yinPitchTrack(msg.signal, msg.sr, msg.opts || undefined);
      const segments = PitchEngine.segmentNotes(pitchTrack);
      self.postMessage({ type: 'analyzed', id: msg.id, pitchTrack, segments });
    } else if (msg.type === 'resynth') {
      const channels = PitchEngine.resynthesize(msg.channels, msg.sr, msg.pitchTrack, msg.segments);
      self.postMessage({ type: 'resynthed', id: msg.id, channels }, channels.map(c => c.buffer));
    } else if (msg.type === 'reference') {
      const refPitchTrack = PitchEngine.yinPitchTrack(msg.refSignal, msg.refSr, msg.opts || undefined);
      const { suggestions, expressions, alignXs, alignYs, alignRefXs, alignRefYs } = PitchEngine.suggestFromReference(msg.vocalPitchTrack, msg.vocalSegments, refPitchTrack);
      self.postMessage(
        { type: 'referenced', id: msg.id, suggestions, expressions, alignXs, alignYs, alignRefXs, alignRefYs, refPitchTrack },
        [alignXs.buffer, alignYs.buffer, alignRefXs.buffer, alignRefYs.buffer, refPitchTrack.times.buffer, refPitchTrack.f0s.buffer, refPitchTrack.voiced.buffer, refPitchTrack.clarity.buffer]
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.stack || err) });
  }
};
