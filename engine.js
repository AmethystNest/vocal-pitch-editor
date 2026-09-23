/**
 * Pitch editing core engine: YIN pitch detection, note segmentation,
 * and a grain-schedule TD-PSOLA resynthesizer driven by per-segment
 * manual pitch shifts (instead of auto key-snapping).
 *
 * Ported/adapted from the vocal_corrector_js prototype. The current PSOLA
 * path has since been extended with waveform-following source marks, transient
 * protection and cycle-domain interpolation, so inherited benchmark numbers
 * are not presented as validation of this newer implementation. The PSOLA
 * ratio computation is swapped from "snap to nearest
 * scale note" to "apply the shift of whichever user-edited segment covers
 * this instant", which is a minimal change to the validated resynthesis
 * path. Grain placement is computed once (from the shared mono analysis)
 * and replayed per channel so stereo images don't comb-filter.
 */
(function (root) {
  'use strict';

  // ============================================================
  // YIN pitch detection
  // ============================================================
  function differenceFunction(frame, maxLag) {
    const n = frame.length;
    const df = new Float64Array(maxLag);
    const energy = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) energy[i + 1] = energy[i] + frame[i] * frame[i];
    const totalEnergy = energy[n];
    for (let tau = 1; tau < maxLag; tau++) {
      let acf = 0;
      const limit = n - tau;
      for (let i = 0; i < limit; i++) acf += frame[i] * frame[i + tau];
      const e = tau < n ? totalEnergy - energy[tau] : 0;
      const eShift = tau < n ? energy[n - tau] : 0;
      df[tau] = e + eShift - 2 * acf;
    }
    df[0] = 0;
    return df;
  }

  function cumulativeMeanNormalizedDifference(df) {
    const cmndf = new Float64Array(df.length);
    cmndf[0] = 1.0;
    let runningSum = 0;
    for (let tau = 1; tau < df.length; tau++) {
      runningSum += df[tau];
      cmndf[tau] = runningSum > 0 ? (df[tau] * tau) / runningSum : 1.0;
    }
    return cmndf;
  }

  function absoluteThreshold(cmndf, threshold, minLag) {
    for (let tau = minLag; tau < cmndf.length - 1; tau++) {
      if (cmndf[tau] < threshold) {
        while (tau + 1 < cmndf.length && cmndf[tau + 1] < cmndf[tau]) tau++;
        return tau;
      }
    }
    return -1;
  }

  function parabolicInterpolation(cmndf, tau) {
    if (tau <= 0 || tau >= cmndf.length - 1) return tau;
    const s0 = cmndf[tau - 1], s1 = cmndf[tau], s2 = cmndf[tau + 1];
    const denom = s0 - 2 * s1 + s2;
    if (denom === 0) return tau;
    return tau + 0.5 * (s0 - s2) / denom;
  }

  // Repair only short, isolated octave errors before segmentation/resynthesis.
  // A real octave jump persists on one side of the frame; a YIN octave mistake is
  // typically surrounded by two anchors that agree with each other. Keeping this
  // conservative avoids "correcting" intentional octave melodies.
  function stabilizeOctaveErrors(f0s, voiced, clarity) {
    const n = f0s.length;
    if (n < 3) return;
    const midi = new Float64Array(n);
    for (let i = 0; i < n; i++) midi[i] = voiced[i] && f0s[i] > 0 ? freqToMidi(f0s[i]) : NaN;

    function nearestVoiced(start, step, maxDist) {
      for (let d = 1; d <= maxDist; d++) {
        const j = start + step * d;
        if (j < 0 || j >= n) break;
        if (voiced[j] && f0s[j] > 0) return j;
      }
      return -1;
    }

    // Two passes let a two-frame octave burst collapse without touching sustained jumps.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        if (!voiced[i] || !(f0s[i] > 0)) continue;
        const li = nearestVoiced(i, -1, 3);
        const ri = nearestVoiced(i, +1, 3);
        if (li < 0 || ri < 0) continue;
        const lm = midi[li], rm = midi[ri], cm = midi[i];
        if (!Number.isFinite(lm) || !Number.isFinite(rm) || !Number.isFinite(cm)) continue;
        if (Math.abs(lm - rm) > 1.6) continue; // anchors disagree: probably a genuine transition
        const anchor = 0.5 * (lm + rm);
        const delta = cm - anchor;
        const octaves = Math.round(delta / 12);
        if (octaves === 0 || Math.abs(octaves) > 2) continue;
        const residual = Math.abs(delta - 12 * octaves);
        if (residual > 1.35) continue;
        // If the current frame is exceptionally clearer than both anchors, leave it alone.
        const cc = clarity && clarity.length ? clarity[i] : 0;
        const ac = clarity && clarity.length ? Math.max(clarity[li] || 0, clarity[ri] || 0) : 0;
        if (cc > ac + 0.12) continue;
        f0s[i] /= Math.pow(2, octaves);
        midi[i] = freqToMidi(f0s[i]);
      }
    }
  }

  function yinPitchTrack(signal, sr, opts) {
    opts = opts || {};
    const frameSize = opts.frameSize || 2048;
    const hopSize = opts.hopSize || 512;
    const fmin = opts.fmin || 70;
    const fmax = opts.fmax || 1000;
    const threshold = opts.threshold || 0.15;
    const minLag = Math.max(2, Math.floor(sr / fmax));
    const maxLag = Math.min(Math.floor(frameSize / 2), Math.floor(sr / fmin) + 1);
    const n = signal.length;
    const nFrames = Math.max(0, 1 + Math.floor((n - frameSize) / hopSize));
    const f0s = new Float64Array(nFrames);
    const voiced = new Uint8Array(nFrames);
    const times = new Float64Array(nFrames);
    const clarity = new Float64Array(nFrames);

    // Reuse all YIN scratch storage across frames. The previous implementation
    // allocated difference + CMND arrays for every hop, which creates thousands
    // of short-lived typed arrays and unnecessary GC pressure in mobile Safari.
    const frameW = new Float32Array(frameSize);
    const energy = new Float64Array(frameSize + 1);
    const df = new Float64Array(maxLag);
    const cmndf = new Float64Array(maxLag);
    for (let i = 0; i < nFrames; i++) {
      const start = i * hopSize;
      times[i] = (start + frameSize / 2) / sr;
      let maxAbs = 0;
      energy[0] = 0;
      for (let j = 0; j < frameSize; j++) {
        const v = signal[start + j];
        frameW[j] = v;
        energy[j + 1] = energy[j] + v * v;
        const av = Math.abs(v);
        if (av > maxAbs) maxAbs = av;
      }
      if (maxAbs < 1e-6) continue;

      const totalEnergy = energy[frameSize];
      df[0] = 0;
      for (let tau = 1; tau < maxLag; tau++) {
        let acf = 0;
        const limit = frameSize - tau;
        for (let j = 0; j < limit; j++) acf += frameW[j] * frameW[j + tau];
        const e = totalEnergy - energy[tau];
        const eShift = energy[frameSize - tau];
        df[tau] = e + eShift - 2 * acf;
      }

      cmndf[0] = 1;
      let runningSum = 0;
      for (let tau = 1; tau < maxLag; tau++) {
        runningSum += df[tau];
        cmndf[tau] = runningSum > 0 ? (df[tau] * tau) / runningSum : 1;
      }

      let tau = -1;
      for (let t = minLag; t < maxLag - 1; t++) {
        if (cmndf[t] < threshold) {
          while (t + 1 < maxLag && cmndf[t + 1] < cmndf[t]) t++;
          tau = t;
          break;
        }
      }
      if (tau === -1) continue;

      clarity[i] = 1 - cmndf[tau];
      let tauRefined = tau;
      if (tau > 0 && tau < maxLag - 1) {
        const s0 = cmndf[tau - 1], s1 = cmndf[tau], s2 = cmndf[tau + 1];
        const denom = s0 - 2 * s1 + s2;
        if (denom !== 0) tauRefined = tau + 0.5 * (s0 - s2) / denom;
      }
      if (tauRefined <= 0) continue;
      const f0 = sr / tauRefined;
      if (f0 >= fmin && f0 <= fmax) { f0s[i] = f0; voiced[i] = 1; }
    }

    stabilizeOctaveErrors(f0s, voiced, clarity);
    return { f0s, voiced, times, clarity, hopSize, frameSize };
  }

  // ============================================================
  // Note / pitch conversion helpers
  // ============================================================
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440.0); }
  function midiToFreq(m) { return 440.0 * Math.pow(2, (m - 69) / 12); }
  function midiToNoteName(m) {
    const rounded = Math.round(m);
    const pc = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    return NOTE_NAMES[pc] + octave;
  }

  // ============================================================
  // Note segmentation: turn a continuous f0 track into discrete
  // "blobs" (Melodyne-style), each holding a stable rounded MIDI
  // note plus the raw pitch curve inside it (for the wavy blob shape
  // and for shifting-while-preserving-vibrato on resynthesis).
  // ============================================================
  function segmentNotes(pitchTrack, opts) {
    opts = opts || {};
    const bridgeGapSec = opts.bridgeGapSec != null ? opts.bridgeGapSec : 0.09;
    const bridgeMaxSemitones = opts.bridgeMaxSemitones != null ? opts.bridgeMaxSemitones : 2.0;
    const boundaryThreshold = opts.boundaryThreshold != null ? opts.boundaryThreshold : 0.68;
    const minHoldSec = opts.minHoldSec != null ? opts.minHoldSec : 0.070;
    const minSegDurSec = opts.minSegDurSec != null ? opts.minSegDurSec : 0.06;
    const medianWin = opts.medianWin != null ? opts.medianWin : 7;

    const { times, f0s, voiced } = pitchTrack;
    const n = times.length;
    if (n === 0) return [];
    const hop = n > 1 ? times[1] - times[0] : 0.01;
    const minHoldFrames = Math.max(1, Math.round(minHoldSec / hop));

    // Raw midi per frame (NaN if unvoiced)
    const midiRaw = new Float64Array(n);
    for (let i = 0; i < n; i++) midiRaw[i] = voiced[i] ? freqToMidi(f0s[i]) : NaN;

    // Median-smooth voiced midi values to reject octave jumps / jitter
    // before boundary detection (segmentation only -- audio resynthesis
    // still uses the raw f0 curve).
    const midiSmooth = new Float64Array(n);
    const half = Math.floor(medianWin / 2);
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) { midiSmooth[i] = NaN; continue; }
      const vals = [];
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j >= 0 && j < n && voiced[j]) vals.push(midiRaw[j]);
      }
      vals.sort((a, b) => a - b);
      midiSmooth[i] = vals[Math.floor(vals.length / 2)];
    }

    // A vibrato crest can sit over the semitone boundary for several frames.
    // Require the prospective new note to dominate a short forward window before
    // allowing a split. Real note changes settle on the new center; vibrato returns.
    function candidateIsStable(idx, candidateCenter, curCenter) {
      const confirmFrames = Math.max(minHoldFrames, Math.round(0.09 / hop));
      const end = Math.min(n, idx + Math.max(confirmFrames + 1, 5));
      if (end - idx < confirmFrames) return false;
      const vals = [];
      let candidateVotes = 0, centerVotes = 0;
      for (let j = idx; j < end; j++) {
        const v = midiSmooth[j];
        if (!Number.isFinite(v)) continue;
        vals.push(v);
        const r = Math.round(v);
        if (r === candidateCenter) candidateVotes++;
        if (r === curCenter) centerVotes++;
      }
      if (vals.length < Math.max(3, Math.floor(confirmFrames * 0.70))) return false;
      vals.sort((a,b)=>a-b);
      const med = vals[Math.floor(vals.length / 2)];
      const dominance = candidateVotes / vals.length;
      return dominance >= 0.72 && candidateVotes > centerVotes && Math.abs(med - curCenter) > boundaryThreshold;
    }

    // Build voiced runs, bridging short unvoiced gaps when the pitch
    // either side is close (legato / brief consonant dropout).
    const runs = [];
    let i = 0;
    while (i < n) {
      if (!voiced[i]) { i++; continue; }
      let j = i;
      while (j < n) {
        if (voiced[j]) { j++; continue; }
        // gap: look ahead for the next voiced frame
        let k = j;
        while (k < n && !voiced[k]) k++;
        if (k < n) {
          const gapSec = times[k] - times[j - 1];
          const pitchDiff = Math.abs(midiSmooth[k] - midiSmooth[j - 1]);
          if (gapSec <= bridgeGapSec && pitchDiff <= bridgeMaxSemitones) { j = k; continue; }
        }
        break;
      }
      runs.push([i, j]); // [start, end) frame indices, may include a bridged unvoiced gap
      i = j;
    }

    // Within each run, split into note segments via hysteresis on the
    // rounded semitone the smoothed curve is centered on.
    const segments = [];
    for (const [rs, re] of runs) {
      let segStart = rs;
      let curCenter = Math.round(firstFinite(midiSmooth, rs, re));
      for (let idx = rs; idx < re; idx++) {
        const m = midiSmooth[idx];
        if (isNaN(m)) continue;
        const dev = m - curCenter;
        if (Math.abs(dev) > boundaryThreshold) {
          const candidateCenter = Math.round(m);
          if (candidateCenter !== curCenter && candidateIsStable(idx, candidateCenter, curCenter)) {
            // The forward window already confirms persistence, so split at the
            // first stable crossing instead of waiting a second hold period.
            // This keeps 100–150 ms sung notes separable on mobile analysis hops.
            if (idx > segStart) segments.push(makeSegment(segStart, idx, times, f0s, voiced, midiSmooth, curCenter));
            segStart = idx;
            curCenter = candidateCenter;
          }
        }
      }
      segments.push(makeSegment(segStart, re, times, f0s, voiced, midiSmooth, curCenter));
    }

    // Merge segments shorter than minSegDurSec into their neighbor.
    const merged = [];
    for (const seg of segments) {
      if (seg.durationSec < minSegDurSec && merged.length > 0) {
        const prev = merged[merged.length - 1];
        prev.endFrame = seg.endFrame;
        prev.endTime = seg.endTime;
        prev.durationSec = prev.endTime - prev.startTime;
      } else {
        merged.push(seg);
      }
    }
    merged.forEach((s, idx) => { s.id = idx; });
    return merged;
  }

  function firstFinite(arr, start, end) {
    for (let i = start; i < end; i++) if (!isNaN(arr[i])) return arr[i];
    return 60; // fallback: middle C
  }

  function makeSegment(startFrame, endFrame, times, f0s, voiced, midiSmooth, centerMidi) {
    const startTime = times[startFrame];
    const endTime = endFrame < times.length ? times[endFrame] : times[times.length - 1] + 0.01;
    // representative note = median of the smoothed midi within the segment
    const vals = [];
    for (let i = startFrame; i < endFrame; i++) if (!isNaN(midiSmooth[i])) vals.push(midiSmooth[i]);
    vals.sort((a, b) => a - b);
    const medianMidi = vals.length ? vals[Math.floor(vals.length / 2)] : centerMidi;
    return {
      startFrame, endFrame, startTime, endTime,
      durationSec: endTime - startTime,
      noteMidi: Math.round(medianMidi),
      medianMidi,
      shiftSemitones: 0,  // user edit: coarse drag, whole note ("Note tool")
      fineCents: 0,        // user edit: fine trim, whole note
      lineOffsets: null,   // user edit: free-hand curve reshape within the note ("Line tool"),
                           // a Float64Array of length (endFrame-startFrame) in semitones, lazily
                           // allocated on first paint; null/all-zero means "use the natural curve".
    };
  }

  // Recompute a segment's display stats (note name, median pitch) from the
  // raw f0 track -- used after a manual split, where the smoothed midi
  // array from segmentation isn't available anymore.
  function recomputeSegmentDisplay(seg, f0s, voiced) {
    const vals = [];
    for (let i = seg.startFrame; i < seg.endFrame; i++) if (voiced[i] && f0s[i] > 0) vals.push(freqToMidi(f0s[i]));
    vals.sort((a, b) => a - b);
    const medianMidi = vals.length ? vals[Math.floor(vals.length / 2)] : seg.medianMidi;
    seg.medianMidi = medianMidi;
    seg.noteMidi = Math.round(medianMidi);
  }

  // Split a segment into two at the given frame index (splitFrame becomes
  // the first frame of the new second half). Both halves start out with the
  // same shiftSemitones/fineCents as the original (so nothing audibly
  // changes at the moment of the split) and can then be edited independently.
  // lineOffsets, being frame-aligned, is sliced across the two halves.
  function splitSegment(segments, segId, splitFrame, times, f0s, voiced) {
    const seg = segments[segId];
    if (!seg) return segments;
    if (splitFrame <= seg.startFrame + 1 || splitFrame >= seg.endFrame - 1) return segments; // too close to an edge to be useful
    const first = Object.assign({}, seg, { endFrame: splitFrame, endTime: times[splitFrame] });
    const second = Object.assign({}, seg, { startFrame: splitFrame, startTime: times[splitFrame] });
    first.durationSec = first.endTime - first.startTime;
    second.durationSec = second.endTime - second.startTime;
    if (seg.lineOffsets) {
      first.lineOffsets = seg.lineOffsets.slice(0, splitFrame - seg.startFrame);
      second.lineOffsets = seg.lineOffsets.slice(splitFrame - seg.startFrame);
    }
    recomputeSegmentDisplay(first, f0s, voiced);
    recomputeSegmentDisplay(second, f0s, voiced);
    const out = segments.slice();
    out.splice(segId, 1, first, second);
    out.forEach((s, idx) => { s.id = idx; });
    return out;
  }

  // ============================================================
  // Reference/guide alignment: DTW-match a reference vocal's pitch
  // contour against the main vocal's, then read off what pitch the
  // reference is singing wherever a note segment falls, as a per-note
  // *suggestion* (never auto-applied -- the caller decides whether/how
  // to use it). This deliberately only ever touches PITCH, never timing:
  // the earlier DTW+WSOLA timing-correction attempt (see project notes)
  // never reached usable quality, so this route sidesteps it entirely --
  // segment start/end times are never modified by anything here.
  // ============================================================

  // Same median-smoothing segmentNotes uses for boundary detection,
  // factored out so it can also serve as the DTW alignment feature.
  function smoothedMidiSeq(pitchTrack, medianWin) {
    medianWin = medianWin || 5;
    const { f0s, voiced } = pitchTrack;
    const n = f0s.length;
    const midiRaw = new Float64Array(n);
    for (let i = 0; i < n; i++) midiRaw[i] = voiced[i] ? freqToMidi(f0s[i]) : NaN;
    const half = Math.floor(medianWin / 2);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) { out[i] = NaN; continue; }
      const vals = [];
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j >= 0 && j < n && voiced[j]) vals.push(midiRaw[j]);
      }
      vals.sort((a, b) => a - b);
      out[i] = vals[Math.floor(vals.length / 2)];
    }
    return out;
  }

  // Reference-alignment features.  Absolute pitch is already de-meaned
  // before this stage; here we also track local melodic direction and
  // voiced-boundary events.  Those extra cues make repeated notes/phrases
  // less likely to cross-match when the two performances use different
  // timing or articulation.
  function makeAlignFeatures(seq) {
    const n = seq.length;
    const pitch = Float64Array.from(seq);
    const slope = new Float64Array(n);
    const edge = new Int8Array(n); // +1 onset, -1 offset, 0 otherwise
    const voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) voiced[i] = isNaN(seq[i]) ? 0 : 1;
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      let a = i - 2, b = i + 2;
      while (a >= 0 && !voiced[a]) a--;
      while (b < n && !voiced[b]) b++;
      if (a >= 0 && b < n) slope[i] = Math.max(-4, Math.min(4, (pitch[b] - pitch[a]) / Math.max(1, b - a)));
      const prevVoiced = i > 0 ? voiced[i - 1] : 0;
      const nextVoiced = i + 1 < n ? voiced[i + 1] : 0;
      if (!prevVoiced && voiced[i]) edge[i] = 1;
      else if (voiced[i] && !nextVoiced) edge[i] = -1;
    }
    return { pitch, slope, edge, voiced, length: n };
  }

  function frameDistFeat(A, i, B, j) {
    const va = A.voiced[i] === 1, vb = B.voiced[j] === 1;
    if (!va && !vb) {
      // Silence is intentionally cheap, but not completely free; a tiny
      // cost stops long silent sections from creating arbitrary shortcuts.
      return 0.05;
    }
    if (va !== vb) return 7.0;
    const pitchCost = Math.min(10, Math.abs(A.pitch[i] - B.pitch[j]));
    const slopeCost = Math.min(3.0, Math.abs(A.slope[i] - B.slope[j]) * 1.35);
    let edgeCost = 0;
    const ea = A.edge[i], eb = B.edge[j];
    if ((ea !== 0 || eb !== 0) && ea !== eb) edgeCost = 1.8;
    return pitchCost + slopeCost + edgeCost;
  }

  function downsampleAlignFeatures(A, stride) {
    stride = Math.max(2, stride | 0);
    const n = Math.ceil(A.length / stride);
    const pitch = new Float64Array(n);
    pitch.fill(NaN);
    for (let k = 0; k < n; k++) {
      const lo = k * stride, hi = Math.min(A.length, lo + stride);
      const vals = [];
      for (let i = lo; i < hi; i++) if (A.voiced[i]) vals.push(A.pitch[i]);
      if (vals.length) {
        vals.sort((a, b) => a - b);
        pitch[k] = vals[Math.floor(vals.length / 2)];
      }
    }
    return makeAlignFeatures(pitch);
  }

  // Core banded DTW.  Horizontal/vertical steps get a small insertion/
  // deletion penalty so the path prefers genuine diagonal correspondence
  // instead of lingering on one attractive repeated note.  A supplied
  // centerMap lets the fine pass follow a coarse alignment rather than
  // assuming the whole performance stays near a simple global diagonal.
  function dtwAlignPathCore(A, B, bandFrac, centerMap) {
    const n = A.length, m = B.length;
    if (n === 0 || m === 0) return [];
    bandFrac = bandFrac || 0.12;
    const band = Math.max(24, Math.round(bandFrac * Math.max(n, m)));
    const ratio = m / n;
    const lo = new Int32Array(n), hi = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const center = centerMap ? Math.round(centerMap[i]) : Math.round(i * ratio);
      lo[i] = Math.max(0, center - band);
      hi[i] = Math.min(m - 1, center + band);
      if (i === 0) lo[i] = 0;
      if (i === n - 1) hi[i] = m - 1;
    }
    const D = new Array(n), P = new Array(n);
    for (let i = 0; i < n; i++) {
      const width = hi[i] - lo[i] + 1;
      D[i] = new Float32Array(width);
      D[i].fill(Infinity);
      P[i] = new Uint8Array(width);
    }
    const stepPenalty = 0.55;
    for (let i = 0; i < n; i++) {
      const width = hi[i] - lo[i] + 1;
      for (let jj = 0; jj < width; jj++) {
        const j = lo[i] + jj;
        const c = frameDistFeat(A, i, B, j);
        if (i === 0 && j === 0) { D[i][jj] = c; P[i][jj] = 0; continue; }
        let best = Infinity, dir = 0;
        if (i > 0 && j > 0 && j - 1 >= lo[i - 1] && j - 1 <= hi[i - 1]) {
          const v = D[i - 1][j - 1 - lo[i - 1]];
          if (v < best) { best = v; dir = 0; }
        }
        if (i > 0 && j >= lo[i - 1] && j <= hi[i - 1]) {
          const v = D[i - 1][j - lo[i - 1]] + stepPenalty;
          if (v < best) { best = v; dir = 1; }
        }
        if (jj > 0) {
          const v = D[i][jj - 1] + stepPenalty;
          if (v < best) { best = v; dir = 2; }
        }
        if (!Number.isFinite(best)) continue;
        D[i][jj] = best + c;
        P[i][jj] = dir;
      }
    }
    let i = n - 1, j = m - 1;
    if (j < lo[i] || j > hi[i] || !Number.isFinite(D[i][j - lo[i]])) {
      let bestJ = lo[i], bestV = Infinity;
      for (let jj = 0; jj < D[i].length; jj++) if (D[i][jj] < bestV) { bestV = D[i][jj]; bestJ = lo[i] + jj; }
      j = bestJ;
    }
    const path = [[i, j]];
    let guard = n + m + 8;
    while ((i > 0 || j > 0) && guard-- > 0) {
      const jj = j - lo[i];
      if (jj < 0 || jj >= P[i].length) break;
      const dir = P[i][jj];
      if (dir === 0 && i > 0 && j > 0) { i--; j--; }
      else if (dir === 1 && i > 0) i--;
      else if (j > 0) j--;
      else if (i > 0) i--;
      path.push([i, j]);
    }
    path.reverse();
    return path;
  }

  // Two-pass DTW.  A cheap coarse pass is allowed a broad search window;
  // its path becomes the center line for a much narrower full-resolution
  // pass.  This tracks local tempo/rubato differences without giving the
  // fine alignment enough freedom to jump to a similar phrase elsewhere.
  function dtwAlignPath(seqA, seqB, bandFrac) {
    const A = makeAlignFeatures(seqA), B = makeAlignFeatures(seqB);
    const n = A.length, m = B.length;
    if (!n || !m) return [];
    const stride = Math.max(4, Math.min(12, Math.round(Math.max(n, m) / 1800)));
    if (Math.max(n, m) < 600) return dtwAlignPathCore(A, B, bandFrac || 0.14, null);

    const Ac = downsampleAlignFeatures(A, stride);
    const Bc = downsampleAlignFeatures(B, stride);
    const coarsePath = dtwAlignPathCore(Ac, Bc, Math.max(0.16, bandFrac || 0.18), null);
    if (coarsePath.length < 2) return dtwAlignPathCore(A, B, bandFrac || 0.14, null);

    const cx = new Float64Array(coarsePath.length), cy = new Float64Array(coarsePath.length);
    for (let k = 0; k < coarsePath.length; k++) {
      cx[k] = coarsePath[k][0] * stride;
      cy[k] = coarsePath[k][1] * stride;
    }
    const centerMap = new Float64Array(n);
    for (let i = 0; i < n; i++) centerMap[i] = interpLin(i, cx, cy);
    const fineBandFrac = Math.max(0.025, Math.min(0.07, (bandFrac || 0.12) * 0.42));
    return dtwAlignPathCore(A, B, fineBandFrac, centerMap);
  }

  // Collapse the path into a strictly-increasing (vocalTime -> refTime)
  // map suitable for interpLin (duplicate vocal-time entries -- from a
  // run of "left" moves where several ref frames matched one vocal
  // frame -- are collapsed to their last ref time).
  function buildAlignmentTimeMap(vocalTimes, refTimes, path) {
    const xsTmp = [], ysTmp = [];
    for (let k = 0; k < path.length; k++) {
      const x = vocalTimes[path[k][0]], y = refTimes[path[k][1]];
      if (xsTmp.length > 0 && xsTmp[xsTmp.length - 1] === x) ysTmp[ysTmp.length - 1] = y;
      else { xsTmp.push(x); ysTmp.push(y); }
    }
    return { xs: Float64Array.from(xsTmp), ys: Float64Array.from(ysTmp) };
  }

  // Same as buildAlignmentTimeMap but keyed the other way (strictly
  // increasing reference time -> vocal time), for mapping a reference
  // playback position back onto the vocal timeline (e.g. to draw a
  // "here's where this is in the vocal" playhead while previewing the
  // reference).
  function buildReverseAlignmentTimeMap(vocalTimes, refTimes, path) {
    const xsTmp = [], ysTmp = [];
    for (let k = 0; k < path.length; k++) {
      const x = refTimes[path[k][1]], y = vocalTimes[path[k][0]];
      if (xsTmp.length > 0 && xsTmp[xsTmp.length - 1] === x) ysTmp[ysTmp.length - 1] = y;
      else { xsTmp.push(x); ysTmp.push(y); }
    }
    return { xs: Float64Array.from(xsTmp), ys: Float64Array.from(ysTmp) };
  }

  // Top-level entry point: for each vocal segment, find its time range's
  // counterpart in the reference (via the DTW time map) and report the
  // reference's median pitch there as a suggestion (null if the aligned
  // reference region has no voiced content). vocalSegments only needs
  // {startTime, endTime} per entry.
  // Subtract each track's own median voiced pitch before alignment, so a
  // constant register difference between the vocal and its reference (a
  // different singer, or the same singer transposed) can't create
  // spurious low-cost shortcuts in the DTW search -- what should drive
  // alignment is melodic CONTOUR (the shape of rises and falls), not
  // absolute pitch level. (The final suggestion readout below still uses
  // genuine absolute reference pitch, unaffected by this -- de-meaning is
  // only used to decide the TIME correspondence.)
  function demeanedSeq(seq) {
    const vals = [];
    for (let i = 0; i < seq.length; i++) if (!isNaN(seq[i])) vals.push(seq[i]);
    if (vals.length === 0) return seq;
    vals.sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const out = new Float64Array(seq.length);
    for (let i = 0; i < seq.length; i++) out[i] = isNaN(seq[i]) ? NaN : seq[i] - med;
    return out;
  }

  // Returns { suggestions, alignXs, alignYs } -- the alignment time map is
  // handed back too (not just the per-segment suggestions) so the caller
  // can also convert an arbitrary vocal-timeline position to the
  // corresponding reference position, e.g. to play the reference back
  // from "wherever the main playhead currently is."
  function suggestFromReference(vocalPitchTrack, vocalSegments, refPitchTrack, opts) {
    opts = opts || {};
    const vocalFeat = demeanedSeq(smoothedMidiSeq(vocalPitchTrack, opts.medianWin));
    const refFeat = demeanedSeq(smoothedMidiSeq(refPitchTrack, opts.medianWin));
    const path = dtwAlignPath(vocalFeat, refFeat, opts.bandFrac);
    const { xs, ys } = buildAlignmentTimeMap(vocalPitchTrack.times, refPitchTrack.times, path);
    const { xs: refXs, ys: refYs } = buildReverseAlignmentTimeMap(vocalPitchTrack.times, refPitchTrack.times, path);
    const { times: refTimes, f0s: refF0s, voiced: refVoiced } = refPitchTrack;
    // Build a direct path lookup as well as the interpolation maps.  For
    // each vocal note we read reference frames matched to the INNER part
    // of that note, which avoids neighboring-note transitions polluting
    // the target pitch when the two singers articulate boundaries at
    // slightly different times.
    const matchedRefByVocal = new Array(vocalPitchTrack.times.length);
    for (let k = 0; k < path.length; k++) {
      const vi = path[k][0], rj = path[k][1];
      let a = matchedRefByVocal[vi];
      if (!a) matchedRefByVocal[vi] = a = [];
      if (a.length === 0 || a[a.length - 1] !== rj) a.push(rj);
    }

    const expressions = new Array(vocalSegments.length).fill(null);
    const suggestions = vocalSegments.map((seg, segIndex) => {
      if (xs.length === 0) return null;
      const dur = Math.max(0.001, seg.endTime - seg.startTime);
      const trim = Math.min(0.055, dur * 0.16);
      const innerStart = seg.startTime + trim;
      const innerEnd = seg.endTime - trim;
      const refIdx = [];
      let vocalFrames = 0;
      for (let vi = 0; vi < vocalPitchTrack.times.length; vi++) {
        const t = vocalPitchTrack.times[vi];
        if (t < innerStart || t > innerEnd) continue;
        vocalFrames++;
        const arr = matchedRefByVocal[vi];
        if (!arr) continue;
        for (let q = 0; q < arr.length; q++) {
          const rj = arr[q];
          if (refIdx.length === 0 || refIdx[refIdx.length - 1] !== rj) refIdx.push(rj);
        }
      }
      // Fallback for extremely short notes or a sparse path.
      if (refIdx.length < 2) {
        const refStart = interpLin(seg.startTime, xs, ys);
        const refEnd = interpLin(seg.endTime, xs, ys);
        const lo = Math.min(refStart, refEnd), hi = Math.max(refStart, refEnd);
        for (let i = 0; i < refTimes.length; i++) if (refTimes[i] >= lo && refTimes[i] <= hi) refIdx.push(i);
      }

      const vals = [];
      let voicedCount = 0;
      for (let q = 0; q < refIdx.length; q++) {
        const i = refIdx[q];
        if (!refVoiced[i] || !(refF0s[i] > 0)) continue;
        voicedCount++;
        let v = freqToMidi(refF0s[i]);
        // Fold each frame to the octave nearest the singer's note BEFORE
        // robust statistics.  This prevents a guide sung one octave away,
        // or a one-frame octave detector slip, from creating two clusters.
        if (seg.noteMidi != null) {
          while (v - seg.noteMidi > 6) v -= 12;
          while (seg.noteMidi - v > 6) v += 12;
        }
        vals.push(v);
      }
      if (vals.length < 2) return null;
      const voicedCoverage = voicedCount / Math.max(1, refIdx.length);
      if (voicedCoverage < 0.28) return null;

      vals.sort((a, b) => a - b);
      const med0 = vals[Math.floor(vals.length / 2)];
      const dev = vals.map((v) => Math.abs(v - med0)).sort((a, b) => a - b);
      const mad = dev[Math.floor(dev.length / 2)] || 0;
      const gate = Math.max(0.65, Math.min(1.8, 3.2 * mad + 0.35));
      const kept = vals.filter((v) => Math.abs(v - med0) <= gate);
      if (kept.length < Math.max(2, Math.ceil(vals.length * 0.45))) return null;
      kept.sort((a, b) => a - b);
      let target = kept[Math.floor(kept.length / 2)];

      // If the aligned region contains a wide multi-note mixture even
      // after robust filtering, it is safer to offer no suggestion than a
      // confidently wrong one.
      const keptDev = kept.map((v) => Math.abs(v - target)).sort((a, b) => a - b);
      const keptMad = keptDev[Math.floor(keptDev.length / 2)] || 0;
      if (keptMad > 0.95 && kept.length >= 5) return null;

      if (seg.noteMidi != null) {
        while (target - seg.noteMidi > 6) target -= 12;
        while (seg.noteMidi - target > 6) target += 12;
      }

      // Build an expressive pitch contour on the VOCAL frame grid.  The
      // contour is relative to the robust target above, so it carries only
      // the reference singer's local scoop/fall/vibrato shape, not register.
      // Missing/unvoiced matches are interpolated later by the UI helper.
      if (Number.isInteger(seg.startFrame) && Number.isInteger(seg.endFrame) && seg.endFrame > seg.startFrame) {
        const nFrames = seg.endFrame - seg.startFrame;
        const expr = new Float64Array(nFrames);
        expr.fill(NaN);
        for (let vi = seg.startFrame; vi < seg.endFrame && vi < matchedRefByVocal.length; vi++) {
          const arr = matchedRefByVocal[vi];
          if (!arr || arr.length === 0) continue;
          const frameVals = [];
          for (let q = 0; q < arr.length; q++) {
            const rj = arr[q];
            if (!refVoiced[rj] || !(refF0s[rj] > 0)) continue;
            let v = freqToMidi(refF0s[rj]);
            while (v - target > 6) v -= 12;
            while (target - v > 6) v += 12;
            frameVals.push(v);
          }
          if (!frameVals.length) continue;
          frameVals.sort((a,b)=>a-b);
          const mv = frameVals[Math.floor(frameVals.length/2)];
          // Keep expressive movement, but reject wild detector slips.
          const off = Math.max(-2.4, Math.min(2.4, mv - target));
          expr[vi - seg.startFrame] = off;
        }

        // Short median smoothing removes isolated DTW/YIN jitter without
        // flattening normal 5-8 Hz vibrato.
        const smooth = new Float64Array(nFrames);
        smooth.fill(NaN);
        let finiteCount = 0;
        for (let k = 0; k < nFrames; k++) {
          const vv = [];
          for (let j = Math.max(0,k-1); j <= Math.min(nFrames-1,k+1); j++) if (Number.isFinite(expr[j])) vv.push(expr[j]);
          vv.sort((a,b)=>a-b);
          if (vv.length) { smooth[k] = vv[Math.floor(vv.length/2)]; finiteCount++; }
        }
        if (finiteCount >= Math.max(3, Math.floor(nFrames * 0.35))) expressions[segIndex] = smooth;
      }
      return target;
    });
    return { suggestions, expressions, alignXs: xs, alignYs: ys, alignRefXs: refXs, alignRefYs: refYs };
  }

  // ============================================================
  // Grain-schedule PSOLA v4
  //   Step 1: build the grain schedule once from the mono analysis
  //           + the current per-segment edits.
  //   Step 2: replay that schedule against any channel's samples.
  // This keeps stereo channels phase-locked (no comb filtering).
  // ============================================================

  function fillUnvoiced(f0s, voiced, defaultF0) {
    defaultF0 = defaultF0 || 150.0;
    const filled = Float64Array.from(f0s);
    let last = null;
    for (let i = 0; i < filled.length; i++) {
      if (voiced[i]) last = filled[i]; else if (last !== null) filled[i] = last;
    }
    let nxt = null;
    for (let i = filled.length - 1; i >= 0; i--) {
      if (voiced[i]) nxt = filled[i]; else if (filled[i] === 0 && nxt !== null) filled[i] = nxt;
    }
    for (let i = 0; i < filled.length; i++) if (filled[i] <= 0) filled[i] = defaultF0;
    return filled;
  }

  function interpLin(x, xp, fp) {
    const n = xp.length;
    if (n === 0) return 0;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
    return fp[lo] + t * (fp[hi] - fp[lo]);
  }

  function nearestFlag(t, times, flags) {
    if (times.length === 0) return false;
    let lo = 0, hi = times.length - 1;
    if (t <= times[0]) return !!flags[0];
    if (t >= times[hi]) return !!flags[hi];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    return !!flags[hi];
  }

  function hannWin(len) {
    const w = new Float64Array(len);
    for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, len - 1));
    return w;
  }

  function findSegmentAtTime(segments, t) {
    // segments are non-overlapping and sorted by startTime (segmentNotes builds them in order)
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (t >= s.startTime && t < s.endTime) return s;
    }
    return null;
  }

  // Free-hand "Line tool" offset (semitones) at time t within a segment,
  // interpolated from the user-painted lineOffsets array (frame-aligned to
  // this segment's own [startFrame,endFrame) slice of the shared times
  // array). 0 wherever nothing has been painted.
  function lineOffsetAt(seg, times, t) {
    if (!seg.lineOffsets || seg.lineOffsets.length === 0) return 0;
    const sub = times.subarray(seg.startFrame, seg.endFrame);
    return interpLin(t, sub, seg.lineOffsets);
  }

  // Build one mono guide waveform used only to place PSOLA grain centres.
  // All output channels reuse the same marks, so stereo phase/position remains locked.
  function makePsolaGuide(channels) {
    const n = channels[0].length;
    const g = new Float32Array(n);
    const inv = 1 / Math.max(1, channels.length);
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = 0; i < n; i++) g[i] += ch[i] * inv;
    }
    return g;
  }

  // Move a nominal pitch mark onto a nearby waveform extremum. Plain time-grid
  // grain centres can cut different phases of successive cycles, producing the
  // familiar hollow/phasey PSOLA texture. A small search (~22% of one period)
  // gives a waveform-derived mark without allowing large timing jumps.
  function snapPitchMark(signal, nominal, periodSamples) {
    if (!signal || signal.length < 3) return Math.max(0, Math.min(signal ? signal.length - 1 : nominal, nominal));
    nominal = Math.max(1, Math.min(signal.length - 2, nominal | 0));
    const radius = Math.max(2, Math.min(Math.round(periodSamples * 0.22), 96));
    const lo = Math.max(1, nominal - radius);
    const hi = Math.min(signal.length - 2, nominal + radius);
    let best = nominal;
    let bestScore = -1;
    for (let i = lo; i <= hi; i++) {
      const a = Math.abs(signal[i]);
      // Prefer a genuine local extremum; allow non-extrema at a penalty so
      // very quiet/breathy cycles still get a usable mark.
      const extremum = a >= Math.abs(signal[i - 1]) && a >= Math.abs(signal[i + 1]);
      const dist = Math.abs(i - nominal) / Math.max(1, radius);
      const score = a * (extremum ? 1.0 : 0.72) * (1.0 - 0.28 * dist);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // Return true when a segment actually contains an audible pitch edit.
  // Keeping untouched notes completely out of the PSOLA schedule preserves the
  // original waveform and also cuts a large amount of work on phones.
  function segmentHasPitchEdit(seg) {
    if (!seg) return false;
    if (Math.abs((seg.shiftSemitones || 0) + (seg.fineCents || 0) / 100) >= 0.005) return true;
    if (seg.lineOffsets) {
      for (let i = 0; i < seg.lineOffsets.length; i++) {
        if (Math.abs(seg.lineOffsets[i]) >= 0.005) return true;
      }
    }
    return false;
  }

  function inputPeriodAt(t, times, filledF0, defaultF0) {
    let f0 = times.length > 0 ? interpLin(t, times, filledF0) : defaultF0;
    if (!(f0 > 0)) f0 = defaultF0;
    return Math.min(Math.max(1 / f0, 1 / 800), 1 / 60);
  }

  // Follow the real waveform cycle-by-cycle to create SOURCE pitch marks.
  // Unlike placing each grain directly on the requested output time, this keeps
  // source marks one true input period apart. Each next mark is predicted from
  // the previous real mark and snapped only within a small fraction of a period,
  // which strongly reduces half-cycle/phase jumps on sustained vowels.
  function buildSourceMarksForSegment(sr, n, times, filledF0, guideSignal, seg, defaultF0) {
    const marks = [];
    const marginSec = 0.025;
    let seedTime = Math.max(0, seg.startTime - marginSec);
    const endTime = Math.min(n / sr, seg.endTime + marginSec);
    let pSec = inputPeriodAt(seedTime, times, filledF0, defaultF0);
    let nominal = Math.round(seedTime * sr);
    let center = guideSignal ? snapPitchMark(guideSignal, nominal, pSec * sr) : nominal;
    center = Math.max(0, Math.min(n - 1, center));

    // Walk forward using the *input* period. Snapping is relative to the previous
    // accepted mark, so polarity/phase remains much more consistent than an
    // independent absolute-time search for every grain.
    let safety = 0;
    while (center / sr <= endTime && safety++ < Math.ceil((endTime - seedTime) * 900) + 16) {
      const t = center / sr;
      pSec = inputPeriodAt(t, times, filledF0, defaultF0);
      const pSamp = Math.max(8, Math.round(pSec * sr));
      if (!marks.length || center > marks[marks.length - 1].sample) {
        marks.push({ sample: center, time: t, periodSamples: pSamp });
      }
      const predicted = center + pSamp;
      if (predicted >= n) break;
      let next = guideSignal ? snapPitchMark(guideSignal, predicted, pSamp) : predicted;
      // Never allow a local snap to jump backwards or collapse two marks.
      const minAdvance = Math.max(3, Math.round(pSamp * 0.55));
      if (next < center + minAdvance) next = predicted;
      center = Math.max(center + minAdvance, Math.min(n - 1, next));
    }
    return marks;
  }

  function nearestSourceMark(marks, t, hint) {
    if (!marks.length) return { mark: null, index: 0 };
    let i = Math.max(0, Math.min(marks.length - 1, hint || 0));
    while (i + 1 < marks.length && marks[i + 1].time <= t) i++;
    while (i > 0 && marks[i].time > t) i--;
    if (i + 1 < marks.length && Math.abs(marks[i + 1].time - t) < Math.abs(marks[i].time - t)) i++;
    return { mark: marks[i], index: i };
  }

  // Return the two real source cycles surrounding musical time t. For larger
  // corrections v4 can blend both cycles into one synthesis mark rather than
  // repeating one identical cycle. The grain waveform itself is never
  // resampled, so this improves timbre continuity without introducing the
  // classic formant shift of sample-rate pitch shifting.
  function bracketingSourceMarks(marks, t, hint) {
    if (!marks.length) return { left: null, right: null, alpha: 0, index: 0 };
    let i = Math.max(0, Math.min(marks.length - 1, hint || 0));
    while (i + 1 < marks.length && marks[i + 1].time <= t) i++;
    while (i > 0 && marks[i].time > t) i--;
    const left = marks[i];
    const right = i + 1 < marks.length ? marks[i + 1] : left;
    const den = Math.max(1e-9, right.time - left.time);
    const alpha = right === left ? 0 : Math.max(0, Math.min(1, (t - left.time) / den));
    return { left, right, alpha, index: i };
  }

  // Local normalized autocorrelation around the expected input period.
  // YIN already decides whether a frame has a pitch, but sung consonants,
  // breaths and noisy onsets can still momentarily look voiced. This second
  // lightweight check is used only for the wet/dry mask, so ambiguous material
  // stays sample-for-sample original instead of being re-grained.
  function localPeriodicity(signal, center, periodSamples) {
    if (!signal || signal.length < 32) return 1;
    const p = Math.max(8, Math.round(periodSamples));
    const radius = Math.max(1, Math.round(p * 0.08));
    let best = -1;
    for (let d = -radius; d <= radius; d++) {
      const lag = Math.max(4, p + d);
      const lo = Math.max(lag, Math.round(center - p * 0.75));
      const hi = Math.min(signal.length, Math.round(center + p * 0.75));
      if (hi - lo < Math.max(8, p * 0.45)) continue;
      let xy = 0, xx = 0, yy = 0;
      for (let i = lo; i < hi; i++) {
        const x = signal[i], y = signal[i - lag];
        xy += x * y; xx += x * x; yy += y * y;
      }
      const den = Math.sqrt(xx * yy) + 1e-12;
      const c = xy / den;
      if (c > best) best = c;
    }
    return Math.max(0, Math.min(1, best));
  }

  // Duration-preserving TD-PSOLA schedule, v4.
  //
  // Source marks follow the ORIGINAL f0 period. Synthesis marks follow the
  // TARGET f0 period. At every synthesis mark we reuse the source pitch mark
  // nearest the same point in musical time. Upward correction therefore
  // duplicates nearby real cycles and downward correction skips some cycles --
  // the classic PSOLA operation -- without running a source clock to the end of
  // a note and wrapping it, and without cutting arbitrary phases of a cycle.
  function buildGrainSchedule(sr, n, pitchTrack, segments, opts) {
    opts = opts || {};
    const defaultF0 = opts.defaultF0 || 150.0;
    const guideSignal = opts.guideSignal || null;
    const { times, f0s, voiced } = pitchTrack;
    const filledF0 = fillUnvoiced(f0s, voiced, defaultF0);
    const tail = Math.floor(sr * 0.08);
    const outLen = n + tail;
    const grains = [];

    for (const seg of segments) {
      if (!segmentHasPitchEdit(seg)) continue;
      const marks = buildSourceMarksForSegment(sr, n, times, filledF0, guideSignal, seg, defaultF0);
      if (!marks.length) continue;

      // Start synthesis on the first real source mark that falls in the note.
      let first = 0;
      while (first + 1 < marks.length && marks[first].time < seg.startTime) first++;
      let outTime = Math.max(seg.startTime, marks[first].time);
      let sourceHint = first;
      let safety = 0;

      while (outTime < seg.endTime && safety++ < Math.ceil(seg.durationSec * 1700) + 32) {
        const vHere = nearestFlag(outTime, times, voiced);
        const pIn = inputPeriodAt(outTime, times, filledF0, defaultF0);
        let shiftSemi = seg.shiftSemitones + seg.fineCents / 100 + lineOffsetAt(seg, times, outTime);
        if (!vHere) shiftSemi = 0;
        const ratio = Math.min(2.0, Math.max(0.5, Math.pow(2, shiftSemi / 12)));
        const pOut = pIn / ratio;

        if (vHere && Math.abs(shiftSemi) >= 0.005) {
          const absShift = Math.abs(shiftSemi);
          const bracket = bracketingSourceMarks(marks, outTime, sourceHint);
          sourceHint = bracket.index;

          // For subtle correction, the nearest real cycle is the cleanest and
          // cheapest choice. From ~1.5 semitones upward, crossfade neighboring
          // source cycles in the grain domain. This avoids an obvious repeated
          // single-cycle fingerprint while preserving each cycle's spectral
          // envelope (and therefore the singer's vowel/formant character).
          let sources;
          if (absShift < 1.5 || !bracket.right || bracket.right === bracket.left) {
            const found = nearestSourceMark(marks, outTime, sourceHint);
            sourceHint = found.index;
            sources = found.mark ? [{ mark: found.mark, gain: 1 }] : [];
          } else {
            const a = bracket.alpha;
            sources = [
              { mark: bracket.left, gain: 1 - a },
              { mark: bracket.right, gain: a }
            ].filter(x => x.mark && x.gain > 0.015);
          }

          const outCenter = Math.round(outTime * sr);
          for (const src of sources) {
            const m = src.mark;
            const srcCenter = m.sample;
            const periodSamples = Math.max(8, m.periodSamples);
            const half = periodSamples;
            const start = Math.max(0, srcCenter - half);
            const end = Math.min(n, srcCenter + half);
            if (end - start < 8) continue;
            const grainLen = end - start;
            let oStart = outCenter - (srcCenter - start);
            let oEnd = oStart + grainLen;
            let gLo = 0, gHi = grainLen;
            if (oStart < 0) { gLo = -oStart; oStart = 0; }
            if (oEnd > outLen) { gHi -= (oEnd - outLen); oEnd = outLen; }
            if (gHi > gLo) grains.push({ start, gLo, gHi, oStart, grainLen, gain: src.gain });
          }
        }
        outTime += Math.max(1 / sr, pOut);
      }
    }

    const resultLen = Math.min(outLen, n + Math.floor(0.05 * sr));
    return { grains, outLen, resultLen };
  }

  // Cache of Hann windows by length to avoid recomputation across channels.
  function makeWinCache() {
    const cache = new Map();
    return function (len) {
      let w = cache.get(len);
      if (!w) { w = hannWin(len); cache.set(len, w); }
      return w;
    };
  }

  function applyGrainSchedule(signal, schedule, winCache) {
    const { grains, outLen, resultLen } = schedule;
    const out = new Float64Array(outLen);
    const outNorm = new Float64Array(outLen);
    for (const g of grains) {
      const win = winCache(g.grainLen);
      for (let i = g.gLo; i < g.gHi; i++) {
        const oi = g.oStart + (i - g.gLo);
        const gain = g.gain == null ? 1 : g.gain;
        out[oi] += signal[g.start + i] * win[i] * gain;
        outNorm[oi] += win[i] * gain;
      }
    }
    const result = new Float32Array(resultLen);
    for (let i = 0; i < resultLen; i++) result[i] = outNorm[i] > 1e-6 ? out[i] / outNorm[i] : 0;
    return result;
  }

  // Build a sample-domain wet mask so PSOLA is used only where it is actually
  // needed: voiced + edited material. Unedited audio, consonants, breaths and
  // other unvoiced/transient material stay on the original waveform. This is
  // deliberately conservative because re-graining ratio=1 material can still
  // soften attacks and add a faint phasey texture even when pitch is unchanged.
  function buildResynthBlendMask(sr, n, pitchTrack, segments, opts) {
    opts = opts || {};
    const mask = new Float32Array(n);
    const { times, voiced, clarity, f0s } = pitchTrack;
    if (!times || times.length === 0 || !voiced || voiced.length === 0) return mask;
    const guideSignal = opts.guideSignal || null;

    // Frame-wise confidence mask. Besides YIN voiced/unvoiced, require stable
    // voiced neighbors and enough cycle periodicity. This intentionally leaves
    // the first/last frame of a voiced run dry, which protects consonants and
    // breathy attacks from the pitch shifter.
    const hop = Math.max(1, pitchTrack.hopSize || Math.round(sr * 0.01));
    for (let fi = 0; fi < times.length; fi++) {
      if (!voiced[fi]) continue;
      const prevVoiced = fi > 0 ? !!voiced[fi - 1] : false;
      const nextVoiced = fi + 1 < voiced.length ? !!voiced[fi + 1] : false;
      if (!prevVoiced || !nextVoiced) continue;
      if (clarity && clarity.length > fi && clarity[fi] > 0 && clarity[fi] < 0.84) continue;

      const t = times[fi];
      const seg = findSegmentAtTime(segments, t);
      if (!seg) continue;
      const shiftSemi = seg.shiftSemitones + seg.fineCents / 100 + lineOffsetAt(seg, times, t);
      if (Math.abs(shiftSemi) < 0.005) continue;

      const center = Math.round(t * sr);
      if (guideSignal && f0s && f0s[fi] > 0) {
        const periodicity = localPeriodicity(guideSignal, center, sr / f0s[fi]);
        // 0.30 is deliberately permissive for breathy singing, but rejects
        // noise/consonant regions whose apparent YIN pitch is unstable.
        if (periodicity < 0.30) continue;
      }

      const lo = Math.max(0, center - (hop >> 1));
      const hi = Math.min(n, center + ((hop + 1) >> 1));
      for (let i = lo; i < hi; i++) mask[i] = 1;
    }

    // Feather transitions by ~8 ms. This keeps consonant/vowel boundaries and
    // segment edges from clicking when switching between dry and PSOLA audio.
    const fade = Math.max(8, Math.round(sr * 0.008));
    const smoothed = new Float32Array(n);
    let acc = 0;
    const win = fade * 2 + 1;
    for (let i = 0; i < n + fade; i++) {
      const add = i < n ? mask[i] : 0;
      const remIdx = i - win;
      const rem = remIdx >= 0 ? mask[remIdx] : 0;
      acc += add - rem;
      const outIdx = i - fade;
      if (outIdx >= 0 && outIdx < n) smoothed[outIdx] = Math.min(1, acc / Math.max(1, fade));
    }
    return smoothed;
  }

  // High-level: resynthesize one or more channels given the current
  // segment edits. The PSOLA render is blended only into edited voiced areas;
  // everywhere else remains sample-for-sample original.
  function resynthesize(channels, sr, pitchTrack, segments, opts) {
    const n = channels[0].length;
    // Fast path: a file can contain many detected notes while none are edited.
    // Avoid even building the mono guide in that case.
    let hasAnyEdit = false;
    for (const seg of segments) { if (segmentHasPitchEdit(seg)) { hasAnyEdit = true; break; } }
    if (!hasAnyEdit) return channels.map((ch) => Float32Array.from(ch));

    const guideSignal = makePsolaGuide(channels);
    const blend = buildResynthBlendMask(sr, n, pitchTrack, segments, Object.assign({}, opts || {}, { guideSignal }));
    let anyWet = false;
    for (let i = 0; i < blend.length; i++) { if (blend[i] > 1e-5) { anyWet = true; break; } }
    if (!anyWet) return channels.map((ch) => Float32Array.from(ch));

    const schedule = buildGrainSchedule(sr, n, pitchTrack, segments, Object.assign({}, opts || {}, { guideSignal }));
    const winCache = makeWinCache();
    return channels.map((ch) => {
      const wet = applyGrainSchedule(ch, schedule, winCache);
      const out = new Float32Array(Math.min(n, wet.length));
      for (let i = 0; i < out.length; i++) {
        const m = blend[i];
        out[i] = ch[i] * (1 - m) + wet[i] * m;
      }
      return out;
    });
  }


  // iOS full-render path: same PSOLA schedule/blend math as resynthesize(),
  // but overlap-add is accumulated in bounded blocks. This removes the two
  // full-length Float64 work arrays per channel and yields between blocks.
  async function resynthesizeChunked(channels, sr, pitchTrack, segments, opts) {
    opts = opts || {};
    const n = channels[0].length;
    let hasAnyEdit = false;
    for (const seg of segments) { if (segmentHasPitchEdit(seg)) { hasAnyEdit = true; break; } }
    if (!hasAnyEdit) return channels.map((ch) => Float32Array.from(ch));

    const guideSignal = makePsolaGuide(channels);
    const sharedOpts = Object.assign({}, opts, { guideSignal });
    const blend = buildResynthBlendMask(sr, n, pitchTrack, segments, sharedOpts);
    let anyWet = false;
    for (let i = 0; i < blend.length; i++) { if (blend[i] > 1e-5) { anyWet = true; break; } }
    if (!anyWet) return channels.map((ch) => Float32Array.from(ch));

    const schedule = buildGrainSchedule(sr, n, pitchTrack, segments, sharedOpts);
    const grains = schedule.grains;
    const winCache = makeWinCache();
    const blockFrames = Math.max(4096, opts.blockFrames || 32768);
    const outputs = channels.map(() => new Float32Array(n));

    // Grains are generated in output-time order. Maintain a moving first
    // candidate so each block does not rescan the complete schedule.
    let firstCandidate = 0;
    for (let blockStart = 0; blockStart < n; blockStart += blockFrames) {
      const blockEnd = Math.min(n, blockStart + blockFrames);
      while (firstCandidate < grains.length) {
        const g = grains[firstCandidate];
        const gEnd = g.oStart + (g.gHi - g.gLo);
        if (gEnd > blockStart) break;
        firstCandidate++;
      }

      for (let c = 0; c < channels.length; c++) {
        const srcSignal = channels[c];
        const blockLen = blockEnd - blockStart;
        const acc = new Float64Array(blockLen);
        const norm = new Float64Array(blockLen);

        for (let gi = firstCandidate; gi < grains.length; gi++) {
          const g = grains[gi];
          const grainOutStart = g.oStart;
          if (grainOutStart >= blockEnd) break;
          const win = winCache(g.grainLen);
          const gain = g.gain == null ? 1 : g.gain;
          for (let i = g.gLo; i < g.gHi; i++) {
            const oi = g.oStart + (i - g.gLo);
            if (oi < blockStart) continue;
            if (oi >= blockEnd) break;
            const bi = oi - blockStart;
            acc[bi] += srcSignal[g.start + i] * win[i] * gain;
            norm[bi] += win[i] * gain;
          }
        }

        const out = outputs[c];
        for (let i = 0; i < blockLen; i++) {
          const globalI = blockStart + i;
          const wet = norm[i] > 1e-6 ? acc[i] / norm[i] : 0;
          const m = blend[globalI];
          out[globalI] = srcSignal[globalI] * (1 - m) + wet * m;
        }
      }

      // Safari gets a paint/input opportunity without changing DSP boundaries.
      await new Promise(requestAnimationFrame);
    }
    return outputs;
  }

  // ============================================================
  // WAV encode (24-bit PCM, interleaved multi-channel)
  // 24-bit export avoids making the editor itself the final quantization bottleneck.
  // TPDF dither is applied at the 24-bit LSB before quantization.
  function makeWavHeader(numCh, sr, len, bytesPerSample) {
    const dataBytes = len * numCh * bytesPerSample;
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    function writeStr(off, str) { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); }
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * bytesPerSample, true);
    view.setUint16(32, numCh * bytesPerSample, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    return new Uint8Array(buffer);
  }

  // 24-bit PCM + TPDF dither, emitted as Blob chunks instead of one giant
  // ArrayBuffer. This keeps export peak memory bounded on iPhone.
  async function encodeWavChunked(channels, sr, opts) {
    const numCh = channels.length;
    const len = channels[0].length;
    const bytesPerSample = 3;
    const framesPerChunk = Math.max(4096, (opts && opts.framesPerChunk) || 32768);

    let peak = 0;
    for (const ch of channels) {
      for (let i = 0; i < len; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
    }
    const scale = peak > 0.999999 ? 0.999999 / peak : 1.0;
    const max24 = 8388607, min24 = -8388608, lsb = 1 / max24;
    const parts = [makeWavHeader(numCh, sr, len, bytesPerSample)];

    for (let base = 0; base < len; base += framesPerChunk) {
      const nFrames = Math.min(framesPerChunk, len - base);
      const bytes = new Uint8Array(nFrames * numCh * bytesPerSample);
      let offset = 0;
      for (let i = 0; i < nFrames; i++) {
        const frame = base + i;
        for (let c = 0; c < numCh; c++) {
          let x = Math.max(-1, Math.min(1, channels[c][frame] * scale));
          x += (Math.random() - Math.random()) * lsb;
          let v = Math.round(x * max24);
          if (v > max24) v = max24;
          if (v < min24) v = min24;
          if (v < 0) v += 0x1000000;
          bytes[offset++] = v & 0xff;
          bytes[offset++] = (v >> 8) & 0xff;
          bytes[offset++] = (v >> 16) & 0xff;
        }
      }
      parts.push(bytes);
      // Give Safari a chance to paint/respond during long exports.
      if ((parts.length & 3) === 0) await new Promise(requestAnimationFrame);
    }
    return new Blob(parts, { type: 'audio/wav' });
  }

  // Compatibility wrapper for code paths/tests that expect the old name.
  // New UI export uses encodeWavChunked directly.
  function encodeWav(channels, sr) {
    const numCh = channels.length, len = channels[0].length, bytesPerSample = 3;
    const dataBytes = len * numCh * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const header = makeWavHeader(numCh, sr, len, bytesPerSample);
    new Uint8Array(buffer, 0, 44).set(header);
    let peak = 0;
    for (const ch of channels) for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(ch[i]));
    const scale = peak > 0.999999 ? 0.999999 / peak : 1.0;
    const max24 = 8388607, min24 = -8388608, lsb = 1 / max24;
    let offset = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < numCh; c++) {
      let x = Math.max(-1, Math.min(1, channels[c][i] * scale));
      x += (Math.random() - Math.random()) * lsb;
      let v = Math.round(x * max24);
      if (v > max24) v = max24;
      if (v < min24) v = min24;
      if (v < 0) v += 0x1000000;
      view.setUint8(offset++, v & 0xff);
      view.setUint8(offset++, (v >> 8) & 0xff);
      view.setUint8(offset++, (v >> 16) & 0xff);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  const PitchEngine = {
    yinPitchTrack,
    freqToMidi, midiToFreq, midiToNoteName, NOTE_NAMES,
    segmentNotes, splitSegment, suggestFromReference,
    buildGrainSchedule, applyGrainSchedule, resynthesize, resynthesizeChunked, makeWinCache,
    encodeWav, encodeWavChunked,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PitchEngine;
  else root.PitchEngine = PitchEngine;
})(typeof window !== 'undefined' ? window : globalThis);
