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

    // A burst of 2-4 consecutive frames (~25-45 ms) sits an octave off while
    // the voiced frames on both sides agree with each other. The frame-wise
    // pass above cannot see it: the burst's own frames serve as each other's
    // anchor, and the two anchors then disagree. Nobody sings an octave
    // excursion this short between two equal pitches, so it is an analysis
    // error (seen at note ends where the vowel fades); a sustained octave
    // jump is far longer than this and is left alone.
    for (let i = 0; i < n; i++) {
      if (!voiced[i] || !(f0s[i] > 0)) continue;
      const li = nearestVoiced(i, -1, 3);
      if (li < 0 || !Number.isFinite(midi[li])) continue;
      const lm = midi[li];
      for (let len = 2; len <= 4; len++) {
        const j = i + len - 1;
        if (j >= n) break;
        let contiguous = true;
        for (let k = i; k <= j; k++) if (!voiced[k] || !(f0s[k] > 0)) { contiguous = false; break; }
        if (!contiguous) break;
        const ri = nearestVoiced(j, +1, 3);
        if (ri < 0 || !Number.isFinite(midi[ri]) || Math.abs(lm - midi[ri]) > 1.6) continue;
        const anchor = 0.5 * (lm + midi[ri]);
        const anchorClarity = clarity && clarity.length ? Math.max(clarity[li] || 0, clarity[ri] || 0) : 0;
        let octaves = null, ok = true;
        for (let k = i; k <= j && ok; k++) {
          const delta = midi[k] - anchor;
          const o = Math.round(delta / 12);
          if (o === 0 || Math.abs(o) > 2 || Math.abs(delta - 12 * o) > 1.35 || (octaves !== null && o !== octaves)) ok = false;
          else if (clarity && clarity.length && clarity[k] > anchorClarity + 0.12) ok = false;
          octaves = o;
        }
        if (!ok) continue;
        for (let k = i; k <= j; k++) {
          f0s[k] /= Math.pow(2, octaves);
          midi[k] = freqToMidi(f0s[k]);
        }
        i = j;
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // pYIN-style tracking (opts.method === 'pyin').
  //
  // Plain YIN commits per frame to the first cmndf dip under a fixed
  // threshold, so one weak or doubled frame becomes an octave error or a
  // voicing drop that later heuristics have to patch. Here every frame keeps
  // a few candidate periods with probabilities, and a Viterbi pass over the
  // whole track picks the most plausible pitch/voicing path (pitch moves
  // smoothly; switching voicing or leaping by more than a few semitones in
  // one frame is expensive).
  //
  // Candidate probabilities: YIN's threshold is treated as a random variable
  // ~ Beta(2, b). A dip is chosen by every threshold above its own value and
  // below the smallest earlier dip, so its probability is F(prev min) -
  // F(own value) with F the Beta(2, b) CDF = 1 - (1 - x)^b (1 + b x); the
  // remainder F(smallest dip) is "unvoiced". No threshold loop is needed.
  // ------------------------------------------------------------------
  const PYIN_CANDIDATES = 6;
  const PYIN_BINS_PER_SEMITONE = 3;

  function betaCdf2(x, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 1 - Math.pow(1 - x, b) * (1 + b * x);
  }

  // Fill candidate slots for frame i from its cmndf. Slots keep the most
  // probable dips; the rest of the mass is the frame's unvoiced probability.
  // `tauDepth` shifts probability from shallow dips to the deepest one (a
  // doubled-frequency dip that is only slightly deeper than the real period
  // would otherwise win the mass of every threshold above its value), keeping
  // the voiced total unchanged.
  const pyinDips = { lag: new Int32Array(256), val: new Float64Array(256), prob: new Float64Array(256), ref: new Float64Array(256) };
  function pyinCollectFrame(cmndf, minLag, maxLag, sr, fmin, fmax, beta, tauDepth, store, i) {
    const K = PYIN_CANDIDATES;
    const dips = pyinDips;
    let nd = 0, prevMin = 1;
    for (let t = Math.max(1, minLag); t < maxLag - 1 && nd < 256; t++) {
      const v = cmndf[t];
      if (!(v < cmndf[t - 1] && v <= cmndf[t + 1]) || v >= 1 || v >= prevMin) continue;
      const prob = betaCdf2(prevMin, beta) - betaCdf2(v, beta);
      prevMin = v;
      if (prob <= 1e-4) continue;
      let tauRefined = t;
      const s0 = cmndf[t - 1], s1 = v, s2 = cmndf[t + 1];
      const denom = s0 - 2 * s1 + s2;
      if (denom !== 0) tauRefined = t + 0.5 * (s0 - s2) / denom;
      if (!(tauRefined > 0)) continue;
      const f0 = sr / tauRefined;
      if (f0 < fmin || f0 > fmax) continue;
      dips.lag[nd] = t; dips.val[nd] = v; dips.prob[nd] = prob; dips.ref[nd] = f0; nd++;
    }
    const base = i * K;
    store.unvoiced[i] = betaCdf2(prevMin, beta); // thresholds below the deepest dip find nothing
    if (!nd) { for (let k = 0; k < K; k++) store.prob[base + k] = 0; return; }
    if (tauDepth > 0) {
      let total = 0, weighted = 0;
      for (let j = 0; j < nd; j++) {
        total += dips.prob[j];
        dips.prob[j] *= Math.exp(-(dips.val[j] - prevMin) / tauDepth);
        weighted += dips.prob[j];
      }
      const scale = weighted > 0 ? total / weighted : 1;
      for (let j = 0; j < nd; j++) dips.prob[j] *= scale;
    }
    // keep the K most probable
    let used = 0;
    for (let j = 0; j < nd; j++) {
      let slot = -1;
      if (used < K) slot = used++;
      else {
        let worst = 0;
        for (let k = 1; k < K; k++) if (store.prob[base + k] < store.prob[base + worst]) worst = k;
        if (store.prob[base + worst] < dips.prob[j]) slot = worst;
      }
      if (slot >= 0) {
        store.f0[base + slot] = dips.ref[j];
        store.prob[base + slot] = dips.prob[j];
        store.clar[base + slot] = 1 - dips.val[j];
      }
    }
    for (let k = used; k < K; k++) store.prob[base + k] = 0;
  }

  // Viterbi over voiced pitch bins + one unvoiced state. Returns Int16Array
  // (bin index per frame, -1 = unvoiced).
  function pyinViterbi(store, nFrames, sr, hopSize, fmin, fmax, opts) {
    const K = PYIN_CANDIDATES;
    const nb = Math.max(2, Math.ceil(12 * PYIN_BINS_PER_SEMITONE * Math.log2(fmax / fmin)) + 1);
    const binOf = (f0) => Math.round(12 * PYIN_BINS_PER_SEMITONE * Math.log2(f0 / fmin));
    const dt = hopSize / sr;
    const sigma = Math.max(1, (opts.pyinSigma || 2.0) * Math.sqrt(dt / 0.0116));
    const J = Math.max(3, Math.round((opts.pyinMaxJump || 3.2) * PYIN_BINS_PER_SEMITONE * Math.sqrt(dt / 0.0116)));
    const pSwitch = opts.pyinSwitch || 0.02;
    const logStay = Math.log(1 - pSwitch), logSwitch = Math.log(pSwitch);
    const logFromU = Math.log(pSwitch / nb);
    const kernel = new Float64Array(2 * J + 1);
    let ksum = 0;
    for (let d = -J; d <= J; d++) { kernel[d + J] = Math.exp(-0.5 * d * d / (sigma * sigma)); ksum += kernel[d + J]; }
    const logK = new Float64Array(2 * J + 1);
    for (let d = 0; d < kernel.length; d++) logK[d] = Math.log(kernel[d] / ksum) + logStay;
    const EPS = opts.pyinFloor || 1e-3;
    // < 1 favours 'voiced' when the evidence is mixed (noisy or breathy frames)
    const uScale = opts.pyinUnvoiced != null ? opts.pyinUnvoiced : 0.1;
    const NEG = -1e30;

    let delta = new Float64Array(nb + 1), next = new Float64Array(nb + 1);
    const back = new Int8Array(nFrames * nb);        // voiced bins: offset d in [-J,J], 127 = from U
    const backU = new Int16Array(nFrames);           // U state: previous voiced bin or -1 (from U)
    const obs = new Float64Array(nb);
    delta.fill(Math.log(1 / (nb + 1)));
    for (let t = 0; t < nFrames; t++) {
      // observation (log) for this frame
      obs.fill(EPS);
      const base = t * K;
      for (let k = 0; k < K; k++) {
        const pr = store.prob[base + k];
        if (pr <= 0) continue;
        const b = binOf(store.f0[base + k]);
        if (b >= 0 && b < nb) obs[b] += pr;
      }
      const uObs = store.unvoiced[t] * uScale + EPS;
      if (t === 0) {
        for (let b = 0; b < nb; b++) delta[b] += Math.log(obs[b]);
        delta[nb] += Math.log(uObs);
        continue;
      }
      // best voiced predecessor of U
      let bestV = NEG, bestVi = 0;
      for (let b = 0; b < nb; b++) if (delta[b] > bestV) { bestV = delta[b]; bestVi = b; }
      for (let b = 0; b < nb; b++) {
        let best = delta[nb] + logFromU, from = 127;
        const lo = Math.max(0, b - J), hi = Math.min(nb - 1, b + J);
        for (let q = lo; q <= hi; q++) {
          const v = delta[q] + logK[b - q + J];
          if (v > best) { best = v; from = b - q; }
        }
        next[b] = best + Math.log(obs[b]);
        back[t * nb + b] = from === 127 ? 127 : from;
      }
      const fromVoiced = bestV + logSwitch, fromU = delta[nb] + logStay;
      if (fromVoiced > fromU) { next[nb] = fromVoiced + Math.log(uObs); backU[t] = bestVi; }
      else { next[nb] = fromU + Math.log(uObs); backU[t] = -1; }
      const tmp = delta; delta = next; next = tmp;
    }
    const path = new Int16Array(nFrames);
    let state = nb; let bestScore = delta[nb];
    for (let b = 0; b < nb; b++) if (delta[b] > bestScore) { bestScore = delta[b]; state = b; }
    for (let t = nFrames - 1; t >= 0; t--) {
      path[t] = state === nb ? -1 : state;
      if (t === 0) break;
      if (state === nb) state = backU[t] >= 0 ? backU[t] : nb;
      else { const d = back[t * nb + state]; state = d === 127 ? nb : state - d; }
    }
    return path;
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
    const pyin = opts.method === 'pyin';
    const pyinStore = pyin ? {
      f0: new Float32Array(nFrames * PYIN_CANDIDATES),
      prob: new Float32Array(nFrames * PYIN_CANDIDATES),
      clar: new Float32Array(nFrames * PYIN_CANDIDATES),
      unvoiced: new Float32Array(nFrames).fill(1),
    } : null;
    const pyinBeta = opts.pyinBeta || 8;
    const pyinTauDepth = opts.pyinTauDepth != null ? opts.pyinTauDepth : 0.02;
    // Optional progress reporting (fraction 0..1), at most ~100 calls.
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const progressStep = Math.max(1, Math.ceil(nFrames / 100));
    for (let i = 0; i < nFrames; i++) {
      if (onProgress && i % progressStep === 0) onProgress(i / nFrames);
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

      if (pyin) { pyinCollectFrame(cmndf, minLag, maxLag, sr, fmin, fmax, pyinBeta, pyinTauDepth, pyinStore, i); continue; }

      let tau = -1;
      for (let t = minLag; t < maxLag - 1; t++) {
        if (cmndf[t] < threshold) {
          while (t + 1 < maxLag && cmndf[t + 1] < cmndf[t]) t++;
          tau = t;
          break;
        }
      }
      if (tau === -1) continue;

      // A vowel whose formant sits near 2x f0 (a strong second harmonic --
      // observed on some "e"/"o" shapes) can make YIN's first below-threshold
      // dip land at half the true period, reporting exactly an octave too
      // high. A genuine period also repeats at its own integer multiples, so
      // this checks for a deeper cmndf minimum near double the candidate.
      // CMNDF's cumulative normalisation also makes it naturally drift lower
      // at larger lags on ANY clean, confidently periodic tone, so a deeper
      // multiple alone is not enough evidence -- that happens even at the
      // correct pitch. Only override a MARGINAL first pick (its own cmndf
      // barely below the detection threshold) when the doubled candidate is
      // decisively strong in both absolute and relative terms; a first pick
      // that is already a clean, confident match is left alone. Checked
      // twice to also catch a rarer two-octave error.
      for (let pass = 0; pass < 2; pass++) {
        if (cmndf[tau] < threshold * 0.5) break;
        const target = tau * 2;
        if (target >= maxLag - 1) break;
        const lo = Math.max(minLag, Math.round(target * 0.94));
        const hi = Math.min(maxLag - 2, Math.round(target * 1.06));
        let bestJ = -1, bestVal = Infinity;
        for (let j = lo; j <= hi; j++) if (cmndf[j] < bestVal) { bestVal = cmndf[j]; bestJ = j; }
        if (bestJ < 0 || bestVal > 0.05 || bestVal > cmndf[tau] * 0.3) break;
        tau = bestJ;
      }

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

    if (pyin && nFrames > 0) {
      const path = pyinViterbi(pyinStore, nFrames, sr, hopSize, fmin, fmax, opts);
      const K = PYIN_CANDIDATES;
      for (let i = 0; i < nFrames; i++) {
        const b = path[i];
        if (b < 0) continue;
        const centre = fmin * Math.pow(2, b / (12 * PYIN_BINS_PER_SEMITONE));
        // the strongest candidate near the chosen bin gives the fine f0
        let bestK = -1, bestP = 0;
        for (let k = 0; k < K; k++) {
          const pr = pyinStore.prob[i * K + k];
          if (pr > bestP && Math.abs(12 * Math.log2(pyinStore.f0[i * K + k] / centre)) <= 1.0) { bestP = pr; bestK = k; }
        }
        if (bestK < 0) continue; // the path passed through without evidence here: leave unvoiced
        f0s[i] = pyinStore.f0[i * K + bestK];
        clarity[i] = pyinStore.clar[i * K + bestK];
        voiced[i] = 1;
      }
    }
    if (!opts.skipOctaveRepair) stabilizeOctaveErrors(f0s, voiced, clarity);
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
    // Voiced-vs-silent mismatch. Two singers rarely breathe or articulate
    // consonants at the same notes, so a heavy penalty here made the path
    // bend by 0.1-0.2 s to line up gaps instead of following the melody
    // (fast phrases drifted into the neighbouring note). Kept clearly above
    // the silent-silent cost so real rests still anchor the alignment.
    if (va !== vb) return 2.0;
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
  // A mono average can cancel almost completely for phase-inverted stereo.
  // Use the most energetic channel to locate shared pitch marks instead; the
  // resulting schedule is still applied identically to every channel. The
  // app computes this once for the whole song (opts.guideChannel) so a local
  // single-note render follows exactly the same channel as a full render.
  function guideChannelIndex(channels, opts) {
    const fixed = opts && opts.guideChannel;
    if (Number.isInteger(fixed) && fixed >= 0 && fixed < channels.length) return fixed;
    const n = channels[0].length;
    let best = 0, bestEnergy = -1;
    for (let c = 0; c < channels.length; c++) {
      let energy = 0;
      for (let i = 0; i < n; i += 16) energy += channels[c][i] * channels[c][i];
      if (energy > bestEnergy) { bestEnergy = energy; best = c; }
    }
    return best;
  }

  function makePsolaGuide(channels, guide) {
    const g = new Float32Array(channels[0].length);
    g.set(channels[guide]);
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
    if (Math.abs(seg.formantSemitones || 0) >= 0.005) return true;
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
    // seg only needs {startTime, endTime}; callers pass a whole edited region.
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
    const winLo = Math.round(center - p * 0.75);
    const hi = Math.min(signal.length, Math.round(center + p * 0.75));
    const minLag = Math.max(4, p - radius), maxLag = Math.max(4, p + radius);
    let best = -1;
    // Common case: the analysis window does not touch the start of the file,
    // so it is the same for every lag. Then x's energy is computed once and
    // the lagged energy slides by one sample per lag instead of being summed
    // from scratch (~3x fewer multiply-adds; same values up to rounding).
    if (winLo >= maxLag && hi - winLo >= Math.max(8, p * 0.45)) {
      const lo = winLo;
      let xx = 0, yy = 0;
      for (let i = lo; i < hi; i++) {
        const x = signal[i], y = signal[i - minLag];
        xx += x * x; yy += y * y;
      }
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (lag > minLag) {
          // window of y moves from [lo-lag+1, hi-lag+1) to [lo-lag, hi-lag)
          const enter = signal[lo - lag], leave = signal[hi - lag];
          yy += enter * enter - leave * leave;
        }
        let xy = 0;
        for (let i = lo; i < hi; i++) xy += signal[i] * signal[i - lag];
        const c = xy / (Math.sqrt(xx * Math.max(yy, 0)) + 1e-12);
        if (c > best) best = c;
      }
      return Math.max(0, Math.min(1, best));
    }
    for (let d = -radius; d <= radius; d++) {
      const lag = Math.max(4, p + d);
      const lo = Math.max(lag, winLo);
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

  // Voicing with 1-2 frame YIN dropouts bridged. A single missed frame inside
  // a sung vowel otherwise stops the grains and drops the wet mask for ~35 ms,
  // so the note briefly snaps back to its original pitch.
  function bridgeVoicing(voiced, maxGap) {
    const out = Uint8Array.from(voiced);
    let last = -1;
    for (let i = 0; i < voiced.length; i++) {
      if (!voiced[i]) continue;
      if (last >= 0 && i - last - 1 > 0 && i - last - 1 <= maxGap) {
        for (let k = last + 1; k < i; k++) out[k] = 1;
      }
      last = i;
    }
    return out;
  }

  // Continuous pitch-shift curve over time. Inside a note it is the note's
  // shift (+ Line-tool offsets). Where two notes touch (legato) and at least
  // one is edited, the shift crossfades with a raised cosine instead of
  // stepping, so the corrected melody glides between notes like a singer
  // would. Regions are the contiguous time spans that need resynthesis;
  // each is rendered with ONE continuous grain schedule, so waveform phase
  // never restarts at a note boundary inside it.
  const PITCH_TRANSITION_SEC = 0.06;
  const MAX_TRANSITION_JUMP_ST = 7;
  const LEGATO_GAP_SEC = 0.03;
  function buildShiftPlan(segments, pitchTrack, opts) {
    opts = opts || {};
    const { times, f0s, voiced } = pitchTrack;
    const tw = opts.transitionSec != null ? opts.transitionSec : PITCH_TRANSITION_SEC;
    // Median pitch of the few voiced frames nearest a note edge.
    function edgeMidi(seg, fromEnd) {
      const vals = [];
      const lo = Math.max(0, seg.startFrame | 0), hi = Math.min(times.length, seg.endFrame | 0);
      for (let k = 0; k < hi - lo && vals.length < 3; k++) {
        const i = fromEnd ? hi - 1 - k : lo + k;
        if (voiced[i] && f0s[i] > 0) vals.push(freqToMidi(f0s[i]));
      }
      if (!vals.length) return NaN;
      vals.sort((a, b) => a - b);
      return vals[vals.length >> 1];
    }
    const ordered = segments.slice().sort((a, b) => a.startTime - b.startTime);
    const edited = ordered.map(segmentHasPitchEdit);
    const base = (seg, t) => (seg.shiftSemitones || 0) + (seg.fineCents || 0) / 100 + lineOffsetAt(seg, times, t);
    // trans[i] joins ordered[i] and ordered[i + 1].
    const trans = new Array(ordered.length).fill(null);
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i], b = ordered[i + 1];
      if (!(edited[i] || edited[i + 1]) || tw <= 0) continue;
      if (b.startTime - a.endTime > LEGATO_GAP_SEC) continue;
      // Only glide across a plausible sung connection. A larger jump is a
      // leap or, more often, an octave error in the analysis; resynthesising
      // the neighbour with a wrong period there sounds worse than a step.
      const jump = Math.abs(edgeMidi(b, false) - edgeMidi(a, true));
      if (!(jump <= MAX_TRANSITION_JUMP_ST)) continue;
      const mid = 0.5 * (a.endTime + b.startTime);
      const lo = mid - Math.min(tw, 0.3 * Math.max(0, a.endTime - a.startTime));
      const hi = mid + Math.min(tw, 0.3 * Math.max(0, b.endTime - b.startTime));
      if (hi - lo > 1e-4) trans[i] = { lo, hi, a, b };
    }
    const starts = ordered.map(sg => sg.startTime);
    function indexAt(t) {
      let lo = 0, hi = starts.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
      return idx;
    }
    function inTrans(tr, t, f) {
      if (!tr || t < tr.lo || t > tr.hi) return null;
      const w = 0.5 - 0.5 * Math.cos(Math.PI * (t - tr.lo) / (tr.hi - tr.lo));
      return (1 - w) * f(tr.a, t) + w * f(tr.b, t);
    }
    function curveAt(t, f) {
      const j = indexAt(t);
      let v = j >= 1 ? inTrans(trans[j - 1], t, f) : null;
      if (v == null && j >= 0) v = inTrans(trans[j], t, f);
      if (v != null) return v;
      if (j >= 0 && t < ordered[j].endTime && edited[j]) return f(ordered[j], t);
      return 0;
    }
    const shiftAt = (t) => curveAt(t, base);
    // Formant shift (semitones of spectral-envelope movement) follows the same
    // note-to-note transition as pitch, so a vowel colour never jumps.
    const formantAt = (t) => curveAt(t, (seg) => seg.formantSemitones || 0);
    const regions = [];
    for (let i = 0; i < ordered.length; i++) {
      if (!edited[i]) continue;
      const lo = i > 0 && trans[i - 1] ? trans[i - 1].lo : ordered[i].startTime;
      const hi = trans[i] ? trans[i].hi : ordered[i].endTime;
      const last = regions[regions.length - 1];
      if (last && lo <= last.endTime + 0.002) last.endTime = Math.max(last.endTime, hi);
      else regions.push({ startTime: lo, endTime: hi });
    }
    // A neighbour that is itself unedited still receives the transition tail.
    for (let i = 0; i < trans.length; i++) {
      const tr = trans[i];
      if (!tr) continue;
      for (const r of regions) {
        if (tr.hi >= r.startTime - 0.002 && tr.lo <= r.endTime + 0.002) {
          r.startTime = Math.min(r.startTime, tr.lo);
          r.endTime = Math.max(r.endTime, tr.hi);
        }
      }
    }
    function regionAt(t) {
      for (const r of regions) if (t >= r.startTime && t < r.endTime) return r;
      return null;
    }
    return { shiftAt, formantAt, regions, regionAt };
  }

  // Time spans that resynthesis renders as one continuous grain schedule.
  // Local (single-note) renders must cover a whole span so their splice
  // points fall where the output is still the dry original.
  function resynthRegions(segments, pitchTrack, opts) {
    return buildShiftPlan(segments, pitchTrack, opts).regions.map(r => ({ startTime: r.startTime, endTime: r.endTime }));
  }

  // Long setup passes are written as generators that `yield` every few
  // hundred iterations. Synchronous callers drain them at once (same result as
  // a plain function); the iPhone chunked render drives them with a time
  // budget so the UI thread gets a turn between slices.
  function drain(it) {
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  }
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  async function drive(it, budgetMs) {
    let last = nowMs();
    let r = it.next();
    while (!r.done) {
      if (nowMs() - last >= budgetMs) {
        await new Promise(requestAnimationFrame);
        last = nowMs();
      }
      r = it.next();
    }
    return r.value;
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
    return drain(buildGrainScheduleGen(sr, n, pitchTrack, segments, opts));
  }

  function* buildGrainScheduleGen(sr, n, pitchTrack, segments, opts) {
    opts = opts || {};
    let tick = 0;
    const defaultF0 = opts.defaultF0 || 150.0;
    const guideSignal = opts.guideSignal || null;
    const { times, f0s, voiced } = pitchTrack;
    const filledF0 = fillUnvoiced(f0s, voiced, defaultF0);
    const tail = Math.floor(sr * 0.08);
    const outLen = n + tail;
    const grains = [];
    // Output sample ranges that actually receive PSOLA grains. The wet/dry
    // blend must stay inside these ranges; elsewhere the wet signal is silent.
    const cells = [];

    const plan = opts.shiftPlan || buildShiftPlan(segments, pitchTrack, opts);
    const voicedB = bridgeVoicing(voiced, 2);

    for (const seg of plan.regions) {
      yield;
      const marks = buildSourceMarksForSegment(sr, n, times, filledF0, guideSignal, seg, defaultF0);
      if (!marks.length) continue;

      // Start synthesis on the first real source mark that falls in the region.
      let first = 0;
      while (first + 1 < marks.length && marks[first].time < seg.startTime) first++;
      let outTime = Math.max(seg.startTime, marks[first].time);
      let sourceHint = first;
      let safety = 0;

      // Plain app segments carry no durationSec, so bound the loop by the
      // region's own time range (a NaN bound once silenced edited notes).
      const segDuration = Math.max(0, seg.endTime - seg.startTime);
      while (outTime < seg.endTime && safety++ < Math.ceil(segDuration * 1700) + 32) {
        if ((++tick & 127) === 0) yield;
        const vHere = nearestFlag(outTime, times, voicedB);
        const pIn = inputPeriodAt(outTime, times, filledF0, defaultF0);
        let shiftSemi = plan.shiftAt(outTime);
        if (!vHere) shiftSemi = 0;
        const ratio = Math.min(2.0, Math.max(0.5, Math.pow(2, shiftSemi / 12)));
        const pOut = pIn / ratio;
        // Spectral-envelope (formant) ratio for this instant; 1 = untouched.
        // Not applied where the shift is suppressed for an unvoiced frame.
        const formantSemi = vHere ? Math.max(-MAX_FORMANT_ST, Math.min(MAX_FORMANT_ST, plan.formantAt(outTime))) : 0;
        const fmtRatio = Math.pow(2, formantSemi / 12);

        // Inside a region every voiced cycle is resynthesised, even where the
        // shift curve passes through 0 (e.g. a -2 -> +2 transition): leaving
        // a gap there dropped the grain chain and briefly let the dry,
        // differently phased original through.
        if (vHere) {
          const bracket = bracketingSourceMarks(marks, outTime, sourceHint);
          sourceHint = bracket.index;

          // Crossfade the two real source cycles around this instant in the
          // grain domain. This avoids an obvious repeated single-cycle
          // fingerprint while preserving each cycle's spectral envelope (the
          // singer's vowel/formant character). It is used at every shift size:
          // switching to a single nearest cycle below ~1.5 st made the texture
          // change audibly mid-glide and measured less continuous.
          let sources;
          if (!bracket.right || bracket.right === bracket.left) {
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
          const cellHalf = Math.max(1, Math.round(pOut * sr * 0.5));
          const cellLo = Math.max(0, outCenter - cellHalf, Math.round(seg.startTime * sr));
          const cellHi = Math.min(n, outCenter + cellHalf, Math.round(seg.endTime * sr));
          if (cellHi > cellLo) {
            const last = cells.length ? cells[cells.length - 1] : null;
            if (last && cellLo <= last[1] + 2) last[1] = Math.max(last[1], cellHi);
            else cells.push([cellLo, cellHi]);
          }
          for (const src of sources) {
            const m = src.mark;
            const srcCenter = m.sample;
            const periodSamples = Math.max(8, m.periodSamples);
            // Wide source-period grains overlap destructively when synthesis
            // marks are closer together than source marks (upward shifts).
            // Bound the window by the target period to keep adjacent grains
            // from cancelling a voiced cycle and creating a short dropout.
            const half = Math.max(8, Math.round(Math.min(periodSamples, pOut * sr * 0.84)));
            const start = Math.max(0, srcCenter - half);
            const end = Math.min(n, srcCenter + half);
            if (end - start < 8) continue;
            const grainLen = end - start;
            let oStart = outCenter - (srcCenter - start);
            let oEnd = oStart + grainLen;
            let gLo = 0, gHi = grainLen;
            if (oStart < 0) { gLo = -oStart; oStart = 0; }
            if (oEnd > outLen) { gHi -= (oEnd - outLen); oEnd = outLen; }
            if (gHi > gLo) {
              const grain = { start, gLo, gHi, oStart, grainLen, gain: src.gain };
              if (formantSemi) { grain.fmt = fmtRatio; grain.center = srcCenter - start; }
              grains.push(grain);
            }
          }
        }
        outTime += Math.max(1 / sr, pOut);
      }
    }

    const resultLen = Math.min(outLen, n + Math.floor(0.05 * sr));
    return { grains, outLen, resultLen, cells };
  }

  // Overlap-add normalisation floor. Upward shifts (and small downward ones)
  // always overlap by at least ~0.7, so they keep exact window-sum
  // normalisation. Large downward shifts leave gaps between grains; dividing
  // by a near-zero window sum there un-tapered each grain (a hard edge, and
  // at an octave down literally a 0 sample between grains) and restored the
  // original period, so the note buzzed at the old pitch.
  const NORM_FLOOR = 0.5;
  // Formant shift range, semitones each way. Grain resampling keeps the
  // vowel intelligible up to about this much; beyond it grains smear.
  const MAX_FORMANT_ST = 5;

  // Grain sample i, read with the source time axis scaled by g.fmt around the
  // grain centre (linear interpolation). fmt > 1 reads faster, which moves the
  // spectral envelope (formants) up; the pitch is set by grain spacing, not
  // by this read, so the two stay independent.
  function readGrainSample(signal, g, i) {
    const pos = g.start + g.center + (i - g.center) * g.fmt;
    const i0 = Math.floor(pos);
    if (i0 < 0 || i0 + 1 >= signal.length) return 0;
    const fr = pos - i0;
    return signal[i0] * (1 - fr) + signal[i0 + 1] * fr;
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
        out[oi] += (g.fmt ? readGrainSample(signal, g, i) : signal[g.start + i]) * win[i] * gain;
        outNorm[oi] += win[i] * gain;
      }
    }
    const result = new Float32Array(resultLen);
    for (let i = 0; i < resultLen; i++) result[i] = out[i] / Math.max(outNorm[i], NORM_FLOOR);
    return result;
  }

  // Build a sample-domain wet mask so PSOLA is used only where it is actually
  // needed: voiced + edited material. Unedited audio, consonants, breaths and
  // other unvoiced/transient material stay on the original waveform. This is
  // deliberately conservative because re-graining ratio=1 material can still
  // soften attacks and add a faint phasey texture even when pitch is unchanged.
  function buildResynthBlendMask(sr, n, pitchTrack, segments, opts) {
    return featherBlendMask(buildResynthBlendMaskRaw(sr, n, pitchTrack, segments, opts), sr);
  }

  function featherBlendMask(mask, sr) {
    return featherMask(mask, Math.max(8, Math.round(sr * 0.008)));
  }
  function* featherBlendMaskGen(mask, sr) {
    return yield* featherMaskGen(mask, Math.max(8, Math.round(sr * 0.008)));
  }

  // The hard 0/1 mask, before feathering (split out so the iPhone chunked
  // render can give the UI thread a turn between the two steps).
  function buildResynthBlendMaskRaw(sr, n, pitchTrack, segments, opts) {
    return drain(buildResynthBlendMaskRawGen(sr, n, pitchTrack, segments, opts));
  }

  function* buildResynthBlendMaskRawGen(sr, n, pitchTrack, segments, opts) {
    opts = opts || {};
    const mask = new Float32Array(n);
    const { times, voiced, clarity, f0s } = pitchTrack;
    if (!times || times.length === 0 || !voiced || voiced.length === 0) return mask;
    const guideSignal = opts.guideSignal || null;

    // Frame-wise confidence mask. Besides YIN voiced/unvoiced, require stable
    // voiced neighbors and enough cycle periodicity. This intentionally leaves
    // the first/last frame of a voiced run dry, which protects consonants and
    // breathy attacks from the pitch shifter.
    // pitchTrack.hopSize is in ANALYSIS samples, which differ from the output
    // rate when iPhone analyses a downsampled copy. Derive the frame spacing
    // from the frame times so every voiced frame covers its whole interval.
    const hopSec = times.length > 1
      ? (times[times.length - 1] - times[0]) / (times.length - 1)
      : (pitchTrack.hopSize || 512) / sr;
    const hop = Math.max(1, Math.round(hopSec * sr));
    const plan = opts.shiftPlan || buildShiftPlan(segments, pitchTrack, opts);
    const voicedB = bridgeVoicing(voiced, 2);
    for (let fi = 0; fi < times.length; fi++) {
      if ((fi & 127) === 127) yield;
      if (!voicedB[fi]) continue;
      const prevVoiced = fi > 0 ? !!voicedB[fi - 1] : false;
      const nextVoiced = fi + 1 < voicedB.length ? !!voicedB[fi + 1] : false;
      if (!prevVoiced || !nextVoiced) continue;
      if (clarity && clarity.length > fi && clarity[fi] > 0 && clarity[fi] < 0.84) continue;

      const t = times[fi];
      const seg = plan.regionAt(t);
      if (!seg) continue;

      const center = Math.round(t * sr);
      if (guideSignal && f0s && f0s[fi] > 0) {
        const periodicity = localPeriodicity(guideSignal, center, sr / f0s[fi]);
        // 0.30 is deliberately permissive for breathy singing, but rejects
        // noise/consonant regions whose apparent YIN pitch is unstable.
        if (periodicity < 0.30) continue;
      }

      // Never let a frame spill outside its resynthesis region, where no
      // grains exist.
      const lo = Math.max(0, center - (hop >> 1), Math.round(seg.startTime * sr));
      const hi = Math.min(n, center + ((hop + 1) >> 1), Math.round(seg.endTime * sr));
      for (let i = lo; i < hi; i++) mask[i] = 1;
    }

    return mask;
  }

  // Feathering (featherBlendMask, ~8 ms) keeps consonant/vowel boundaries and
  // segment edges from clicking when switching between dry and PSOLA audio.
  // Box-filter a 0/1 mask: out[o] = min(1, sum(mask[o-fade..o+fade]) / fade),
  // with zeros outside the array. Away from a 0<->1 change the whole window
  // holds one value and the result equals the input, so only the ~2*fade
  // samples around each change are summed. Identical output to the plain
  // sliding sum, without touching every sample of a long song.
  function featherMask(mask, fade) {
    return drain(featherMaskGen(mask, fade));
  }

  function* featherMaskGen(mask, fade) {
    const n = mask.length;
    const out = new Float32Array(n);
    out.set(mask);
    const norm = Math.max(1, fade);
    const dirty = (b) => {
      // outputs whose window contains both sides of the change at b
      const d0 = Math.max(0, b - fade), d1 = Math.min(n - 1, b + fade - 1);
      if (d1 < d0) return;
      let acc = 0;
      for (let i = Math.max(0, d0 - fade); i <= Math.min(n - 1, d0 + fade); i++) acc += mask[i];
      for (let o = d0; o <= d1; o++) {
        out[o] = Math.min(1, acc / norm);
        const next = o + fade + 1, drop = o - fade;
        acc += (next < n ? mask[next] : 0) - (drop >= 0 ? mask[drop] : 0);
      }
    };
    if (n === 0) return out;
    if (mask[0] !== 0) dirty(0);
    for (let i = 1; i < n; i++) {
      if (mask[i] !== mask[i - 1]) dirty(i);
      if ((i & 0x3ffff) === 0) yield;
    }
    if (mask[n - 1] !== 0) dirty(n);
    return out;
  }

  // The feathered blend mask can reach a few milliseconds past the first or
  // last synthesis mark of a note, where the wet signal has no grains at all.
  // Mixing that silence in produced an audible hole followed by a hard click
  // at every edited note boundary. Restrict the blend to the ranges that
  // actually received grains, fading in/out inside them.
  function limitBlendToCoverage(blend, cells, sr) {
    const n = blend.length;
    const fade = Math.max(8, Math.round(sr * 0.006));
    let pos = 0;
    for (const [a, b] of cells) {
      for (let i = pos; i < Math.min(a, n); i++) blend[i] = 0;
      for (let i = a; i < Math.min(b, n); i++) {
        const edge = Math.min(i - a, b - 1 - i);
        if (edge < fade) blend[i] *= edge / fade;
      }
      pos = Math.max(pos, b);
    }
    for (let i = pos; i < n; i++) blend[i] = 0;
    return blend;
  }

  // PSOLA can lower a vowel's level even when its pitch remains correct,
  // especially when neighboring grains overlap at a new period. Restore only
  // clearly attenuated edited regions using a shared, slowly changing gain.
  // The same gain on every channel preserves the stereo image, and the sparse
  // frame table avoids another full-length audio buffer on mobile devices.
  function restoreEditedLevel(channels, outputs, blend, sr, guide) {
    const n = outputs[0].length;
    // A 20 ms window hides the short cancellation at a wet/dry boundary.
    // Use 5 ms frames so a single attenuated transition can be restored.
    const hop = Math.max(1, Math.round(sr * 0.005));
    const radius = hop;
    const dry = channels[guide], wet = outputs[guide];
    const gains = new Float32Array(Math.ceil(n / hop) + 1);
    gains.fill(1);
    for (let frame = 0; frame < gains.length; frame++) {
      const center = Math.min(n - 1, frame * hop);
      if (blend[center] < 0.05) continue;
      const lo = Math.max(0, center - radius), hi = Math.min(n, center + radius);
      let dryPower = 0, wetPower = 0, peak = 0;
      for (let i = lo; i < hi; i++) {
        dryPower += dry[i] * dry[i];
        wetPower += wet[i] * wet[i];
        peak = Math.max(peak, Math.abs(wet[i]));
      }
      if (dryPower < (hi - lo) * 0.002 * 0.002 || wetPower >= dryPower * 0.49) continue;
      gains[frame] = Math.max(1, Math.min(2.5, 0.85 * Math.sqrt(dryPower / Math.max(wetPower, 1e-12)), 0.98 / Math.max(peak, 1e-9)));
    }
    for (let i = 0; i < n; i++) {
      if (blend[i] < 0.05) continue;
      const frame = Math.floor(i / hop), frac = (i - frame * hop) / hop;
      const gain = (gains[frame] * (1 - frac) + gains[frame + 1] * frac - 1) * blend[i] + 1;
      for (let c = 0; c < outputs.length; c++) outputs[c][i] *= gain;
    }
    return outputs;
  }

  // High-level: resynthesize one or more channels given the current
  // segment edits. The PSOLA render is blended only into edited voiced areas;
  // everywhere else remains sample-for-sample original.
  function resynthesizeCore(channels, sr, pitchTrack, segments, opts) {
    const n = channels[0].length;
    // Fast path: a file can contain many detected notes while none are edited.
    // Avoid even building the mono guide in that case.
    let hasAnyEdit = false;
    for (const seg of segments) { if (segmentHasPitchEdit(seg)) { hasAnyEdit = true; break; } }
    if (!hasAnyEdit) return channels.map((ch) => Float32Array.from(ch));

    const guide = guideChannelIndex(channels, opts);
    const guideSignal = makePsolaGuide(channels, guide);
    const sharedOpts = Object.assign({}, opts || {}, { guideSignal });
    sharedOpts.shiftPlan = buildShiftPlan(segments, pitchTrack, sharedOpts);
    const schedule = buildGrainSchedule(sr, n, pitchTrack, segments, sharedOpts);
    const blend = limitBlendToCoverage(buildResynthBlendMask(sr, n, pitchTrack, segments, sharedOpts), schedule.cells, sr);
    let anyWet = false;
    for (let i = 0; i < blend.length; i++) { if (blend[i] > 1e-5) { anyWet = true; break; } }
    if (!anyWet) return channels.map((ch) => Float32Array.from(ch));

    const winCache = makeWinCache();
    const outputs = channels.map((ch) => {
      const wet = applyGrainSchedule(ch, schedule, winCache);
      const out = new Float32Array(Math.min(n, wet.length));
      for (let i = 0; i < out.length; i++) {
        const m = blend[i];
        out[i] = ch[i] * (1 - m) + wet[i] * m;
      }
      return out;
    });
    return restoreEditedLevel(channels, outputs, blend, sr, guide);
  }


  // Key/scale snapping for the correction target. `scale` is a name from
  // SCALES; `root` is a pitch class 0-11 (C=0). Chromatic behaves like a plain
  // round(). Ties between two equally distant scale notes resolve upward.
  const SCALES = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    pentatonicMajor: [0, 2, 4, 7, 9],
    pentatonicMinor: [0, 3, 5, 7, 10],
  };

  function snapToScale(midi, root, scale) {
    const degrees = SCALES[scale] || SCALES.chromatic;
    if (!Number.isFinite(midi)) return midi;
    const base = Math.floor(midi);
    let best = Math.round(midi), bestDist = Infinity;
    for (let m = base - 12; m <= base + 13; m++) {
      const pc = ((m - root) % 12 + 12) % 12;
      if (!degrees.includes(pc)) continue;
      const d = Math.abs(m - midi);
      if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && m > best)) { best = m; bestDist = d; }
    }
    return best;
  }

  // Muted notes are silenced after rendering so they work with or without any
  // pitch edit. The 5 ms ramps stay inside the note: nothing outside it changes.
  function applyMutes(outputs, sr, segments) {
    const n = outputs[0].length;
    const fade = Math.max(1, Math.round(sr * 0.005));
    for (const seg of segments) {
      if (!seg.muted) continue;
      const a = Math.max(0, Math.round(seg.startTime * sr));
      const b = Math.min(n, Math.round(seg.endTime * sr));
      if (b <= a) continue;
      const f = Math.min(fade, (b - a) >> 1);
      for (const out of outputs) {
        for (let i = a; i < b; i++) {
          const d = Math.min(i - a, b - 1 - i);
          out[i] *= d >= f ? 0 : 1 - (d + 1) / (f + 1);
        }
      }
    }
    return outputs;
  }

  function resynthesize(channels, sr, pitchTrack, segments, opts) {
    return applyMutes(resynthesizeCore(channels, sr, pitchTrack, segments, opts), sr, segments);
  }

  async function resynthesizeChunked(channels, sr, pitchTrack, segments, opts) {
    return applyMutes(await resynthesizeChunkedCore(channels, sr, pitchTrack, segments, opts), sr, segments);
  }

  // iOS full-render path: same PSOLA schedule/blend math as resynthesize(),
  // but overlap-add is accumulated in bounded blocks. This removes the two
  // full-length Float64 work arrays per channel and yields between blocks.
  async function resynthesizeChunkedCore(channels, sr, pitchTrack, segments, opts) {
    opts = opts || {};
    const n = channels[0].length;
    let hasAnyEdit = false;
    for (const seg of segments) { if (segmentHasPitchEdit(seg)) { hasAnyEdit = true; break; } }
    if (!hasAnyEdit) return channels.map((ch) => Float32Array.from(ch));

    // Each setup stage is a single synchronous pass over the whole song. On a
    // phone they add up to a visible freeze, so hand the UI thread a turn
    // between stages (the block loop below already does the same).
    const turn = () => new Promise(requestAnimationFrame);
    const SLICE_MS = 10;
    const guide = guideChannelIndex(channels, opts);
    const guideSignal = makePsolaGuide(channels, guide);
    const sharedOpts = Object.assign({}, opts, { guideSignal });
    sharedOpts.shiftPlan = buildShiftPlan(segments, pitchTrack, sharedOpts);
    await turn();
    const schedule = await drive(buildGrainScheduleGen(sr, n, pitchTrack, segments, sharedOpts), SLICE_MS);
    await turn();
    const rawMask = await drive(buildResynthBlendMaskRawGen(sr, n, pitchTrack, segments, sharedOpts), SLICE_MS);
    await turn();
    const feathered = await drive(featherBlendMaskGen(rawMask, sr), SLICE_MS);
    const blend = limitBlendToCoverage(feathered, schedule.cells, sr);
    let anyWet = false;
    for (let i = 0; i < blend.length; i++) { if (blend[i] > 1e-5) { anyWet = true; break; } }
    if (!anyWet) return channels.map((ch) => Float32Array.from(ch));
    await turn();

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
            acc[bi] += (g.fmt ? readGrainSample(srcSignal, g, i) : srcSignal[g.start + i]) * win[i] * gain;
            norm[bi] += win[i] * gain;
          }
        }

        const out = outputs[c];
        for (let i = 0; i < blockLen; i++) {
          const globalI = blockStart + i;
          const wet = acc[i] / Math.max(norm[i], NORM_FLOOR);
          const m = blend[globalI];
          out[globalI] = srcSignal[globalI] * (1 - m) + wet * m;
        }
      }

      // Safari gets a paint/input opportunity without changing DSP boundaries.
      await new Promise(requestAnimationFrame);
    }
    return restoreEditedLevel(channels, outputs, blend, sr, guide);
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
    featherMask, stabilizeOctaveErrors, buildGrainSchedule, applyGrainSchedule, resynthesize, resynthesizeChunked, snapToScale, SCALES, makeWinCache, MAX_FORMANT_ST,
    resynthRegions, guideChannelIndex, PITCH_TRANSITION_SEC,
    encodeWav, encodeWavChunked,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PitchEngine;
  else root.PitchEngine = PitchEngine;
})(typeof window !== 'undefined' ? window : globalThis);
