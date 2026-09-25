(function () {
  'use strict';

  // ============================================================
  // Worker (analysis + resynthesis off the main thread).
  // Engine and Worker are now separate development modules; production
  // behavior and message protocol remain unchanged.
  // ============================================================
  let worker = null;
  let msgId = 0;
  const pending = new Map();

  function createAudioWorker() {
    if (worker) return worker;
    // The single-file build supplies an inline (Blob) worker URL.
    const nextWorker = new Worker(window.PITCH_EDITOR_WORKER_URL || './src/worker.js');
    nextWorker.onmessage = (e) => {
      const msg = e.data;
      const cb = pending.get(msg.id);
      if (!cb) return;
      if (msg.type === 'progress') {
        if (cb.onProgress) { try { cb.onProgress(msg.fraction); } catch (err) {} }
        return;
      }
      pending.delete(msg.id);
      if (msg.type === 'error') cb.reject(new Error(msg.message));
      else cb.resolve(msg);
    };
    nextWorker.onerror = (ev) => {
      // Safari can create a Blob Worker successfully and then fail it only
      // when the first real job runs. Never leave pending Promises hanging,
      // otherwise the UI can show a new pitch while playback still uses the old buffer.
      const err = new Error('Audio Worker failed');
      for (const [id, cb] of pending) {
        try { cb.reject(err); } catch (e) {}
      }
      pending.clear();
      try { nextWorker.terminate(); } catch (e) {}
      if (worker === nextWorker) worker = null;
      console.warn('Audio Worker will be recreated after runtime failure', ev);
    };
    worker = nextWorker;
    return nextWorker;
  }

  try {
    createAudioWorker();
  } catch (e) {
    worker = null;
  }

  const PE = window.PitchEngine;
  const WORKER_IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function mainThreadCall(payload) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          if (payload.type === 'analyze') {
            const pitchTrack = PE.yinPitchTrack(payload.signal, payload.sr, payload.opts || undefined);
            const segments = PE.segmentNotes(pitchTrack);
            resolve({ type: 'analyzed', pitchTrack, segments });
          } else if (payload.type === 'resynth') {
            const channels = PE.resynthesize(payload.channels, payload.sr, payload.pitchTrack, payload.segments);
            resolve({ type: 'resynthed', channels });
          } else if (payload.type === 'reference') {
            const refPitchTrack = PE.yinPitchTrack(payload.refSignal, payload.refSr, payload.opts || undefined);
            const out = PE.suggestFromReference(payload.vocalPitchTrack, payload.vocalSegments, refPitchTrack);
            resolve({
              type: 'referenced',
              suggestions: out.suggestions,
              expressions: out.expressions,
              alignXs: out.alignXs,
              alignYs: out.alignYs,
              alignRefXs: out.alignRefXs,
              alignRefYs: out.alignRefYs,
              refPitchTrack
            });
          } else {
            reject(new Error('Unknown task'));
          }
        } catch (err) {
          reject(err);
        }
      }, 0);
    });
  }

  function workerCall(payload, transfer, onProgress) {
    // iPhone Safari reliability path:
    // local per-note resynthesis is only a short slice, so avoiding Blob Worker
    // transfer here is cheap and prevents a class of stale-buffer failures.
    if (WORKER_IS_IOS && payload && payload.preferMainThread) {
      return mainThreadCall(payload);
    }
    if (!worker) {
      try { createAudioWorker(); } catch (e) {}
    }
    if (!worker) return mainThreadCall(payload);
    const activeWorker = worker;
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      try {
        activeWorker.postMessage(Object.assign({ id, reportProgress: !!onProgress }, payload), transfer || []);
      } catch (err) {
        pending.delete(id);
        try { activeWorker.terminate(); } catch (e) {}
        if (worker === activeWorker) worker = null;
        // postMessage failed before ownership transfer completed; retry locally.
        mainThreadCall(payload).then(resolve, reject);
      }
    });
  }

  // ============================================================
  // DOM refs
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const loadingScreen = $('loadingScreen'), editorScreen = $('editorScreen');
  const loadingStatus = $('loadingStatus');
  const topbar = $('topbar');
  const fileInput = $('fileInput');
  const refFileInput = $('refFileInput');
  const canvas = $('rollCanvas'), rollWrap = $('rollWrap');
  const ctx2d = canvas.getContext('2d');
  const inspector = $('inspector'), inspNote = $('inspNote'), inspOffset = $('inspOffset'), inspPlay = $('inspPlay');
  const inspBefore = $('inspBefore'), inspAfter = $('inspAfter'), inspTarget = $('inspTarget'), inspCenter = $('inspCenter'), inspRef = $('inspRef');
  const strengthRange = $('strengthRange'), strengthValue = $('strengthValue');
  const strengthPresets = $('strengthPresets'), autoCorrectBtn = $('autoCorrectBtn'), autoCorrectLabel = $('autoCorrectLabel');
  const toast = $('toast');
  const a11yStatus = $('a11yStatus');
  const accessibleNoteNav = $('accessibleNoteNav');
  const a11yPreviousNote = $('a11yPreviousNote'), a11yNextNote = $('a11yNextNote');
  const guideMode = $('guideMode');
  const guideText = $('guideText');

  // Keep unavailable editor actions out of the VoiceOver focus order before
  // there is a track to edit. The file picker remains available for recovery.
  $('backBtn').setAttribute('aria-label', 'ボーカル音源を選択');
  $('emptyUploadBtn').setAttribute('aria-label', 'ボーカル音源を選択');
  $('fileInput').setAttribute('aria-label', 'ボーカル音源ファイル');
  $('refFileInput').setAttribute('aria-label', 'お手本音源ファイル');

  function updateInteractionGuide() {
    if (!guideMode || !guideText || typeof S === 'undefined') return;
    if (S.splitArmed) {
      guideMode.textContent = '分割';
      guideText.textContent = '分けたいノート上の位置をタップ';
    } else if (S.mode === 'line') {
      guideMode.textContent = 'ライン';
      guideText.textContent = '白いピッチ線をなぞって細かく補正・2本指で横ズーム';
    } else {
      guideMode.textContent = 'ノート';
      guideText.textContent = 'タップで詳細 / 上下ドラッグでピッチ移動 / 横スワイプで移動 / 2本指でズーム';
    }
    const noteMode = $('modeNoteBtn'), lineMode = $('modeLineBtn'), splitButton = $('splitBtn');
    if (noteMode) noteMode.setAttribute('aria-pressed', String(S.mode === 'note' && !S.splitArmed));
    if (lineMode) lineMode.setAttribute('aria-pressed', String(S.mode === 'line' && !S.splitArmed));
    if (splitButton) splitButton.setAttribute('aria-pressed', String(!!S.splitArmed));
  }

  // ============================================================
  // App state
  // ============================================================
  const S = {
    audioCtx: null,
    sr: 44100,
    numCh: 1,
    origChannels: null,   // iPhone: AudioBuffer channel views; other browsers: immutable PCM copies
    monoSignal: null,     // Float64Array mono mix for analysis
    pitchTrack: null,
    segments: null,
    editedChannels: null, // current resynthesized audio (Float32Array[])
    editedBuffer: null,   // AudioBuffer built from editedChannels
    fileBaseName: 'audio',

    // view transform
    viewStartSec: 0,
    pxPerSec: 120,
    minMidi: 55, maxMidi: 79,
    rowHeight: 20,
    rulerHeight: 26,

    selectedSegId: null,
    dragging: null, // {segId, startY, startShift, baseFine, moved}
    panning: null,  // {startX, startY, startView}
    lastTapTime: 0,
    lastTapSeg: null,

    playing: false,
    playSource: null,
    playStartCtxTime: 0,
    playStartOffsetSec: 0,

    resynthTimer: null,
    resynthBusy: false,
    resynthQueued: false,
    pendingFullResynth: false,
    editRevision: 0,
    audioRevision: 0,
    pendingPlaybackRequest: false,
    pendingResynthSet: new Set(),
    audioSessionId: 0,
    undoStack: [],
    undoLimit: 10,

    mode: 'note',       // 'note' (drag whole blob) | 'line' (free-hand paint the curve)
    splitArmed: false,  // next tap on a blob splits it there instead of selecting it
    previewSegId: null, // segment to solo-preview once the pending resynth finishes
    soloSource: null,   // active solo-preview AudioBufferSourceNode
    autoPreviewEnabled: false, // default OFF on mobile; user can enable it manually
    correctionStrength: 0.60, // 0..1; center/ref actions preserve natural pitch motion and move only the note center

    referenceLoaded: false, // segments carry .refSuggestMidi and optional .refExpression once true
    referenceBuffer: null,  // AudioBuffer, full quality, for reference playback
    refPitchTrack: null,    // reference's own YIN pitch track, for the overlay curve
    refAlignXs: null, refAlignYs: null,       // DTW time map: vocal time -> reference time
    refAlignRefXs: null, refAlignRefYs: null, // DTW time map: reference time -> vocal time
    refSource: null, refPlaying: false,
    refPlayStartCtxTime: 0, refPlayStartRefTime: 0, // for animating the reference playhead

    // iPhone/Safari memory protection
    analysisDownsampled: false,
    analysisSampleRate: null,
  };

  function toastMsg(text, ms, assertive = false) {
    toast.textContent = text;
    toast.setAttribute('role', assertive ? 'alert' : 'status');
    toast.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    toast.style.display = 'block';
    clearTimeout(toastMsg._t);
    toastMsg._t = setTimeout(() => { toast.style.display = 'none'; }, ms || 1600);
  }

  // Loading overlay progress. fraction null = stage without measurable
  // progress (decoding), shown as an indeterminate bar.
  const loadingProgress = $('loadingProgress'), loadingProgressFill = $('loadingProgressFill');
  function setLoadingProgress(fraction) {
    if (!loadingProgress || !loadingProgressFill) return;
    loadingProgress.hidden = false;
    if (fraction == null) {
      loadingProgress.classList.add('indeterminate');
      loadingProgress.removeAttribute('aria-valuenow');
      loadingProgressFill.style.width = '';
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    loadingProgress.classList.remove('indeterminate');
    loadingProgress.setAttribute('aria-valuenow', String(pct));
    loadingProgressFill.style.width = pct + '%';
  }

  function ensureAudioContext() {
    if (!S.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('このSafariではWeb Audioを利用できません');
      S.audioCtx = new AC();
    }
    return S.audioCtx;
  }

  async function unlockAudio() {
    const ac = ensureAudioContext();
    if (ac.state === 'suspended') {
      try { await ac.resume(); } catch (e) {}
    }
    return ac;
  }

  async function estimateWavMemoryMB(file, outputSampleRate) {
    // WAV carries its decoded format in a small header, so reject oversized
    // iPhone imports before allocating the full compressed-file ArrayBuffer.
    // Walk RIFF chunks instead of assuming the usual 44-byte PCM header.
    if (!file || !/\.wave?$/i.test(file.name) || file.size < 44) return null;
    const header = await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer();
    const view = new DataView(header);
    const fourCC = (offset) => offset + 4 <= view.byteLength
      ? String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
      : '';
    if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WAVE') return null;

    let channels = 0, sampleRate = 0, blockAlign = 0, dataBytes = 0, format = 0;
    for (let offset = 12; offset + 8 <= view.byteLength;) {
      const id = fourCC(offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === 'fmt ' && size >= 16 && body + 16 <= view.byteLength) {
        format = view.getUint16(body, true);
        if (format === 0xfffe && size >= 40 && body + 40 <= view.byteLength) {
          const subtype = view.getUint32(body + 24, true);
          const guidTail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
          const hasStandardSubtypeGuid = guidTail.every((byte, index) => view.getUint8(body + 28 + index) === byte);
          if (hasStandardSubtypeGuid && (subtype === 1 || subtype === 3)) format = subtype;
        }
        channels = view.getUint16(body + 2, true);
        sampleRate = view.getUint32(body + 4, true);
        blockAlign = view.getUint16(body + 12, true);
      } else if (id === 'data') {
        dataBytes = size;
        break;
      }
      const next = body + size + (size & 1);
      if (next <= offset || next > view.byteLength) break;
      offset = next;
    }
    // Compressed WAV subformats can encode many frames per block. Let Web
    // Audio decode those and use its exact AudioBuffer dimensions instead.
    if (![1, 3].includes(format) || !channels || !sampleRate || !blockAlign || !dataBytes) return null;

    const frames = dataBytes / blockAlign;
    const durationSec = frames / sampleRate;
    const decodedFrames = durationSec * Math.max(sampleRate, outputSampleRate || sampleRate);
    // Match the conservative post-decode estimate used by loadFile.
    return (decodedFrames * channels * 4 * 3 + decodedFrames * 8 * 3) / (1024 * 1024);
  }

  function estimateDecodedMemoryMBForDuration(durationSec, outputSampleRate, channels = 2, safety = 1.15) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    const frames = Math.ceil(durationSec * Math.max(22050, outputSampleRate || 48000));
    return (frames * channels * 4 * 3 + frames * 8 * 3) / (1024 * 1024) * safety;
  }

  async function estimateM4AMemoryMB(file, outputSampleRate) {
    if (!/\.m4a$/i.test(file.name)) return null;
    // Walk top-level ISO-BMFF atoms by offset so an mdat payload is never
    // read into memory. The movie header is normally at the start or end.
    for (let offset = 0, count = 0; offset + 8 <= file.size && count < 32; count++) {
      const header = await file.slice(offset, Math.min(file.size, offset + 16)).arrayBuffer();
      if (header.byteLength < 8) return null;
      const view = new DataView(header);
      let size = view.getUint32(0, false);
      const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
      let headerSize = 8;
      if (size === 1) {
        if (header.byteLength < 16) return null;
        const largeSize = view.getBigUint64(8, false);
        if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(largeSize);
        headerSize = 16;
      } else if (size === 0) size = file.size - offset;
      if (size < headerSize || offset + size > file.size) return null;
      if (type === 'moov') {
        const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + size, offset + 4 * 1024 * 1024)).arrayBuffer());
        let mvhd = -1;
        for (let i = 4; i + 24 <= bytes.length; i++) {
          if (bytes[i] === 109 && bytes[i + 1] === 118 && bytes[i + 2] === 104 && bytes[i + 3] === 100) { mvhd = i; break; }
        }
        if (mvhd < 0) return null;
        const movie = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = movie.getUint8(mvhd + 4);
        const timescaleOffset = mvhd + (version === 1 ? 24 : 16);
        const durationOffset = timescaleOffset + 4;
        if (durationOffset + (version === 1 ? 8 : 4) > movie.byteLength) return null;
        const timescale = movie.getUint32(timescaleOffset, false);
        const duration = version === 1
          ? Number(movie.getBigUint64(durationOffset, false))
          : movie.getUint32(durationOffset, false);
        if (!timescale || !Number.isFinite(duration)) return null;
        return estimateDecodedMemoryMBForDuration(duration / timescale, outputSampleRate, 2);
      }
      offset += size;
    }
    return null;
  }

  async function estimateMP3MemoryMB(file, outputSampleRate) {
    if (!/\.mp3$/i.test(file.name) || file.size < 4) return null;
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
    let start = 0;
    if (bytes.length >= 10 && bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
      const tagSize = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127);
      start = 10 + tagSize + ((bytes[5] & 16) ? 10 : 0);
    }
    // Header layer bits are 3=Layer I, 2=Layer II, 1=Layer III.
    const mpeg1Rates = {3:[32,64,96,128,160,192,224,256,288,320,352,384,416,448],2:[32,48,56,64,80,96,112,128,160,192,224,256,320,384],1:[32,40,48,56,64,80,96,112,128,160,192,224,256,320]};
    const mpeg2Rates = {3:[32,48,56,64,80,96,112,128,144,160,176,192,224,256],2:[8,16,24,32,40,48,56,64,80,96,112,128,144,160],1:[8,16,24,32,40,48,56,64,80,96,112,128,144,160]};
    const baseRates = [44100,48000,32000];
    function frameAt(data, offset) {
      if (offset + 4 > data.length || data[offset] !== 255 || (data[offset + 1] & 224) !== 224) return null;
      const version = (data[offset + 1] >> 3) & 3;
      const layer = (data[offset + 1] >> 1) & 3;
      const bitrateIndex = (data[offset + 2] >> 4) & 15;
      const sampleIndex = (data[offset + 2] >> 2) & 3;
      if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
      const table = version === 3 ? mpeg1Rates : mpeg2Rates;
      const bitrate = table[layer][bitrateIndex - 1] * 1000;
      const sampleRate = baseRates[sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      const padding = (data[offset + 2] >> 1) & 1;
      const samples = layer === 3 ? 384 : (layer === 1 && version !== 3 ? 576 : 1152);
      const frameBytes = layer === 3 ? Math.floor(12 * bitrate / sampleRate + padding) * 4
        : Math.floor((version === 3 || layer === 2 ? 144 : 72) * bitrate / sampleRate) + padding;
      return { version, layer, sampleRate, samples, frameBytes, mode:(data[offset + 3] >> 6) & 3 };
    }
    let first = null, firstOffset = -1;
    for (let i = start; i + 4 <= bytes.length; i++) {
      const frame = frameAt(bytes, i);
      if (!frame || frame.frameBytes < 4 || i + frame.frameBytes + 4 > bytes.length) continue;
      const nextFrame = frameAt(bytes, i + frame.frameBytes);
      if (nextFrame && nextFrame.sampleRate === frame.sampleRate) { first = frame; firstOffset = i; break; }
    }
    if (!first) return null;
    const crcBytes = (bytes[firstOffset + 1] & 1) ? 0 : 2;
    const mono = first.mode === 3;
    const sideInfo = first.version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const xing = firstOffset + 4 + crcBytes + sideInfo;
    if (xing + 12 <= bytes.length &&
        ((bytes[xing] === 88 && bytes[xing+1] === 105 && bytes[xing+2] === 110 && bytes[xing+3] === 103) ||
         (bytes[xing] === 73 && bytes[xing+1] === 110 && bytes[xing+2] === 102 && bytes[xing+3] === 111))) {
      const flags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(xing + 4, false);
      if ((flags & 1) && xing + 12 <= bytes.length) {
        const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(xing + 8, false);
        if (count) return estimateDecodedMemoryMBForDuration(count * first.samples / first.sampleRate, outputSampleRate, mono ? 1 : 2);
      }
    }
    // Xing-less VBR files can change bitrate after a quiet/high-quality intro.
    // Sample equal windows at the start, middle and end instead of extrapolating
    // from the first megabyte; no compressed-file-sized allocation or full scan.
    const windowBytes = Math.min(256 * 1024, file.size);
    const starts = [...new Set([0, Math.max(0, Math.floor((file.size-windowBytes)/2)), Math.max(0, file.size-windowBytes)])];
    let sampledBytes = 0, sampledSeconds = 0;
    for (const sampleStart of starts) {
      const data = sampleStart === 0 ? bytes.subarray(0, windowBytes)
        : new Uint8Array(await file.slice(sampleStart, sampleStart + windowBytes).arrayBuffer());
      let offset = 0, frames = 0;
      while (offset + 4 <= data.length && frames < 12000) {
        const frame = frameAt(data, offset);
        if (!frame || frame.frameBytes < 4 || offset + frame.frameBytes > data.length) { offset++; continue; }
        const nextOffset = offset + frame.frameBytes;
        if (nextOffset + 4 <= data.length) {
          const nextFrame = frameAt(data, nextOffset);
          if (!nextFrame || nextFrame.sampleRate !== frame.sampleRate) { offset++; continue; }
        }
        sampledBytes += frame.frameBytes;
        sampledSeconds += frame.samples / frame.sampleRate;
        frames++; offset = nextOffset;
      }
    }
    if (!sampledBytes || !sampledSeconds) return null;
    const seconds = file.size * sampledSeconds / sampledBytes * 1.5;
    return estimateDecodedMemoryMBForDuration(seconds, outputSampleRate, mono ? 1 : 2, 1);
  }

  async function estimateADTSMemoryMB(file, outputSampleRate) {
    if (!/\.aac$/i.test(file.name) || file.size < 7) return null;
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer());
    const rates = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
    let offset = 0, sampledBytes = 0, decodedSeconds = 0, channels = 1, frames = 0;
    while (offset + 7 <= bytes.length && frames < 5000) {
      if (bytes[offset] !== 255 || (bytes[offset + 1] & 246) !== 240) { offset++; continue; }
      const sampleIndex = (bytes[offset + 2] >> 2) & 15;
      const frameBytes = ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
      const headerBytes = (bytes[offset + 1] & 1) ? 7 : 9;
      if (sampleIndex >= rates.length || frameBytes < headerBytes || offset + frameBytes > bytes.length) { offset++; continue; }
      const channelConfig = ((bytes[offset + 2] & 1) << 2) | ((bytes[offset + 3] >> 6) & 3);
      channels = Math.max(channels, channelConfig === 1 ? 1 : 2);
      const rawBlocks = (bytes[offset + 6] & 3) + 1;
      decodedSeconds += rawBlocks * 1024 / rates[sampleIndex];
      sampledBytes += frameBytes; frames++; offset += frameBytes;
    }
    if (!frames || !sampledBytes) return null;
    const duration = file.size / sampledBytes * decodedSeconds * 1.35;
    return estimateDecodedMemoryMBForDuration(duration, outputSampleRate, channels, 1);
  }

  async function estimateCompressedAudioMemoryMB(file, outputSampleRate) {
    try {
      const decodedWorkingSet = await estimateMP3MemoryMB(file, outputSampleRate) ??
        await estimateM4AMemoryMB(file, outputSampleRate) ??
        await estimateADTSMemoryMB(file, outputSampleRate);
      if (decodedWorkingSet == null) return null;
      // decodeAudioFile keeps the compressed ArrayBuffer live while Web Audio
      // allocates the decoded AudioBuffer; include that transient peak too.
      return decodedWorkingSet + file.size / (1024 * 1024);
    } catch (err) {
      console.warn('Could not estimate compressed audio duration before decoding', err);
      return null;
    }
  }

  async function decodeAudioFile(file) {
    if (!file || !file.size) throw new Error('空のファイルです');
    // Keep a practical ceiling for iPhone memory pressure. This is not a hard format limit.
    if (file.size > 300 * 1024 * 1024) {
      throw new Error('ファイルが大きすぎます。300MB以下を推奨します');
    }
    const ac = await unlockAudio();
    if (IS_IOS) {
      const estimatedMB = await estimateWavMemoryMB(file, ac.sampleRate) ??
        await estimateCompressedAudioMemoryMB(file, ac.sampleRate);
      if (estimatedMB != null && estimatedMB > 430) {
        throw new Error('この音源はiPhoneのメモリ上限に近いため読み込めません。短く分割するか、より短い音源をお試しください。');
      }
    }
    const arrayBuf = await file.arrayBuffer();

    // Modern Safari accepts the original ArrayBuffer directly. Avoid slice(0):
    // on large iPhone files it briefly duplicated the entire compressed file in memory.
    // The input is disposable after decodeAudioData, so allowing Web Audio to consume it
    // is both safe for this path and materially lowers peak memory.
    return await new Promise((resolve, reject) => {
      let settled = false;
      const ok = (buf) => { if (!settled) { settled = true; resolve(buf); } };
      const ng = (err) => { if (!settled) { settled = true; reject(err || new Error('音声デコードに失敗しました')); } };
      try {
        const p = ac.decodeAudioData(arrayBuf, ok, ng);
        if (p && typeof p.then === 'function') p.then(ok, ng);
      } catch (err) {
        ng(err);
      }
    });
  }

  // Unlock Web Audio from a real touch/click as early as possible on iPhone.
  document.addEventListener('pointerdown', () => { unlockAudio().catch(() => {}); }, { once: true, passive: true });
  document.addEventListener('touchend', () => { unlockAudio().catch(() => {}); }, { once: true, passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelActiveInteraction();
      // iOS may suspend/kill background audio contexts; stop cleanly so
      // returning to Safari does not leave a stale source/play state.
      try { stopPlayback(); } catch (e) {}
      try { stopReference(); } catch (e) {}
      S.soloPreviewGeneration = (S.soloPreviewGeneration || 0) + 1;
      if (S.soloSource) {
        try { S.soloSource.onended = null; S.soloSource.stop(); } catch (e) {}
        S.soloSource = null;
      }
    } else {
      if (WORKER_IS_IOS && !worker) {
        try { createAudioWorker(); } catch (e) {}
      }
      // Safari/PWA can leave an existing AudioContext suspended after a
      // background/foreground cycle. Resume it opportunistically; if iOS
      // still requires a gesture, the normal pointer/touch unlock path will
      // retry on the user's next interaction.
      if (S.audioCtx && S.audioCtx.state === 'suspended') {
        S.audioCtx.resume().catch(() => {});
      }
    }
  });
  window.addEventListener('pageshow', () => {
    cancelActiveInteraction();
    if (WORKER_IS_IOS && !worker) {
      try { createAudioWorker(); } catch (e) {}
    }
    if (S.audioCtx && S.audioCtx.state === 'suspended') {
      S.audioCtx.resume().catch(() => {});
    }
  });


  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const IS_STANDALONE = window.matchMedia && (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches
  ) || window.navigator.standalone === true;

  function updateToolbarScrollCue() {
    if (!topbar) return;
    const maxScroll = topbar.scrollWidth - topbar.clientWidth;
    topbar.classList.toggle('has-overflow-left', topbar.scrollLeft > 1);
    topbar.classList.toggle('has-overflow-right', topbar.scrollLeft < maxScroll - 1);
  }
  topbar.addEventListener('scroll', updateToolbarScrollCue, { passive: true });
  window.addEventListener('resize', updateToolbarScrollCue, { passive: true });
  requestAnimationFrame(updateToolbarScrollCue);

  function syncFullscreenButton() {
    const btn = $('fullscreenBtn');
    if (!btn) return;
    const supported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    // iPhone Safari does not provide a reliable page-level immersive mode;
    // installed PWA is the intended full-screen path there.
    btn.hidden = !(IS_ANDROID && supported && !IS_STANDALONE);
    if (!btn.hidden) btn.textContent = document.fullscreenElement ? '⛶' : '⛶';
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    } catch (e) {
      toastMsg('ブラウザの全画面表示を開始できませんでした', 2600, true);
    }
    syncFullscreenButton();
  }

  $('fullscreenBtn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => { syncFullscreenButton(); setTimeout(resizeCanvas, 50); });
  window.addEventListener('resize', () => setTimeout(resizeCanvas, 50), { passive: true });
  syncFullscreenButton();

  // Register a lightweight offline shell. Navigation stays network-first,
  // so Netlify updates are not masked by a stale cached index.html.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // A page already controlled by a worker is running an installed version.
    // sw.js activates a new release immediately (skipWaiting + claim), so a
    // controller change means this page's code is now outdated. Never reload
    // automatically: that would discard the user's audio and edits.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showUpdateNotice();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((registration) => {
        // An installed iPhone PWA is often resumed rather than relaunched,
        // which skips the browser's navigation-time update check.
        let lastCheck = Date.now();
        document.addEventListener('visibilitychange', () => {
          if (document.hidden || Date.now() - lastCheck < 10 * 60 * 1000) return;
          lastCheck = Date.now();
          registration.update().catch(() => {});
        });
      }).catch((err) => console.warn('SW registration failed', err));
    }, { once: true });
  }

  function showUpdateNotice() {
    const banner = $('updateBanner');
    if (!banner || !banner.hidden) return;
    const text = $('updateBannerText');
    if (text) {
      text.textContent = S.origChannels
        ? '新しいバージョンがあります。更新すると編集中の内容は失われます。'
        : '新しいバージョンがあります。';
    }
    banner.hidden = false;
  }
  if ($('updateReloadBtn')) {
    $('updateReloadBtn').addEventListener('click', () => {
      if (S.origChannels && !window.confirm('再読み込みすると、読み込んだ音源と編集内容は失われます。更新しますか？')) return;
      location.reload();
    });
  }
  if ($('updateLaterBtn')) {
    $('updateLaterBtn').addEventListener('click', () => { $('updateBanner').hidden = true; });
  }

  function releaseAudioMemory() {
    S.audioSessionId++;
    S.analysisDownsampled = false;
    S.analysisSampleRate = null;
    S.fileBaseName = 'audio';
    $('fileNameLabel').textContent = '';
    clearTimeout(S.resynthTimer);
    S.resynthTimer = null;
    S.pendingFullResynth = false;
    S.pendingResynthSet.clear();
    S.resynthQueued = false;
    S.soloPreviewGeneration = (S.soloPreviewGeneration || 0) + 1;
    S.referenceRequestId = (S.referenceRequestId || 0) + 1;
    stopPlayback();
    stopReference();
    if (S.soloSource) {
      try { S.soloSource.onended = null; S.soloSource.stop(); } catch (e) {}
      S.soloSource = null;
    }
    S.origChannels = null;
    S.monoSignal = null;
    S.pitchTrack = null;
    S.segments = null;
    S.undoStack = [];
    updateUndoBtn();
    updateAccessibleNoteNav();
    S.editedChannels = null;
    S.editedBuffer = null;
    S.referenceBuffer = null;
    S.refPitchTrack = null;
    S.refAlignXs = S.refAlignYs = S.refAlignRefXs = S.refAlignRefYs = null;
  }

  function makeMonoForAnalysis(decoded) {
    const n = decoded.length;
    const ch0 = decoded.getChannelData(0);
    if (decoded.numberOfChannels < 2) return Float32Array.from(ch0);
    const ch1 = decoded.getChannelData(1);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    return mono;
  }

  // Pitch detection does not need full 44.1/48 kHz bandwidth.
  // On iPhone, analyze a downsampled mono copy for longer files to cut
  // temporary memory and YIN CPU cost, while retaining the original-rate
  // channels for playback/export.
  function prepareAnalysisSignal(mono, sr, durationSec) {
    const shouldDownsample = IS_IOS && (durationSec >= 75 || mono.length >= sr * 75);
    if (!shouldDownsample || sr <= 24000) {
      return { signal: mono, sr, downsampled: false };
    }
    const factor = Math.max(2, Math.floor(sr / 22050));
    const outSr = sr / factor;
    const out = new Float32Array(Math.ceil(mono.length / factor));
    let oi = 0;
    for (let i = 0; i < mono.length; i += factor) {
      let sum = 0, count = 0;
      const end = Math.min(mono.length, i + factor);
      for (let j = i; j < end; j++) { sum += mono[j]; count++; }
      out[oi++] = count ? sum / count : 0;
    }
    return { signal: out, sr: outSr, downsampled: true };
  }

  function releaseAnalysisSource(source, prepared) {
    // Downsampling creates a new, much smaller analysis buffer. Do not keep
    // the full-rate mono source alive alongside it on memory-constrained iOS.
    // (When no downsampling occurred, source === prepared.signal and must stay.)
    if (prepared && prepared.signal !== source) source = null;
    return source;
  }

  function estimateDecodedMemoryMB(decoded) {
    // Rough peak working-set estimate: browser AudioBuffer (Float32),
    // Float32 original+edited audio, Float64 mono analysis and resynthesis temporaries.
    // Conservative on purpose because iOS may keep decoded buffers alive temporarily.
    const ch = Math.max(1, decoded.numberOfChannels);
    const audioPersistent = decoded.length * ch * 4 * 3;
    const analysisAndScratch = decoded.length * 8 * 3;
    return (audioPersistent + analysisAndScratch) / (1024 * 1024);
  }

  function estimateLiveAudioMemoryMB() {
    if (!S.origChannels || !S.origChannels[0]) return 0;
    const frames = S.origChannels[0].length;
    const originalCopies = 1 + (S.editedChannels ? 1 : 0) + (S.editedBuffer ? 1 : 0);
    const mainBytes = frames * Math.max(1, S.numCh) * 4 * originalCopies;
    const referenceBytes = S.referenceBuffer
      ? S.referenceBuffer.length * S.referenceBuffer.numberOfChannels * 4
      : 0;
    return (mainBytes + referenceBytes) / (1024 * 1024);
  }

  function yinOptsForSampleRate(sr) {
    // Preserve roughly 43-47 ms analysis windows and 10-12 ms hops
    // across 22.05/44.1/48 kHz. This avoids losing timing resolution
    // when iPhone analysis is downsampled.
    return sr < 32000
      ? { frameSize: 1024, hopSize: 256, fmin: 70, fmax: 1000, threshold: 0.15 }
      : { frameSize: 2048, hopSize: 512, fmin: 70, fmax: 1000, threshold: 0.15 };
  }

  // ============================================================
  // File loading
  // ============================================================
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    // Retain the File first, then clear the picker so iOS Safari can emit
    // change again when the user selects the same audio file a second time.
    e.target.value = '';
    if (!file) return;
    await loadFile(file);
  });

  async function loadFile(file) {
    stopPlayback();
    stopReference();
    if (S.soloSource) { try { S.soloSource.onended = null; S.soloSource.stop(); } catch (e) {} S.soloSource = null; }
    // Drop the previous song before decoding the replacement. On iPhone a
    // second decode can otherwise overlap the old original+edited PCM with
    // the new AudioBuffer and briefly double the working set.
    releaseAudioMemory();
    const audioSessionId = S.audioSessionId;
    S.selectedSegId = null;
    S.referenceLoaded = false; S.refAlignXs = null; S.refAlignYs = null;
    $('applyAllBtn').disabled = true; $('refPlayBtn').disabled = true;
    S.fileBaseName = file.name.replace(/\.[^/.]+$/, '');
    loadingScreen.style.display = 'flex';
    loadingStatus.textContent = '読み込み中...';
    setLoadingProgress(null);
    setControlsEnabled(false);
    try {
      const decoded = await decodeAudioFile(file);
      if (audioSessionId !== S.audioSessionId) return;
      S.sr = decoded.sampleRate;
      S.numCh = decoded.numberOfChannels;

      const durationSec = decoded.duration || (decoded.length / decoded.sampleRate);
      const memMB = estimateDecodedMemoryMB(decoded);
      if (IS_IOS && memMB > 430) {
        throw new Error('この音源はiPhoneのメモリ上限に近いため安全に処理できません。短く分割するか、MP3/M4A版をお試しください。');
      }
      if (IS_IOS && memMB > 260) {
        loadingStatus.textContent = '大きい音源です。iPhone省メモリモードで解析します...';
        await new Promise(r => setTimeout(r, 30));
      }

      // Build the analysis mono directly from AudioBuffer first.
      let monoFull = makeMonoForAnalysis(decoded);
      const analysis = prepareAnalysisSignal(monoFull, S.sr, durationSec);
      S.analysisDownsampled = analysis.downsampled;
      S.analysisSampleRate = analysis.sr;
      S.monoSignal = analysis.signal;
      monoFull = releaseAnalysisSource(monoFull, analysis);

      // Keep original-rate audio for actual listening/rendering. The iPhone
      // channel views retain decoded PCM without allocating another song-sized
      // array; they remain read-only and edits go to a separate lazy copy.
      S.origChannels = [];
      for (let c = 0; c < S.numCh; c++) {
        const channel = decoded.getChannelData(c);
        S.origChannels.push(IS_IOS ? channel : Float32Array.from(channel));
      }

      const analyzeLabel = analysis.downsampled ? 'ピッチを省メモリ解析中(iPhone最適化)' : 'ピッチを解析中';
      loadingStatus.textContent = `${analyzeLabel}... 0%`;
      setLoadingProgress(0);
      await new Promise(r => setTimeout(r, 20));
      const analyzeT0 = performance.now();
      const analyzed = await workerCall(
        { type: 'analyze', signal: S.monoSignal, sr: analysis.sr, opts: yinOptsForSampleRate(analysis.sr) },
        undefined,
        (fraction) => {
          if (audioSessionId !== S.audioSessionId) return;
          // Note segmentation after F0 tracking is quick; keep the last 2%.
          const pct = Math.min(98, Math.round(fraction * 98));
          loadingStatus.textContent = `${analyzeLabel}... ${pct}%`;
          setLoadingProgress(pct / 100);
        }
      );
      if (audioSessionId !== S.audioSessionId) return;
      console.info(`[PitchEditor] F0+note analysis ${(performance.now() - analyzeT0).toFixed(0)} ms`);
      loadingStatus.textContent = `${analyzeLabel}... 100%`;
      setLoadingProgress(1);
      S.pitchTrack = analyzed.pitchTrack;
      S.segments = analyzed.segments;
      updateAccessibleNoteNav();
      // The raw mono analysis copy is not used after F0/note extraction.
      // Releasing it matters on iOS, especially before edited/original buffers coexist.
      S.monoSignal = null;
      clearUndoHistory();

      if (S.segments.length === 0) {
        toastMsg('ピッチを検出できませんでした。別の音源をお試しください。', 3000);
      }
      fitVerticalRange();
      // Until the first edit, the original channel arrays are also the exact
      // edited signal. Avoid a second full-song PCM copy during iPhone import.
      // The mutable edited copy is created lazily before the first resynthesis.
      S.editedChannels = null;
      // Keep playback AudioBuffer lazy as well; playback/export materialize
      // their working representation only when the user requests it.
      S.editedBuffer = null;

      $('fileNameLabel').textContent = file.name + (S.analysisDownsampled ? '・iPhone省メモリ解析' : '');
      loadingScreen.style.display = 'none';
      setControlsEnabled(true);
      resizeCanvas();
      focusInitialDetectedView();
      $('emptyUpload').classList.add('hidden');
      render();
    } catch (err) {
      // If a newer import superseded this one, its session owns the UI and
      // audio state. A late failure from the old import must not tear it down.
      if (audioSessionId !== S.audioSessionId) return;
      // A failed replacement must leave a clean empty session. In particular,
      // do not retain partially copied PCM from a decode/analysis that ran out
      // of memory on iPhone, and do not leave editor controls pointing at it.
      releaseAudioMemory();
      S.selectedSegId = null;
      S.referenceLoaded = false;
      $('applyAllBtn').disabled = true;
      $('refPlayBtn').disabled = true;
      setControlsEnabled(false);
      $('emptyUpload').classList.remove('hidden');
      loadingScreen.style.display = 'none';
      const msg = (err && err.message) ? err.message : String(err);
      toastMsg(`音声を読み込めませんでした。WAV / MP3 / M4A(AAC) を推奨します。${msg ? ' (' + msg + ')' : ''}`, 5000, true);
      console.error(err);
    }
  }

  function setControlsEnabled(enabled) {
    canvas.tabIndex = enabled ? 0 : -1;
    ['playBtn', 'zoomOutBtn', 'zoomInBtn', 'fitAllBtn', 'splitBtn', 'resetAllBtn', 'autoCorrectBtn', 'exportBtn', 'refBtn'].forEach((id) => {
      $(id).disabled = !enabled;
    });
    $('backBtn').disabled = false;
    // Undo, mode changes and edit-only controls have no action until analysis
    // succeeds. Hide them from sequential assistive-technology navigation too.
    $('undoBtn').disabled = !enabled || S.undoStack.length === 0;
    ['undoBtn', 'fullscreenBtn', 'modeNoteBtn', 'modeLineBtn', 'autoPreviewBtn', 'resetAllBtn', 'autoCorrectBtn', 'refBtn', 'refPlayBtn', 'splitBtn', 'applyAllBtn', 'zoomOutBtn', 'zoomInBtn', 'fitAllBtn', 'exportBtn', 'playBtn'].forEach((id) => {
      const control = $(id);
      if (!control) return;
      if (!enabled) control.setAttribute('tabindex', '-1');
      else control.removeAttribute('tabindex');
    });
    requestAnimationFrame(updateToolbarScrollCue);
  }

  setControlsEnabled(false);

  function openAudioPicker(input) {
    // iOS/Safari: explicit extensions steer the chooser toward Files instead of Photos/video.
    // Reset first so selecting the same file twice still fires "change".
    input.value = '';
    unlockAudio().catch(() => {});
    try {
      if (typeof input.showPicker === 'function') input.showPicker();
      else input.click();
    } catch (e) {
      try { input.click(); }
      catch (e2) {
        toastMsg('Safariの「ファイル」から WAV / MP3 / M4A / AAC を選択してください。', 4000, true);
      }
    }
  }

  $('backBtn').addEventListener('click', () => {
    openAudioPicker(fileInput);
  });
  $('emptyUploadBtn').addEventListener('click', () => openAudioPicker(fileInput));

  // ============================================================
  // Reference / guide audio
  // ============================================================
  $('refBtn').addEventListener('click', () => openAudioPicker(refFileInput));
  refFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    refFileInput.value = '';
    if (!file) return;
    await loadReference(file);
  });

  async function loadReference(file) {
    if (!S.pitchTrack) { toastMsg('先にボーカル音源を読み込んでください'); return; }
    stopReference();
    const audioSessionId = S.audioSessionId;
    const referenceRequestId = S.referenceRequestId = (S.referenceRequestId || 0) + 1;
    toastMsg('リファレンスを解析中...', 5000);
    $('refBtn').disabled = true;
    try {
      if (IS_IOS) {
        const outputSampleRate = S.audioCtx?.sampleRate || S.sr;
        const estimatedMB = await estimateWavMemoryMB(file, outputSampleRate) ??
          await estimateCompressedAudioMemoryMB(file, outputSampleRate);
        if (estimatedMB != null && estimateLiveAudioMemoryMB() + estimatedMB > 430) {
          throw new Error('ボーカルとお手本を合わせた音源はiPhoneのメモリ上限に近いため読み込めません。短く分割するか圧縮音源をお試しください。');
        }
      }
      const decoded = await decodeAudioFile(file);
      if (audioSessionId !== S.audioSessionId || referenceRequestId !== S.referenceRequestId) return;
      const durationSec = decoded.duration || (decoded.length / decoded.sampleRate);
      if (IS_IOS) {
        const combinedMemMB = estimateLiveAudioMemoryMB() + estimateDecodedMemoryMB(decoded);
        if (combinedMemMB > 430) {
          throw new Error('ボーカルとお手本を合わせた音源サイズがiPhoneのメモリ上限に近いため読み込めません。短いお手本音源をお試しください。');
        }
        if (combinedMemMB > 260) {
          toastMsg('大きい音源です。解析中はほかのアプリを閉じると安定します。', 4000);
        }
      }
      let refMono;
      // Reuse the iPhone analysis path used by the main vocal: a full-rate
      // Float64 reference can add tens of MB while the vocal's original and
      // edited PCM are already resident. Long references only need F0/DTW at
      // analysis rate; keep the decoded AudioBuffer full-rate for playback.
      let refMonoFull = makeMonoForAnalysis(decoded);
      const refAnalysis = prepareAnalysisSignal(refMonoFull, decoded.sampleRate, durationSec);
      refMono = refAnalysis.signal;
      // A long-file downsample is independent. Release its full-rate mono
      // precursor before sending analysis to the Worker on memory-tight iOS.
      if (refAnalysis.signal !== refMonoFull) refMonoFull = null;
      const vocalSegsPlain = S.segments.map((s) => ({ startTime: s.startTime, endTime: s.endTime, startFrame: s.startFrame, endFrame: s.endFrame, noteMidi: s.noteMidi }));
      const res = await workerCall(
        { type: 'reference', refSignal: refMono, refSr: refAnalysis.sr, opts: yinOptsForSampleRate(refAnalysis.sr), vocalPitchTrack: S.pitchTrack, vocalSegments: vocalSegsPlain },
        [refMono.buffer]
      );
      if (audioSessionId !== S.audioSessionId || referenceRequestId !== S.referenceRequestId) return;
      res.suggestions.forEach((sugg, i) => { if (S.segments[i]) { S.segments[i].refSuggestMidi = sugg; S.segments[i].refExpression = res.expressions && res.expressions[i] ? Float64Array.from(res.expressions[i]) : null; } });
      S.referenceLoaded = true;
      S.referenceBuffer = decoded; // kept at full quality (original channel count) for playback
      S.refAlignXs = res.alignXs; S.refAlignYs = res.alignYs;
      S.refAlignRefXs = res.alignRefXs; S.refAlignRefYs = res.alignRefYs;
      S.refPitchTrack = res.refPitchTrack;
      $('refPlayBtn').disabled = false;
      render();
      const n = res.suggestions.filter((s) => s != null).length;
      const actionable = S.segments.filter(suggestionDiffersEnough).length;
      $('applyAllBtn').disabled = actionable === 0;
      toastMsg(actionable > 0
        ? `リファレンス解析完了(補正候補${actionable}件)`
        : n > 0
          ? '手本と現在の音程が一致しており、適用できる補正はありません'
          : 'リファレンスを解析しましたが、対応する候補が見つかりませんでした', 3000);
    } catch (err) {
      if (audioSessionId !== S.audioSessionId || referenceRequestId !== S.referenceRequestId) return;
      console.error(err);
      const detail = err && err.message ? ` (${err.message})` : '';
      toastMsg(`リファレンスを読み込めませんでした。iPhoneでは WAV / MP3 / M4A(AAC) を推奨します。${detail}`, 5000, true);
    } finally {
      // Do not let an obsolete reference request re-enable controls owned by
      // a newer main-audio session.
      if (audioSessionId === S.audioSessionId && referenceRequestId === S.referenceRequestId) $('refBtn').disabled = false;
    }
  }

  // Play the reference from wherever the main playhead currently is,
  // mapped through the DTW alignment (falls back to the reference's own
  // start if no alignment is available yet, or the mapped position would
  // be past its end).
  async function playReference() {
    if (!S.referenceBuffer) return;
    stopReference();
    const generation = S.referencePlaybackGeneration = (S.referencePlaybackGeneration || 0) + 1;
    const audioSessionId = S.audioSessionId;
    const referenceRequestId = S.referenceRequestId;
    // iOS Safari requires a user activation to resume Web Audio. Await the
    // same unlock path used by main playback before starting this source.
    await unlockAudio();
    if (document.hidden || generation !== S.referencePlaybackGeneration ||
        audioSessionId !== S.audioSessionId || referenceRequestId !== S.referenceRequestId || !S.referenceBuffer) return;
    stopReference();
    if (S.playing) stopPlayback();
    const vocalT = getPlayheadTime();
    let refT = 0;
    if (S.refAlignXs && S.refAlignXs.length > 0) {
      refT = mapVocalTimeToRefTime(vocalT, S.refAlignXs, S.refAlignYs);
    }
    refT = Math.max(0, Math.min(refT, S.referenceBuffer.duration - 0.01));
    const src = S.audioCtx.createBufferSource();
    src.buffer = S.referenceBuffer;
    src.connect(S.audioCtx.destination);
    src.start(0, refT);
    src.onended = () => { if (S.refSource === src) { S.refSource = null; S.refPlaying = false; $('refPlayBtn').textContent = '🎯▶'; } };
    S.refSource = src;
    S.refPlaying = true;
    S.refPlayStartCtxTime = S.audioCtx.currentTime;
    S.refPlayStartRefTime = refT;
    $('refPlayBtn').textContent = '🎯⏸';
    requestAnimationFrame(tick);
  }
  function stopReference() {
    S.referencePlaybackGeneration = (S.referencePlaybackGeneration || 0) + 1;
    if (S.refSource) { try { S.refSource.onended = null; S.refSource.stop(); } catch (e) {} S.refSource = null; }
    S.refPlaying = false;
    $('refPlayBtn').textContent = '🎯▶';
  }
  // Generic monotonic-time interpolation, used for both alignment
  // directions (pass the vocal->ref map or the ref->vocal map).
  function mapVocalTimeToRefTime(x, xp, fp) {
    const n = xp.length;
    if (n === 0) return 0;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
    return fp[lo] + t * (fp[hi] - fp[lo]);
  }
  function mapRefTimeToVocalTime(refT) {
    if (!S.refAlignRefXs || S.refAlignRefXs.length === 0) return refT;
    return mapVocalTimeToRefTime(refT, S.refAlignRefXs, S.refAlignRefYs);
  }
  function getRefPlayheadRefTime() {
    if (!S.refPlaying) return S.refPlayStartRefTime;
    return S.refPlayStartRefTime + (S.audioCtx.currentTime - S.refPlayStartCtxTime);
  }
  $('refPlayBtn').addEventListener('click', async () => {
    if (S.refPlaying) stopReference();
    else {
      try { await playReference(); }
      catch (err) {
        console.error(err);
        toastMsg('Safariで参照音声を再生できませんでした。もう一度タップしてください。', 3500, true);
      }
    }
  });

  function suggestionDiffersEnough(seg) {
    if (seg.refSuggestMidi == null) return false;
    const curRow = seg.noteMidi + Math.round(currentShift(seg));
    return Math.abs(seg.refSuggestMidi - curRow) >= 0.4;
  }

  function referenceExpressionAt(expr, k) {
    if (!expr || !expr.length) return NaN;
    if (Number.isFinite(expr[k])) return expr[k];
    // Fill small DTW/unvoiced gaps from the nearest valid neighbors.
    let a = k - 1, b = k + 1;
    while (a >= 0 && !Number.isFinite(expr[a])) a--;
    while (b < expr.length && !Number.isFinite(expr[b])) b++;
    if (a >= 0 && b < expr.length) {
      const t = (k - a) / Math.max(1, b - a);
      return expr[a] * (1 - t) + expr[b] * t;
    }
    if (a >= 0 && k - a <= 3) return expr[a];
    if (b < expr.length && b - k <= 3) return expr[b];
    return NaN;
  }

  function applyReferenceExpression(seg, strength = S.correctionStrength) {
    if (!seg || !seg.refExpression || !seg.refExpression.length) return false;
    // A user-painted line is authoritative. Automatic curves may be replaced.
    if (seg.lineOffsets && !seg.autoCurve) return false;
    if (!S.pitchTrack || !S.pitchTrack.f0s || !S.pitchTrack.voiced) return false;
    const len = Math.max(0, seg.endFrame - seg.startFrame);
    if (len < 5) return false;
    const { f0s, voiced } = S.pitchTrack;
    const source = new Float64Array(len); source.fill(NaN);
    const vals = [];
    for (let k = 0; k < len; k++) {
      const i = seg.startFrame + k;
      if (voiced[i] && f0s[i] > 0) { source[k] = PE.freqToMidi(f0s[i]); vals.push(source[k]); }
    }
    if (vals.length < Math.max(3, Math.floor(len * 0.4))) return false;
    vals.sort((a,b)=>a-b);
    const sourceCenter = vals[Math.floor(vals.length/2)];
    const baseAuto = (seg.lineOffsets && seg.autoCurve && seg.lineOffsets.length === len) ? Float64Array.from(seg.lineOffsets) : new Float64Array(len);
    const out = new Float64Array(len);
    const amount = Math.min(0.48, 0.16 + 0.32 * Math.max(0, Math.min(1, strength)));
    let maxAbs = 0, used = 0;
    for (let k = 0; k < len; k++) {
      const re = referenceExpressionAt(seg.refExpression, k);
      if (!Number.isFinite(re) || !Number.isFinite(source[k])) { out[k] = baseAuto[k] || 0; continue; }
      const sourceExpr = source[k] - sourceCenter;
      // Morph toward the guide rather than stacking its vibrato/scoop on top
      // of the singer's existing expression. This avoids doubled vibrato.
      const diff = re - sourceExpr;
      const guided = Math.max(-0.65, Math.min(0.65, diff * amount));
      out[k] = (baseAuto[k] || 0) + guided;
      maxAbs = Math.max(maxAbs, Math.abs(guided)); used++;
    }
    if (used < Math.max(3, Math.floor(len * 0.3)) || maxAbs < 0.008) return false;
    // Remove DC so target-note centering remains controlled by shift/fineCents.
    const oo = Array.from(out).filter(Number.isFinite).sort((a,b)=>a-b);
    const med = oo.length ? oo[Math.floor(oo.length/2)] : 0;
    for (let k = 0; k < len; k++) out[k] -= med;
    seg.lineOffsets = out;
    seg.autoCurve = true;
    seg.referenceExpressionApplied = true;
    return true;
  }

  function applySuggestion(seg, strength = S.correctionStrength) {
    if (seg.refSuggestMidi == null) return false;
    let changed = applyTargetWithStrength(seg, seg.refSuggestMidi, strength);
    if (applyReferenceExpression(seg, strength)) changed = true;
    return changed;
  }

  $('applyAllBtn').addEventListener('click', () => {
    const undoSnapshot = rememberBeforeEdit();
    let count = 0;
    for (const seg of S.segments) {
      if (suggestionDiffersEnough(seg) && applySuggestion(seg)) count++;
    }
    if (count > 0) { pushUndoSnapshot(undoSnapshot); scheduleResynth(); updateInspector(); render(); toastMsg(`${count}件をお手本へ ${Math.round(S.correctionStrength * 100)}% 補正しました`); }
    else toastMsg('適用できる候補がありません');
  });

  // ============================================================
  // Vertical fit
  // ============================================================
  function fitVerticalRange() {
    let lo = Infinity, hi = -Infinity;
    for (const s of S.segments) { lo = Math.min(lo, s.noteMidi); hi = Math.max(hi, s.noteMidi); }
    if (!isFinite(lo)) { lo = 60; hi = 60; }
    lo -= 3; hi += 3;
    if (hi - lo < 13) { const mid = (hi + lo) / 2; lo = mid - 6.5; hi = mid + 6.5; }
    S.minMidi = Math.floor(lo);
    S.maxMidi = Math.ceil(hi);
  }

  // ============================================================
  // Canvas sizing
  // ============================================================
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = rollWrap.clientWidth, h = rollWrap.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rows = S.maxMidi - S.minMidi + 1;
    S.rowHeight = Math.max(14, (h - S.rulerHeight) / rows);
    render();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas(); // draws the empty-state prompt immediately, before any file is loaded
  updateInteractionGuide();

  // ============================================================
  // Coordinate transforms
  // ============================================================
  function xForTime(t) { return (t - S.viewStartSec) * S.pxPerSec; }
  function timeForX(x) { return S.viewStartSec + x / S.pxPerSec; }
  function yForMidi(m) { return S.rulerHeight + (S.maxMidi - m) * S.rowHeight; }
  function midiForY(y) { return S.maxMidi - (y - S.rulerHeight) / S.rowHeight; }

  function currentShift(seg) { return seg.shiftSemitones + seg.fineCents / 100; }
  // Total shift (note-level + free-hand line edit) at a specific pitch-track frame index.
  function frameShift(seg, frameIdx) {
    const base = currentShift(seg);
    if (!seg.lineOffsets) return base;
    const li = frameIdx - seg.startFrame;
    return li >= 0 && li < seg.lineOffsets.length ? base + seg.lineOffsets[li] : base;
  }

  function detectedBounds() {
    if (!S.segments || S.segments.length === 0) return null;
    return {
      start: Math.max(0, S.segments[0].startTime || 0),
      end: Math.max(S.segments[0].endTime || 0, S.segments[S.segments.length - 1].endTime || 0)
    };
  }

  // Default after analysis: focus the first detected phrase at a musically useful zoom.
  // Fitting an entire song makes note blocks too small to edit on a phone, so full-song
  // overview is available explicitly via the "全体" button instead.
  function focusInitialDetectedView() {
    const b = detectedBounds();
    if (!b) { S.viewStartSec = 0; S.pxPerSec = 120; return; }
    const w = Math.max(320, rollWrap.clientWidth || window.innerWidth || 360);
    const detectedSpan = Math.max(0.8, b.end - b.start);
    const targetWindow = detectedSpan <= 10 ? Math.min(12, detectedSpan + 1.4) : 9.5;
    S.viewStartSec = Math.max(0, b.start - 0.45);
    S.pxPerSec = clampZoom(w / targetWindow);
  }

  function fitDetectedAllView() {
    const b = detectedBounds();
    if (!b) return;
    const w = Math.max(320, rollWrap.clientWidth || window.innerWidth || 360);
    const span = Math.max(1, b.end - b.start);
    const pad = Math.min(1.0, Math.max(0.25, span * 0.03));
    S.viewStartSec = Math.max(0, b.start - pad);
    // Overview is allowed to zoom further out than the normal editing minimum.
    // This keeps the entire detected range visible even for long songs.
    S.pxPerSec = Math.max(2, Math.min(1200, w / (span + pad * 2)));
    render();
  }

  // ============================================================
  // Rendering
  // ============================================================
  function render() {
    const w = rollWrap.clientWidth, h = rollWrap.clientHeight;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#14161c';
    ctx2d.fillRect(0, 0, w, h);
    if (!S.pitchTrack) { drawEmptyState(w, h); return; }

    drawKeyRows(w, h);
    drawGridAndRuler(w, h);
    drawSegments(w, h);
    drawReferenceCurve(w, h);
    drawPlayhead(w, h);
  }

  function drawEmptyState(w, h) {
    // The first-run upload UI is a real DOM control layered over the canvas.
    // Keep the canvas visually quiet so the call-to-action remains obvious.
  }

  const BLACK_PC = new Set([1, 3, 6, 8, 10]);
  function drawKeyRows(w, h) {
    for (let m = S.minMidi; m <= S.maxMidi; m++) {
      const y = yForMidi(m + 0.5);
      const pc = ((m % 12) + 12) % 12;
      ctx2d.fillStyle = BLACK_PC.has(pc) ? '#191b22' : '#20232c';
      ctx2d.fillRect(0, y, w, S.rowHeight);
      if (pc === 0) {
        ctx2d.fillStyle = 'rgba(91,140,255,0.06)';
        ctx2d.fillRect(0, y, w, S.rowHeight);
      }
    }
  }

  function drawGridAndRuler(w, h) {
    // horizontal semitone separators (subtle) + note labels for C notes
    ctx2d.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx2d.lineWidth = 1;
    for (let m = S.minMidi; m <= S.maxMidi + 1; m++) {
      const y = yForMidi(m + 0.5) ;
      ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(w, y); ctx2d.stroke();
    }
    ctx2d.fillStyle = '#6b7280';
    ctx2d.font = '10px -apple-system,sans-serif';
    for (let m = S.minMidi; m <= S.maxMidi; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (pc === 0) {
        const y = yForMidi(m);
        ctx2d.fillText(PE.midiToNoteName(m), 4, y + 3);
      }
    }

    // time ruler
    ctx2d.fillStyle = '#1e212a';
    ctx2d.fillRect(0, 0, w, S.rulerHeight);
    const step = pickTimeStep(S.pxPerSec);
    const firstMark = Math.floor(S.viewStartSec / step) * step;
    ctx2d.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx2d.fillStyle = '#9aa0ad';
    ctx2d.font = '10px -apple-system,sans-serif';
    for (let t = firstMark; t < S.viewStartSec + w / S.pxPerSec + step; t += step) {
      const x = xForTime(t);
      ctx2d.beginPath(); ctx2d.moveTo(x, S.rulerHeight - 8); ctx2d.lineTo(x, S.rulerHeight); ctx2d.stroke();
      ctx2d.fillText(formatTime(t, step), x + 3, 14);
    }
    ctx2d.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx2d.beginPath(); ctx2d.moveTo(0, S.rulerHeight); ctx2d.lineTo(w, S.rulerHeight); ctx2d.stroke();
  }

  function pickTimeStep(pxPerSec) {
    const target = 70; // px between marks
    const raw = target / pxPerSec;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
    for (const s of steps) if (s >= raw) return s;
    return 120;
  }
  function formatTime(t, step) {
    if (t < 0) t = 0;
    const m = Math.floor(t / 60);
    const sFull = t % 60;
    if (step != null && step < 1) {
      return m + ':' + sFull.toFixed(1).padStart(4, '0');
    }
    return m + ':' + String(Math.floor(sFull)).padStart(2, '0');
  }

  const COLOR_BLOCK = 'rgba(245,164,66,0.28)', COLOR_BLOCK_HOT = 'rgba(255,195,110,0.4)', COLOR_BLOCK_SEL = 'rgba(255,207,138,0.45)';
  const COLOR_BLOCK_EDGE = 'rgba(245,164,66,0.85)', COLOR_BLOCK_EDGE_HOT = 'rgba(255,195,110,0.95)';
  const COLOR_SUGGEST = '#5bd4ff';
  const COLOR_LINE = 'rgba(255,255,255,0.8)', COLOR_LINE_SEL = '#ffffff', COLOR_LINE_PAINT = '#ffe08a';

  function roundRectPath(x, y, rw, rh, r) {
    r = Math.max(0, Math.min(r, rw / 2, rh / 2));
    ctx2d.beginPath();
    ctx2d.moveTo(x + r, y);
    ctx2d.arcTo(x + rw, y, x + rw, y + rh, r);
    ctx2d.arcTo(x + rw, y + rh, x, y + rh, r);
    ctx2d.arcTo(x, y + rh, x, y, r);
    ctx2d.arcTo(x, y, x + rw, y, r);
    ctx2d.closePath();
  }

  // Always draws BOTH layers together (not mode-toggled visibility):
  //  - the "note" block: a rounded rect at the segment's quantized target
  //    row (noteMidi + whole-semitone shift) -- what the Note tool drags.
  //  - the "line": the actual continuous pitch curve (raw f0 + full shift,
  //    including any free-hand Line-tool offsets) threaded on top -- what
  //    the Line tool paints. Seeing both at once shows how far the real
  //    sung pitch wanders from the note's target.
  function drawSegments(w, h) {
    const { times, f0s, voiced } = S.pitchTrack;
    for (const seg of S.segments) {
      const x0 = xForTime(seg.startTime), x1 = xForTime(seg.endTime);
      if (x1 < -20 || x0 > w + 20) continue; // off-screen cull
      const shift = currentShift(seg);
      const selected = S.selectedSegId === seg.id;
      const isDragging = S.dragging && S.dragging.segId === seg.id;
      const isNoteDrag = isDragging && S.dragging.kind === 'note';
      const isLinePaint = isDragging && S.dragging.kind === 'line';

      // --- note block ---
      const blockRow = seg.noteMidi + Math.round(shift);
      const blockTop = yForMidi(blockRow + 0.5);
      const bx0 = Math.max(-2, x0), bx1 = Math.min(w + 2, x1);
      if (bx1 - bx0 > 1) {
        roundRectPath(bx0, blockTop + 1, bx1 - bx0, S.rowHeight - 2, 5);
        ctx2d.fillStyle = isNoteDrag ? COLOR_BLOCK_SEL : (selected ? COLOR_BLOCK_HOT : COLOR_BLOCK);
        ctx2d.fill();
        ctx2d.lineWidth = selected ? 2.8 : 1.5;
        ctx2d.strokeStyle = selected ? '#ffffff' : (isNoteDrag ? COLOR_BLOCK_EDGE_HOT : COLOR_BLOCK_EDGE);
        if (selected) {
          ctx2d.save();
          ctx2d.shadowColor = 'rgba(91,140,255,.72)';
          ctx2d.shadowBlur = 10;
          ctx2d.stroke();
          ctx2d.restore();
        } else {
          ctx2d.stroke();
        }

        if (selected || isNoteDrag) {
          const cy = blockTop + S.rowHeight * 0.5;
          ctx2d.beginPath();
          ctx2d.moveTo(bx0 + 5, cy);
          ctx2d.lineTo(bx1 - 5, cy);
          ctx2d.lineWidth = 1;
          ctx2d.strokeStyle = 'rgba(255,255,255,.42)';
          ctx2d.setLineDash([3, 3]);
          ctx2d.stroke();
          ctx2d.setLineDash([]);
        }

        if (selected && (bx1 - bx0) > 54) {
          const editedCenter = seg.medianMidi + shift + medianLineOffset(seg);
          const centerDev = (editedCenter - Math.round(editedCenter)) * 100;
          const label = signedCents(centerDev);
          ctx2d.font = '700 10px -apple-system,sans-serif';
          ctx2d.textAlign = 'right';
          ctx2d.fillStyle = 'rgba(255,255,255,.9)';
          ctx2d.fillText(label, bx1 - 5, blockTop + Math.min(S.rowHeight - 5, 13));
          ctx2d.textAlign = 'left';
        }

        // ghost of the block's original row while note-dragging
        if (isNoteDrag) {
          const baseRow = seg.noteMidi + Math.round(S.dragging.baseShift);
          const baseTop = yForMidi(baseRow + 0.5);
          roundRectPath(bx0, baseTop + 1, bx1 - bx0, S.rowHeight - 2, 5);
          ctx2d.setLineDash([3, 3]);
          ctx2d.lineWidth = 1.5;
          ctx2d.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx2d.stroke();
          ctx2d.setLineDash([]);
        }

        // reference suggestion: a dashed outline at the reference's target
        // row, only when it differs meaningfully from the note's current
        // position -- tap it to snap the note there (see hitTestSuggestion).
        if (suggestionDiffersEnough(seg)) {
          const suggRow = Math.round(seg.refSuggestMidi);
          const suggTop = yForMidi(suggRow + 0.5);
          roundRectPath(bx0, suggTop + 1, bx1 - bx0, S.rowHeight - 2, 5);
          ctx2d.setLineDash([4, 3]);
          ctx2d.lineWidth = 2;
          ctx2d.strokeStyle = COLOR_SUGGEST;
          ctx2d.stroke();
          ctx2d.setLineDash([]);
          if (bx1 - bx0 > 14) {
            ctx2d.fillStyle = COLOR_SUGGEST;
            ctx2d.font = '10px -apple-system,sans-serif';
            ctx2d.fillText('🎯', bx0 + 2, suggTop + S.rowHeight - 5);
          }
        }
      }

      // --- pitch line ---
      // Rendering only: when zoomed far out, do not submit many more curve
      // vertices than the screen can display. Analysis/edit data stays intact.
      const visibleNotePx = Math.max(1, Math.min(w, x1) - Math.max(0, x0));
      const curveStep = Math.max(1, Math.floor((seg.endFrame - seg.startFrame) / (visibleNotePx * 2)));
      // Selected note: show the original, unedited pitch as a muted dashed ghost.
      if (selected) {
        ctx2d.beginPath();
        let ghostStarted = false;
        for (let i = seg.startFrame; i < seg.endFrame; i += curveStep) {
          if (!voiced[i] || f0s[i] <= 0) continue;
          const gx = xForTime(times[i]);
          const gy = yForMidi(PE.freqToMidi(f0s[i]));
          if (!ghostStarted) { ctx2d.moveTo(gx, gy); ghostStarted = true; } else { ctx2d.lineTo(gx, gy); }
        }
        if (ghostStarted) {
          ctx2d.save();
          ctx2d.setLineDash([4, 3]);
          ctx2d.lineWidth = 1.5;
          ctx2d.strokeStyle = 'rgba(126,138,158,.78)';
          ctx2d.stroke();
          ctx2d.restore();
        }
      }

      ctx2d.beginPath();
      let started = false;
      for (let i = seg.startFrame; i < seg.endFrame; i += curveStep) {
        if (!voiced[i] || f0s[i] <= 0) continue;
        const x = xForTime(times[i]);
        const y = yForMidi(PE.freqToMidi(f0s[i]) + frameShift(seg, i));
        if (!started) { ctx2d.moveTo(x, y); started = true; } else { ctx2d.lineTo(x, y); }
      }
      if (started) {
        ctx2d.lineCap = 'round';
        ctx2d.lineJoin = 'round';
        ctx2d.lineWidth = isLinePaint ? 5.5 : (selected ? 5 : 4);
        ctx2d.strokeStyle = 'rgba(8,10,14,.78)';
        ctx2d.stroke();
        ctx2d.lineWidth = isLinePaint ? 3.2 : (selected ? 2.8 : 2.2);
        ctx2d.strokeStyle = isLinePaint ? COLOR_LINE_PAINT : (selected ? COLOR_LINE_SEL : COLOR_LINE);
        ctx2d.stroke();
      }

      // note label above the block if wide enough
      if (x1 - x0 > 26) {
        ctx2d.fillStyle = 'rgba(10,11,15,0.55)';
        const label = PE.midiToNoteName(blockRow) + (shift !== 0 ? (shift > 0 ? ' +' : ' ') + shift.toFixed(shift % 1 === 0 ? 0 : 1) + 'st' : '');
        ctx2d.font = '10px -apple-system,sans-serif';
        const tw = ctx2d.measureText(label).width;
        ctx2d.fillRect(Math.max(0, x0) + 2, blockTop - 15, tw + 6, 13);
        ctx2d.fillStyle = '#e8e9ee';
        ctx2d.fillText(label, Math.max(0, x0) + 5, blockTop - 5);
      }
    }
  }

  function drawPlayhead(w, h) {
    const t = getPlayheadTime();
    const x = xForTime(t);
    if (x >= 0 && x <= w) {
      ctx2d.strokeStyle = '#ff6b6b';
      ctx2d.lineWidth = 2;
      ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, h); ctx2d.stroke();
    }

    // Reference playhead: mapped from the reference's own elapsed playback
    // time back onto the vocal timeline, so "where is it singing right
    // now" shows up directly on the piano roll you're already looking at.
    if (S.refPlaying) {
      const refT = getRefPlayheadRefTime();
      const vocalT = mapRefTimeToVocalTime(refT);
      const rx = xForTime(vocalT);
      if (rx >= 0 && rx <= w) {
        ctx2d.strokeStyle = COLOR_SUGGEST;
        ctx2d.lineWidth = 2;
        ctx2d.setLineDash([2, 3]);
        ctx2d.beginPath(); ctx2d.moveTo(rx, 0); ctx2d.lineTo(rx, h); ctx2d.stroke();
        ctx2d.setLineDash([]);
        ctx2d.fillStyle = COLOR_SUGGEST;
        ctx2d.font = '10px -apple-system,sans-serif';
        ctx2d.fillText('🎯', rx + 3, S.rulerHeight + 12);
      }
    }
  }

  // Overlay the reference's own pitch curve, mapped onto the vocal
  // timeline through the DTW alignment, so the analysis is directly
  // eyeball-able: does the magenta line's shape actually track the
  // vocal's white line the way the alignment claims it does?
  function drawReferenceCurve(w, h) {
    if (!S.refPitchTrack || !S.refAlignXs) return;
    const { times: refTimes, f0s: refF0s, voiced: refVoiced } = S.refPitchTrack;
    const stepPx = 2;
    ctx2d.beginPath();
    let started = false;
    let idx = 0;
    const last = refTimes.length - 1;
    if (last < 0) return;
    for (let x = 0; x <= w; x += stepPx) {
      const vocalT = timeForX(x);
      const refT = mapVocalTimeToRefTime(vocalT, S.refAlignXs, S.refAlignYs);
      while (idx < last && refTimes[idx + 1] <= refT) idx++;
      let nearest = idx;
      if (idx < last && Math.abs(refTimes[idx + 1] - refT) < Math.abs(refTimes[idx] - refT)) nearest = idx + 1;
      if (!refVoiced[nearest] || refF0s[nearest] <= 0) { started = false; continue; }
      const y = yForMidi(PE.freqToMidi(refF0s[nearest]));
      if (!started) { ctx2d.moveTo(x, y); started = true; } else { ctx2d.lineTo(x, y); }
    }
    ctx2d.lineWidth = 1.5;
    ctx2d.strokeStyle = 'rgba(255,110,199,0.75)';
    ctx2d.setLineDash([1, 2]);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
  }

  function getPlayheadTime() {
    if (S.playing && S.audioCtx) {
      return S.playStartOffsetSec + (S.audioCtx.currentTime - S.playStartCtxTime);
    }
    return S.playStartOffsetSec;
  }

  // ============================================================
  // rAF render loop (only runs while playing, for the moving playhead)
  // ============================================================
  function tick() {
    if (S.playing) {
      const dur = S.editedBuffer ? S.editedBuffer.duration : 0;
      if (getPlayheadTime() >= dur) { stopPlayback(); S.playStartOffsetSec = 0; }
    }
    if (S.playing || S.refPlaying) {
      render();
      requestAnimationFrame(tick);
    }
  }

  // ============================================================
  // Hit testing
  // ============================================================
  function hitTestSegment(px, py) {
    const t = timeForX(px);
    const hitPad = 16; // px, generous touch target
    let best = null, bestDist = Infinity;
    for (const seg of S.segments) {
      if (t < seg.startTime - 0.05 || t > seg.endTime + 0.05) continue;
      // Uniform F0 frames let touch hit-testing start near the pointer time.
      // Search only a small local neighborhood instead of the complete note.
      const { times, f0s, voiced, hopSize } = S.pitchTrack;
      let nearestY = null;
      const frameDt = (hopSize || 512) / (S.analysisSampleRate || S.sr);
      let center = Math.round((t - times[0]) / frameDt);
      center = Math.max(seg.startFrame, Math.min(seg.endFrame - 1, center));
      let best = -1, bestDt = Infinity;
      for (let radius = 0; radius <= 4; radius++) {
        const ia = center - radius, ib = center + radius;
        if (ia >= seg.startFrame && ia < seg.endFrame && voiced[ia] && f0s[ia] > 0) {
          const d = Math.abs(times[ia] - t);
          if (d < bestDt) { bestDt = d; best = ia; }
        }
        if (radius && ib >= seg.startFrame && ib < seg.endFrame && voiced[ib] && f0s[ib] > 0) {
          const d = Math.abs(times[ib] - t);
          if (d < bestDt) { bestDt = d; best = ib; }
        }
      }
      if (best >= 0) nearestY = yForMidi(PE.freqToMidi(f0s[best]) + frameShift(seg, best));
      if (nearestY == null) continue;
      const dy = Math.abs(nearestY - py);
      if (dy <= hitPad && dy < bestDist) { bestDist = dy; best = seg; }
    }
    return best;
  }

  // Hit-test against the visible NOTE BLOCK (its quantized target row),
  // used by the Note tool and by Split -- both operate on the note's
  // block identity, not the fine pitch line.
  function hitTestBlock(px, py) {
    const t = timeForX(px);
    const pad = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 12 : 8; // larger finger target on phones
    for (const seg of S.segments) {
      if (t < seg.startTime || t > seg.endTime) continue;
      const blockRow = seg.noteMidi + Math.round(currentShift(seg));
      const top = yForMidi(blockRow + 0.5);
      if (py >= top - pad && py <= top + S.rowHeight + pad) return seg;
    }
    return null;
  }

  // Hit-test against a visible reference-suggestion ghost (only present
  // when it differs enough from the note's current block -- see
  // suggestionDiffersEnough), so tapping it can apply that candidate.
  function hitTestSuggestion(px, py) {
    const t = timeForX(px);
    const pad = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 12 : 8;
    for (const seg of S.segments) {
      if (!suggestionDiffersEnough(seg)) continue;
      if (t < seg.startTime || t > seg.endTime) continue;
      const suggRow = Math.round(seg.refSuggestMidi);
      const top = yForMidi(suggRow + 0.5);
      if (py >= top - pad && py <= top + S.rowHeight + pad) return seg;
    }
    return null;
  }

  // ============================================================
  // Pointer interaction (drag blob to shift pitch; drag empty area to pan;
  // drag ruler to seek)
  // ============================================================
  let activePointerId = null;
  let pinchActive = false;

  function resetSegment(seg) {
    seg.shiftSemitones = 0; seg.fineCents = 0; seg.lineOffsets = null; seg.autoCurve = false;
  }

  // Paint free-hand pitch offsets (Line tool) into seg.lineOffsets for every
  // pitch-track frame whose x falls between the previous and current pointer
  // position, interpolating y across that span so a fast stroke doesn't
  // leave gaps. Offsets are stored relative to the note's current (post
  // note-drag) baseline, so line edits stack on top of a whole-note shift.
  function paintLineAt(seg, pxFrom, pyFrom, pxTo, pyTo) {
    const tFrom = timeForX(Math.min(pxFrom, pxTo)), tTo = timeForX(Math.max(pxFrom, pxTo));
    const { times, f0s, voiced } = S.pitchTrack;
    if (!seg.lineOffsets) seg.lineOffsets = new Float64Array(seg.endFrame - seg.startFrame);
    seg.autoCurve = false;
    const base = currentShift(seg);
    const denom = (pxTo - pxFrom) || 1;
    for (let i = seg.startFrame; i < seg.endFrame; i++) {
      if (!voiced[i] || f0s[i] <= 0) continue;
      const t = times[i];
      if (t < tFrom - 1e-6 || t > tTo + 1e-6) continue;
      const x = xForTime(t);
      const frac = Math.max(0, Math.min(1, (x - pxFrom) / denom));
      const y = pyFrom + frac * (pyTo - pyFrom);
      const targetMidi = midiForY(y);
      const naturalMidi = PE.freqToMidi(f0s[i]) + base;
      seg.lineOffsets[i - seg.startFrame] = targetMidi - naturalMidi;
    }
  }

  function updateSplitBtnUI() {
    $('splitBtn').classList.toggle('armed', S.splitArmed);
    $('splitBtn').innerHTML = `${S.splitArmed ? '✂️…' : '✂️'}<span class="toolLabel">分割</span>`;
    updateInteractionGuide();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (pinchActive) return;
    if (!S.pitchTrack) { openAudioPicker(fileInput); return; }
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer to capture -- safe to continue without it */ }
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;

    if (py < S.rulerHeight) {
      seekTo(timeForX(px));
      S.panning = { mode: 'seek' };
      return;
    }

    if (S.referenceLoaded && !S.splitArmed) {
      const suggSeg = hitTestSuggestion(px, py);
      if (suggSeg) {
        const undoSnapshot = rememberBeforeEdit();
        const changed = applySuggestion(suggSeg);
        if (changed) pushUndoSnapshot(undoSnapshot);
        if (S.selectedSegId === suggSeg.id) updateInspector();
        S.previewSegId = suggSeg.id;
        scheduleResynth(suggSeg.id);
        render();
        toastMsg('候補を適用しました');
        return;
      }
    }

    if (S.splitArmed) {
      const seg = hitTestBlock(px, py); // split targets the note block, like the Note tool
      S.splitArmed = false; updateInteractionGuide();
      updateSplitBtnUI();
      if (seg) {
        const t = timeForX(px);
        const { times } = S.pitchTrack;
        let splitFrame = seg.startFrame, bd = Infinity;
        for (let i = seg.startFrame; i < seg.endFrame; i++) {
          const d = Math.abs(times[i] - t);
          if (d < bd) { bd = d; splitFrame = i; }
        }
        const undoSnapshot = rememberBeforeEdit();
        const newSegs = PE.splitSegment(S.segments, seg.id, splitFrame, times, S.pitchTrack.f0s, S.pitchTrack.voiced);
        if (newSegs !== S.segments) {
          pushUndoSnapshot(undoSnapshot);
          S.segments = newSegs;
          S.selectedSegId = null; S.lastTapSeg = null; updateInspector();
          toastMsg('ノートを分割しました');
          render();
        } else {
          toastMsg('端に近すぎて分割できません');
        }
      }
      return; // split tap never starts a drag/pan
    }

    // Note tool grabs the block; Line tool grabs the actual pitch curve --
    // both layers are always visible, but each tool only "picks up" its own.
    const seg = S.mode === 'line' ? hitTestSegment(px, py) : hitTestBlock(px, py);

    if (seg) {
      if (S.mode === 'line') {
        const undoSnapshot = rememberBeforeEdit();
        if (!seg.lineOffsets) seg.lineOffsets = new Float64Array(seg.endFrame - seg.startFrame);
        seg.autoCurve = false;
        S.dragging = { kind: 'line', segId: seg.id, startX: px, startY: py, lastX: px, lastY: py, moved: false, undoSnapshot };
      } else {
        S.dragging = {
          kind: 'note', segId: seg.id, startX: px, startY: py,
          baseShift: currentShift(seg),
          baseCoarse: seg.shiftSemitones, baseFine: seg.fineCents,
          startView: S.viewStartSec,
          moved: false, axis: 'pending', undoSnapshot: rememberBeforeEdit(),
        };
      }
    } else {
      S.panning = { mode: 'pan', startX: px, startY: py, startView: S.viewStartSec, startMinMidi: S.minMidi, startMaxMidi: S.maxMidi };
    }
  });

  canvas.addEventListener('keydown', (e) => {
    if (!S.segments || !S.segments.length || S.mode !== 'note' || S.splitArmed ||
        e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const ordered = S.segments.slice().sort((a, b) => a.startTime - b.startTime);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      selectNoteByDirection(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const seg = ordered.find(item => item.id === S.selectedSegId);
      if (!seg) return;
      e.preventDefault();
      const snapshot = rememberBeforeEdit();
      normalizeSegmentShift(seg, currentShift(seg) + (e.key === 'ArrowUp' ? 1 : -1));
      pushUndoSnapshot(snapshot);
      updateInspector();
      render();
      S.previewSegId = seg.id;
      scheduleResynth(seg.id);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pinchActive || e.pointerId !== activePointerId) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;

    if (S.dragging) {
      const seg = S.segments[S.dragging.segId];
      const dx = px - S.dragging.startX, dy = py - S.dragging.startY;

      if (S.dragging.kind === 'note' && S.dragging.axis === 'pending') {
        const dragThreshold = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 12 : 8;
        if (Math.hypot(dx, dy) < dragThreshold) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.25) {
          const startView = S.dragging.startView;
          S.dragging = null;
          const originView = Math.max(0, startView - dx / S.pxPerSec);
          S.panning = {
            mode: 'pan', startX: px, startY: py,
            startView: originView,
            startMinMidi: S.minMidi, startMaxMidi: S.maxMidi,
            originView: startView, originMinMidi: S.minMidi, originMaxMidi: S.maxMidi
          };
          render();
          return;
        }
        S.dragging.axis = 'vertical';
      }

      const movedThreshold = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 10 : 4;
      if (Math.abs(dx) > movedThreshold || Math.abs(dy) > movedThreshold) S.dragging.moved = true;

      if (S.dragging.kind === 'line') {
        if (S.dragging.moved) {
          paintLineAt(seg, S.dragging.lastX, S.dragging.lastY, px, py);
          S.dragging.lastX = px; S.dragging.lastY = py;
        }
        render();
        return;
      }

      const semitoneDelta = Math.round(-dy / S.rowHeight);
      seg.shiftSemitones = S.dragging.baseCoarse + semitoneDelta;
      if (S.selectedSegId === seg.id) updateInspector();
      render();
      return;
    }
    if (S.panning && S.panning.mode === 'pan') {
      const dx = px - S.panning.startX, dy = py - S.panning.startY;
      S.viewStartSec = Math.max(0, S.panning.startView - dx / S.pxPerSec);
      const semitoneShift = dy / S.rowHeight;
      S.minMidi = S.panning.startMinMidi + semitoneShift;
      S.maxMidi = S.panning.startMaxMidi + semitoneShift;
      render();
      return;
    }
    if (S.panning && S.panning.mode === 'seek') {
      seekTo(timeForX(px));
    }
  });

  function cancelPointer(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    if (S.dragging && S.dragging.undoSnapshot) {
      const snapshot = S.dragging.undoSnapshot;
      S.segments = snapshot.segments.map(cloneSegmentForHistory);
      S.segments.forEach((seg, index) => { seg.id = index; });
      S.selectedSegId = snapshot.selectedSegId;
      hideInspector();
      updateInspector();
      updateUndoBtn();
    }
    if (S.panning && S.panning.mode === 'pan') {
      S.viewStartSec = S.panning.originView ?? S.panning.startView;
      S.minMidi = S.panning.originMinMidi ?? S.panning.startMinMidi;
      S.maxMidi = S.panning.originMaxMidi ?? S.panning.startMaxMidi;
    } else if (S.panning && S.panning.mode === 'seek') {
      seekTo(S.playStartOffsetSec);
    }
    S.dragging = null;
    S.panning = null;
    render();
  }

  function endPointer(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    if (S.dragging) {
      const seg = S.segments[S.dragging.segId];
      if (!S.dragging.moved) {
        // Mobile-safe behavior: a short tap opens details immediately.
        // Dragging is separated by a movement threshold, so tap and edit do not compete.
        showInspectorForSegment(seg.id);
      } else {
        pushUndoSnapshot(S.dragging.undoSnapshot);
        S.selectedSegId = seg.id;
        updateAccessibleNoteNav();
        hideInspector();
        S.previewSegId = seg.id;
        scheduleResynth(seg.id);
      }
      S.dragging = null;
      render();
    }
    S.panning = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', cancelPointer);

  // pinch-to-zoom (horizontal), anchored at the midpoint between the fingers.
  let pinchStartDist = null, pinchStartPxPerSec = null, pinchAnchorTime = null, pinchAnchorX = null;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchActive = true;
      // Pointer Events also fire for each touch. Retire the first finger's
      // single-pointer gesture so a pinch cannot move a note or pan the view.
      let cancelledGesture = false;
      if (S.dragging && S.dragging.undoSnapshot) {
        const snapshot = S.dragging.undoSnapshot;
        S.segments = snapshot.segments.map(cloneSegmentForHistory);
        S.segments.forEach((seg, index) => { seg.id = index; });
        S.selectedSegId = snapshot.selectedSegId;
        hideInspector();
        updateInspector();
        cancelledGesture = true;
      }
      if (S.panning && S.panning.mode === 'pan') {
        S.viewStartSec = S.panning.startView;
        S.minMidi = S.panning.startMinMidi;
        S.maxMidi = S.panning.startMaxMidi;
        cancelledGesture = true;
      }
      if (activePointerId !== null) {
        try { canvas.releasePointerCapture(activePointerId); } catch (err) {}
        activePointerId = null;
      }
      S.dragging = null;
      S.panning = null;
      if (cancelledGesture) {
        updateUndoBtn();
        render();
      }
      pinchStartDist = touchDist(e.touches);
      pinchStartPxPerSec = S.pxPerSec;
      const rect = canvas.getBoundingClientRect();
      pinchAnchorX = ((e.touches[0].clientX + e.touches[1].clientX) * 0.5) - rect.left;
      pinchAnchorTime = timeForX(pinchAnchorX);
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      const d = touchDist(e.touches);
      const factor = d / pinchStartDist;
      const newZoom = clampZoom(pinchStartPxPerSec * factor);
      S.pxPerSec = newZoom;
      if (pinchAnchorTime != null && pinchAnchorX != null) {
        S.viewStartSec = Math.max(0, pinchAnchorTime - pinchAnchorX / newZoom);
      }
      render();
    }
  }, { passive: false });
  function endPinch(e) {
    if (e.touches.length < 2) {
      pinchActive = false;
      pinchStartDist = null;
      pinchAnchorTime = null;
      pinchAnchorX = null;
    }
  }
  canvas.addEventListener('touchend', endPinch, { passive: true });
  canvas.addEventListener('touchcancel', endPinch, { passive: true });
  function cancelActiveInteraction() {
    if (activePointerId !== null) {
      const pointerId = activePointerId;
      cancelPointer({ pointerId });
      try { if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId); } catch (err) {}
    }
    if (pinchActive) endPinch({ touches: [] });
  }
  window.addEventListener('pagehide', cancelActiveInteraction);
  window.addEventListener('orientationchange', () => {
    cancelActiveInteraction();
    setTimeout(resizeCanvas, 200);
  });
  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  function clampZoom(v) { return Math.min(1200, Math.max(20, v)); }


  // ============================================================
  // Undo history (max 10 edit states)
  // ============================================================
  function cloneSegmentForHistory(seg) {
    const out = Object.assign({}, seg);
    out.lineOffsets = seg.lineOffsets ? Float64Array.from(seg.lineOffsets) : null;
    out.autoCurve = !!seg.autoCurve;
    return out;
  }

  function makeEditSnapshot() {
    return {
      segments: S.segments ? S.segments.map(cloneSegmentForHistory) : null,
      selectedSegId: S.selectedSegId,
    };
  }

  function updateUndoBtn() {
    const btn = $('undoBtn');
    if (!btn) return;
    btn.disabled = !S.segments || S.undoStack.length === 0;
    btn.title = `1つ前の編集に戻る（残り ${S.undoStack.length} / ${S.undoLimit}）`;
    btn.setAttribute('aria-label', btn.disabled ? '元に戻す。取り消せる編集はありません' : `元に戻す。取り消せる編集 ${S.undoStack.length} 件`);
  }

  function pushUndoSnapshot(snapshot) {
    if (!snapshot || !snapshot.segments) return;
    S.undoStack.push(snapshot);
    if (S.undoStack.length > S.undoLimit) S.undoStack.shift();
    updateUndoBtn();
  }

  function rememberBeforeEdit() {
    return makeEditSnapshot();
  }

  function clearUndoHistory() {
    S.undoStack.length = 0;
    updateUndoBtn();
  }

  async function undoLastEdit() {
    if (!S.undoStack.length) {
      toastMsg('戻せる編集はありません');
      return;
    }

    const snap = S.undoStack.pop();

    // Stop stale preview/playback so restored state is what the user hears.
    if (S.soloSource) {
      try { S.soloSource.onended = null; S.soloSource.stop(); } catch (e) {}
      S.soloSource = null;
    }

    S.segments = snap.segments.map(cloneSegmentForHistory);
    S.segments.forEach((seg, idx) => { seg.id = idx; });

    const restoredSelected = snap.selectedSegId;
    S.selectedSegId = (
      restoredSelected != null &&
      S.segments.some(s => s.id === restoredSelected)
    ) ? restoredSelected : null;

    hideInspector();
    updateInspector();
    render();
    updateUndoBtn();

    // A split or bulk change may affect segment layout, so full resynthesis is safest.
    S.previewSegId = null;
    scheduleResynth();
    toastMsg(`1つ前に戻しました（残り ${S.undoStack.length}）`);
  }

  $('undoBtn').addEventListener('click', undoLastEdit);

  function zoomAroundCenter(factor) {
    const w = Math.max(1, rollWrap.clientWidth);
    const centerX = w * 0.5;
    const centerTime = timeForX(centerX);
    S.pxPerSec = clampZoom(S.pxPerSec * factor);
    S.viewStartSec = Math.max(0, centerTime - centerX / S.pxPerSec);
    render();
  }
  $('zoomInBtn').addEventListener('click', () => zoomAroundCenter(1.6));
  $('zoomOutBtn').addEventListener('click', () => zoomAroundCenter(1 / 1.6));
  $('fitAllBtn').addEventListener('click', fitDetectedAllView);

  $('resetAllBtn').addEventListener('click', () => {
    const undoSnapshot = rememberBeforeEdit();
    pushUndoSnapshot(undoSnapshot);
    for (const seg of S.segments) resetSegment(seg);
    scheduleResynth();
    updateInspector();
    render();
    toastMsg('すべてリセットしました');
  });

  // ============================================================
  // Note / Line mode toggle + split
  // ============================================================
  function setMode(mode) {
    S.mode = mode;
    $('modeNoteBtn').classList.toggle('active', mode === 'note');
    $('modeLineBtn').classList.toggle('active', mode === 'line');
    $('modeNoteBtn').setAttribute('aria-pressed', String(mode === 'note'));
    $('modeLineBtn').setAttribute('aria-pressed', String(mode === 'line'));
    updateInteractionGuide();
  }
  $('modeNoteBtn').addEventListener('click', () => setMode('note'));
  $('modeLineBtn').addEventListener('click', () => setMode('line'));
  $('splitBtn').addEventListener('click', () => {
    S.splitArmed = !S.splitArmed;
    updateSplitBtnUI();
    if (S.splitArmed) toastMsg('分割したいノートの位置をタップしてください');
  });
  $('autoPreviewBtn').addEventListener('click', () => {
    S.autoPreviewEnabled = !S.autoPreviewEnabled;
    $('autoPreviewBtn').classList.toggle('accent', S.autoPreviewEnabled);
    $('autoPreviewBtn').setAttribute('aria-pressed', String(S.autoPreviewEnabled));
    $('autoPreviewBtn').innerHTML = `${S.autoPreviewEnabled ? '🔊' : '🔈'}<span class="toolLabel">自動試聴</span>`;
    toastMsg(S.autoPreviewEnabled ? '編集後の自動試聴: オン' : '編集後の自動試聴: オフ');
  });

  function medianLineOffset(seg) {
    if (!seg || !seg.lineOffsets || seg.lineOffsets.length === 0) return 0;
    const vals = [];
    for (let i = 0; i < seg.lineOffsets.length; i++) {
      const v = seg.lineOffsets[i];
      if (Number.isFinite(v)) vals.push(v);
    }
    if (!vals.length) return 0;
    vals.sort((a,b) => a-b);
    return vals[Math.floor(vals.length / 2)];
  }

  function signedCents(v) {
    const c = Math.round(v);
    return (c > 0 ? '+' : '') + c + '¢';
  }

  function pitchStatLabel(midi) {
    if (!Number.isFinite(midi)) return '--';
    const note = PE.midiToNoteName(Math.round(midi));
    const cents = (midi - Math.round(midi)) * 100;
    return `${note} ${signedCents(cents)}`;
  }


  function normalizeSegmentShift(seg, absoluteShift) {
    if (!seg || !Number.isFinite(absoluteShift)) return;
    seg.shiftSemitones = Math.trunc(absoluteShift);
    seg.fineCents = Math.round((absoluteShift - seg.shiftSemitones) * 100);
    while (seg.fineCents >= 100) { seg.fineCents -= 100; seg.shiftSemitones += 1; }
    while (seg.fineCents <= -100) { seg.fineCents += 100; seg.shiftSemitones -= 1; }
  }

  // Estimate expressive pitch motion near note edges.  The aim is not to
  // "correct" intentional scoops/portamento/falls as if they were tuning drift.
  // Returns per-frame protection (0..1, where 1 = leave this frame alone) and
  // lightweight labels for debugging/inspection.
  function detectExpressivePitchEdges(raw, slow, hop) {
    const len = raw.length;
    const protection = new Float64Array(len);
    const labels = [];
    if (len < 7) return { protection, labels };

    function finiteMedian(a, b) {
      const vals = [];
      for (let i = Math.max(0, a); i < Math.min(len, b); i++) {
        const v = slow[i];
        if (Number.isFinite(v)) vals.push(v);
      }
      if (!vals.length) return NaN;
      vals.sort((x,y)=>x-y);
      return vals[Math.floor(vals.length/2)];
    }
    function addRamp(a, b, peak, reverse=false) {
      a=Math.max(0,a); b=Math.min(len,b);
      const span=Math.max(1,b-a-1);
      for(let i=a;i<b;i++) {
        const x=(i-a)/span;
        const w=reverse ? x : (1-x);
        protection[i]=Math.max(protection[i], peak*Math.max(0,Math.min(1,w)));
      }
    }

    // Compare the stable middle with short windows near attack/release.
    const midA=Math.floor(len*0.36), midB=Math.max(midA+1,Math.ceil(len*0.64));
    const edgeFrames=Math.max(3, Math.min(Math.floor(len*0.30), Math.round(0.22/Math.max(0.001,hop))));
    const middle=finiteMedian(midA,midB);
    const attack=finiteMedian(0, edgeFrames);
    const release=finiteMedian(len-edgeFrames, len);

    // Require a musically meaningful edge displacement (~18 cents) and a
    // directional trend. Stronger motion receives stronger protection.
    if (Number.isFinite(middle) && Number.isFinite(attack)) {
      const d=middle-attack; // positive = scoop up into the note
      if (Math.abs(d) >= 0.18) {
        let agree=0,total=0;
        for(let i=1;i<Math.min(edgeFrames,len);i++) {
          if(!Number.isFinite(slow[i-1])||!Number.isFinite(slow[i])) continue;
          const step=slow[i]-slow[i-1]; total++;
          if ((d>0 && step>-0.035) || (d<0 && step<0.035)) agree++;
        }
        if(total && agree/total>=0.58) {
          const peak=Math.min(1,0.58+Math.abs(d)*0.55);
          addRamp(0, Math.min(len,edgeFrames+2), peak, false);
          labels.push(d>0?'scoop':'attack-portamento');
        }
      }
    }

    if (Number.isFinite(middle) && Number.isFinite(release)) {
      const d=release-middle; // negative = fall, positive = upward release/portamento
      if (Math.abs(d) >= 0.18) {
        let agree=0,total=0;
        const a=Math.max(1,len-edgeFrames);
        for(let i=a;i<len;i++) {
          if(!Number.isFinite(slow[i-1])||!Number.isFinite(slow[i])) continue;
          const step=slow[i]-slow[i-1]; total++;
          if ((d<0 && step<0.035) || (d>0 && step>-0.035)) agree++;
        }
        if(total && agree/total>=0.58) {
          const peak=Math.min(1,0.62+Math.abs(d)*0.55);
          // reverse=true makes protection strongest at the release end.
          addRamp(Math.max(0,len-edgeFrames-2), len, peak, true);
          labels.push(d<0?'fall':'release-portamento');
        }
      }
    }

    return { protection, labels };
  }

  // Lightly reduce slow intonation drift inside a note while preserving
  // faster expressive motion (vibrato), scoops/portamento/falls and natural
  // attacks/releases. Manual Line-tool edits always win; an auto-generated
  // curve may be regenerated when the correction strength changes.
  function applyNaturalCurveStabilization(seg, strength = S.correctionStrength) {
    if (!seg || (seg.lineOffsets && !seg.autoCurve) || !S.pitchTrack || !S.pitchTrack.f0s || !S.pitchTrack.voiced) return false;
    const { f0s, voiced, times } = S.pitchTrack;
    const len = Math.max(0, seg.endFrame - seg.startFrame);
    if (len < 7 || seg.durationSec < 0.14) return false;

    const raw = new Float64Array(len);
    const finite = [];
    for (let k = 0; k < len; k++) {
      const i = seg.startFrame + k;
      if (voiced[i] && f0s[i] > 0) {
        raw[k] = PE.freqToMidi(f0s[i]);
        finite.push(raw[k]);
      } else raw[k] = NaN;
    }
    if (finite.length < Math.max(5, Math.floor(len * 0.55))) return false;
    finite.sort((a,b)=>a-b);
    const center = finite[Math.floor(finite.length / 2)];

    const hop = times && times.length > 1 ? Math.max(0.001, times[1] - times[0]) : 0.01;
    const halfWin = Math.max(2, Math.round(0.075 / hop)); // ~150 ms low-pass span
    const slow = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      if (!Number.isFinite(raw[k])) { slow[k] = NaN; continue; }
      const vals = [];
      for (let j = Math.max(0, k-halfWin); j <= Math.min(len-1, k+halfWin); j++) {
        if (Number.isFinite(raw[j])) vals.push(raw[j]);
      }
      vals.sort((a,b)=>a-b);
      slow[k] = vals.length ? vals[Math.floor(vals.length/2)] : raw[k];
    }

    const expressive = detectExpressivePitchEdges(raw, slow, hop);
    const offsets = new Float64Array(len);
    const amount = Math.min(0.42, 0.12 + 0.30 * Math.max(0, Math.min(1, strength)));
    const edgeFrac = 0.18;
    let maxAbs = 0;
    for (let k = 0; k < len; k++) {
      if (!Number.isFinite(slow[k])) continue;
      const x = len > 1 ? k / (len - 1) : 0.5;
      const edgeWeight = Math.min(1, x / edgeFrac, (1 - x) / edgeFrac);
      const expressiveWeight = 1 - Math.max(0, Math.min(1, expressive.protection[k]));
      const slowDev = slow[k] - center;
      const dead = 0.08; // keep +/-8 cents of natural slow motion untouched
      const excess = Math.sign(slowDev) * Math.max(0, Math.abs(slowDev) - dead);
      const corr = Math.max(-0.28, Math.min(0.28, -excess * amount * Math.max(0, edgeWeight) * expressiveWeight));
      offsets[k] = corr;
      maxAbs = Math.max(maxAbs, Math.abs(corr));
    }

    if (maxAbs < 0.008) {
      if (seg.autoCurve) { seg.lineOffsets = null; seg.autoCurve = false; }
      seg.expressivePitchLabels = expressive.labels;
      return false;
    }
    // Keep the curve center-neutral so note targeting remains controlled by the
    // coarse/fine shift and not by an accidental DC offset in this helper curve.
    const vals = Array.from(offsets).filter(Number.isFinite).sort((a,b)=>a-b);
    const med = vals.length ? vals[Math.floor(vals.length/2)] : 0;
    for (let k = 0; k < offsets.length; k++) offsets[k] -= med;
    seg.lineOffsets = offsets;
    seg.autoCurve = true;
    seg.expressivePitchLabels = expressive.labels;
    return true;
  }

  function applyTargetWithStrength(seg, targetMidi, strength = S.correctionStrength) {
    if (!seg || !Number.isFinite(targetMidi)) return false;
    strength = Math.max(0, Math.min(1, Number(strength) || 0));
    const lineMedian = medianLineOffset(seg);
    const currentCenter = seg.medianMidi + currentShift(seg) + lineMedian;
    const delta = targetMidi - currentCenter;

    // Avoid unnecessary resynthesis for sub-cent moves, but still allow the
    // natural-curve pass to clean up a noticeably wandering note.
    let changed = false;
    if (Math.abs(delta) >= 0.01 && strength > 0) {
      const nextShift = currentShift(seg) + delta * strength;
      normalizeSegmentShift(seg, nextShift);
      changed = true;
    }
    if (strength > 0 && applyNaturalCurveStabilization(seg, strength)) changed = true;
    return changed;
  }

  function applyNearestCorrection(seg, strength = S.correctionStrength) {
    if (!seg || !Number.isFinite(seg.medianMidi)) return false;
    const currentCenter = seg.medianMidi + currentShift(seg) + medianLineOffset(seg);
    const target = Math.round(currentCenter);
    return applyTargetWithStrength(seg, target, strength);
  }

  function setCorrectionStrength(percent, announce = false) {
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    S.correctionStrength = p / 100;
    if (strengthRange) strengthRange.value = String(p);
    if (strengthValue) strengthValue.textContent = `${p}%`;
    if (autoCorrectLabel) autoCorrectLabel.textContent = `自動補正 ${p}%`;
    if (strengthPresets) {
      strengthPresets.querySelectorAll('.strengthPreset').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.strength) === p);
      });
    }
    if (announce) toastMsg(`補正強度 ${p}%`);
  }

  // ============================================================
  // Inspector
  // ============================================================
  function hideInspector() {
    if (!inspector) return;
    inspector.classList.remove('show');
    inspector.setAttribute('aria-hidden', 'true');
    inspector.style.display = 'none';
    if (a11yStatus) a11yStatus.textContent = '';
  }

  function updateAccessibleNoteNav() {
    if (!accessibleNoteNav || !a11yPreviousNote || !a11yNextNote) return;
    const segments = S.segments;
    accessibleNoteNav.hidden = !segments || segments.length === 0;
    if (!segments || !segments.length) return;
    const ordered = segments.slice().sort((a, b) => a.startTime - b.startTime);
    const current = ordered.findIndex(seg => seg.id === S.selectedSegId);
    // Keep edge controls focusable. Native disabled removes the focused
    // VoiceOver button from the focus order as soon as its note is selected.
    a11yPreviousNote.disabled = false;
    a11yNextNote.disabled = false;
    a11yPreviousNote.setAttribute('aria-disabled', String(current === 0));
    a11yNextNote.setAttribute('aria-disabled', String(current === ordered.length - 1));
  }

  function selectNoteByDirection(direction) {
    if (!S.segments || !S.segments.length) return;
    const ordered = S.segments.slice().sort((a, b) => a.startTime - b.startTime);
    const current = ordered.findIndex(seg => seg.id === S.selectedSegId);
    if ((direction < 0 && current === 0) || (direction > 0 && current === ordered.length - 1)) return;
    const next = current < 0 ? (direction > 0 ? 0 : ordered.length - 1) :
      Math.max(0, Math.min(ordered.length - 1, current + direction));
    showInspectorForSegment(ordered[next].id);
    render();
  }

  a11yPreviousNote.addEventListener('click', () => selectNoteByDirection(-1));
  a11yNextNote.addEventListener('click', () => selectNoteByDirection(1));
  accessibleNoteNav.addEventListener('focusin', () => editorScreen.classList.add('a11y-note-nav-focused'));
  accessibleNoteNav.addEventListener('focusout', (event) => {
    if (!accessibleNoteNav.contains(event.relatedTarget)) editorScreen.classList.remove('a11y-note-nav-focused');
  });

  function showInspectorForSegment(id) {
    const seg = S.segments && S.segments.find ? S.segments.find(s => s.id === id) : null;
    if (!seg || !inspector) return;
    S.selectedSegId = id;

    // Force the element back into layout before updating content.
    inspector.style.display = 'block';
    inspector.removeAttribute('hidden');
    inspector.setAttribute('aria-hidden', 'false');
    updateInspector();

    requestAnimationFrame(() => {
      inspector.style.display = 'block';
      inspector.classList.add('show');
    });
  }

  function selectSegment(id, openDetails = true) {
    S.selectedSegId = id;
    if (openDetails) {
      showInspectorForSegment(id);
    } else {
      updateInspector();
      hideInspector();
    }
  }
  function updateInspector() {
    if (S.selectedSegId == null) { inspector.style.display = 'none'; updateAccessibleNoteNav(); return; }
    const seg = S.segments.find(s => s.id === S.selectedSegId);
    if (!seg) { inspector.style.display = 'none'; updateAccessibleNoteNav(); return; }
    inspector.style.display = 'block';
    const shift = currentShift(seg);
    const lineMedian = medianLineOffset(seg);
    const beforeMidi = seg.medianMidi;
    const afterMidi = seg.medianMidi + shift + lineMedian;
    const targetMidi = Math.round(afterMidi);
    const orderedSegments = S.segments.slice().sort((a, b) => a.startTime - b.startTime);
    const selectedPosition = orderedSegments.findIndex(item => item.id === seg.id) + 1;
    inspNote.textContent = PE.midiToNoteName(targetMidi);
    const totalShiftCents = (shift + lineMedian) * 100;
    const targetDevCents = (afterMidi - targetMidi) * 100;
    inspOffset.textContent = `${signedCents(totalShiftCents)} 補正 / 目標から ${signedCents(targetDevCents)} / 強度 ${Math.round(S.correctionStrength * 100)}%`;
    inspBefore.textContent = pitchStatLabel(beforeMidi);
    inspAfter.textContent = pitchStatLabel(afterMidi);
    inspTarget.textContent = PE.midiToNoteName(targetMidi);
    if (a11yStatus) {
      a11yStatus.textContent = `ノート ${selectedPosition} / ${orderedSegments.length}、選択中 ${PE.midiToNoteName(targetMidi)}。補正前 ${pitchStatLabel(beforeMidi)}、補正後 ${pitchStatLabel(afterMidi)}、目標 ${PE.midiToNoteName(targetMidi)}。左右矢印でノート選択、上下矢印で半音変更できます。`;
    }
    updateAccessibleNoteNav();
    const hasRef = suggestionDiffersEnough(seg);
    inspRef.disabled = !hasRef;
    inspRef.textContent = hasRef ? `お手本候補 ${PE.midiToNoteName(Math.round(seg.refSuggestMidi))}` : 'お手本候補なし';
  }

  if (strengthRange) {
    strengthRange.addEventListener('input', () => setCorrectionStrength(strengthRange.value, false));
    strengthRange.addEventListener('change', () => setCorrectionStrength(strengthRange.value, true));
  }
  if (strengthPresets) {
    strengthPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('.strengthPreset');
      if (!btn) return;
      setCorrectionStrength(btn.dataset.strength, true);
    });
  }
  setCorrectionStrength(60, false);

  autoCorrectBtn.addEventListener('click', () => {
    if (!S.segments || S.segments.length === 0) return;
    const undoSnapshot = rememberBeforeEdit();
    let count = 0;
    for (const seg of S.segments) {
      if (!Number.isFinite(seg.medianMidi) || seg.durationSec < 0.06) continue;
      if (applyNearestCorrection(seg)) count++;
    }
    if (!count) {
      toastMsg('補正するズレはありません');
      return;
    }
    pushUndoSnapshot(undoSnapshot);
    updateInspector();
    render();
    scheduleResynth();
    toastMsg(`${count}ノートを ${Math.round(S.correctionStrength * 100)}% で自然補正しました`, 2800);
  });

  inspCenter.addEventListener('click', () => {
    if (S.selectedSegId == null) return;
    const seg = S.segments.find(s => s.id === S.selectedSegId);
    if (!seg) return;
    const undoSnapshot = rememberBeforeEdit();
    const lineMedian = medianLineOffset(seg);
    const currentMidi = seg.medianMidi + currentShift(seg) + lineMedian;
    const targetMidi = Math.round(currentMidi);
    if (!applyTargetWithStrength(seg, targetMidi)) {
      toastMsg('このノートはすでに目標付近です');
      return;
    }
    pushUndoSnapshot(undoSnapshot);
    updateInspector(); render();
    S.previewSegId = seg.id;
    scheduleResynth(seg.id);
    toastMsg(`中心へ ${Math.round(S.correctionStrength * 100)}% 補正しました`);
  });

  inspRef.addEventListener('click', () => {
    if (S.selectedSegId == null) return;
    const seg = S.segments.find(s => s.id === S.selectedSegId);
    if (!seg || !suggestionDiffersEnough(seg)) return;
    const undoSnapshot = rememberBeforeEdit();
    if (!applySuggestion(seg)) {
      toastMsg('このノートはお手本候補付近です');
      return;
    }
    pushUndoSnapshot(undoSnapshot);
    updateInspector(); render();
    S.previewSegId = seg.id;
    scheduleResynth(seg.id);
    toastMsg(`お手本へ ${Math.round(S.correctionStrength * 100)}% 補正しました`);
  });

  $('inspClose').addEventListener('click', () => {
    S.selectedSegId = null;
    hideInspector();
    updateAccessibleNoteNav();
    render();
  });
  $('inspReset').addEventListener('click', () => {
    if (S.selectedSegId == null) return;
    const seg = S.segments.find(s => s.id === S.selectedSegId);
    const undoSnapshot = rememberBeforeEdit();
    resetSegment(seg);
    pushUndoSnapshot(undoSnapshot);
    updateInspector(); render(); scheduleResynth(seg.id);
  });
  $('inspPlay').addEventListener('click', () => {
    if (S.selectedSegId == null) return;
    playSegmentSolo(S.segments[S.selectedSegId]);
  });
  document.querySelectorAll('#inspector .rowBtns button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (S.selectedSegId == null) return;
      const seg = S.segments.find(s => s.id === S.selectedSegId);
      const undoSnapshot = rememberBeforeEdit();
      const d = parseInt(btn.dataset.d, 10);
      seg.fineCents += d;
      // normalize overflow into whole semitones so fineCents stays readable
      while (seg.fineCents >= 100) { seg.fineCents -= 100; seg.shiftSemitones += 1; }
      while (seg.fineCents <= -100) { seg.fineCents += 100; seg.shiftSemitones -= 1; }
      pushUndoSnapshot(undoSnapshot);
      updateInspector(); render();
      S.previewSegId = seg.id;
      scheduleResynth(seg.id);
    });
  });


  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLastEdit();
    }
  });

  // ============================================================
  // Resynthesis (debounced, off main thread)
  //
  // Editing one note used to re-run PSOLA over the ENTIRE track on every
  // change -- fine for a few-second test clip, but for a real song (a few
  // hundred x realtime slower than instant) that made every drag feel
  // laggy. Each segment's grain schedule is already self-contained (the
  // sourceTime wrap/reset logic keeps it from reading or writing outside
  // its own [startTime,endTime), see buildGrainSchedule's comment) --
  // editing one note therefore can NEVER change the rendered audio
  // anywhere outside roughly that note's own span. So a single-segment
  // edit only resynthesizes a small local window (that segment plus one
  // neighbor on each side, for safety margin against grain-window
  // overlap at the boundary) and splices the result back into the
  // existing edited buffer, instead of reprocessing the whole file.
  // Bulk edits (reset all, apply-all-suggestions) still go through a
  // full-track resynthesis, and multiple distinct segments edited within
  // one debounce window are tracked in a set and each resynthesized in
  // turn, so audio never silently falls behind what's shown.
  // ============================================================
  function scheduleResynth(segId) {
    S.editRevision++;
    if (segId != null && !S.pendingFullResynth) S.pendingResynthSet.add(segId);
    else S.pendingFullResynth = true;
    clearTimeout(S.resynthTimer);
    S.resynthTimer = setTimeout(runPendingResynth, IS_IOS ? 90 : 180);
  }

  async function runPendingResynth() {
    if (S.resynthBusy) { S.resynthQueued = true; return; }
    if (!S.pendingFullResynth && S.pendingResynthSet.size === 0) return;
    S.resynthBusy = true;
    const audioSessionId = S.audioSessionId;
    const renderingRevision = S.editRevision;
    const wasPlaying = S.playing;
    // Keep the current source playing while the replacement audio is rendered.
    // Its old AudioBuffer remains valid until the completed render is ready.
    try {
      if (S.pendingFullResynth) {
        S.pendingFullResynth = false;
        S.pendingResynthSet.clear();
        await doFullResynth(audioSessionId);
      } else {
        const ids = Array.from(S.pendingResynthSet);
        S.pendingResynthSet.clear();
        // A local splice needs a mutable baseline. Create the iPhone's
        // full-song edited PCM only when the first real edit is rendered.
        if (!S.editedChannels) S.editedChannels = S.origChannels.map((ch) => Float32Array.from(ch));
        for (const id of ids) {
          if (audioSessionId !== S.audioSessionId) break;
          await doPartialResynth(id, audioSessionId);
        }
      }
      if (audioSessionId !== S.audioSessionId) return;
      // Keep rendered PCM authoritative; WebAudio AudioBuffer is a second
      // full-size PCM copy, so materialize it lazily on iPhone/mobile.
      S.audioRevision = Math.max(S.audioRevision, renderingRevision);
      if (wasPlaying) {
        if (!document.hidden && S.playing) {
          // Prepare the replacement while the old source continues. Keep the
          // old AudioBuffer installed until this completes so tick() keeps
          // the active source alive.
          await rebuildEditedBuffer();
          if (audioSessionId === S.audioSessionId && !document.hidden && S.playing) {
            const resumeAt = getPlayheadTime();
            stopPlayback(true);
            S.playStartOffsetSec = resumeAt;
            startPlayback(true);
          }
        } else {
          S.editedBuffer = null;
        }
      } else {
        S.editedBuffer = null;
        if (!document.hidden && S.previewSegId != null && S.autoPreviewEnabled) {
          const previewGeneration = S.soloPreviewGeneration;
          const previewSegId = S.previewSegId;
          await rebuildEditedBuffer();
          if (audioSessionId === S.audioSessionId && !document.hidden &&
              previewGeneration === S.soloPreviewGeneration) {
            await playSegmentSolo(S.segments.find((seg) => seg.id === previewSegId));
          }
        }
      }
      S.previewSegId = null;
    } catch (err) {
      // A render from a replaced audio session is obsolete; suppress its
      // late error so it cannot confuse the user after the new song loaded.
      if (audioSessionId !== S.audioSessionId) return;
      console.error(err);
      toastMsg('再合成でエラーが発生しました', 3000, true);
    } finally {
      S.resynthBusy = false;
      if (S.resynthQueued) {
        S.resynthQueued = false;
        // Avoid an unhandled rejection from the fire-and-forget follow-up.
        runPendingResynth().catch((err) => {
          console.error(err);
          toastMsg('再合成でエラーが発生しました', 3000, true);
        });
      }
    }
  }

  function segmentToPlain(s) {
    return {
      startFrame: s.startFrame, endFrame: s.endFrame, startTime: s.startTime, endTime: s.endTime,
      shiftSemitones: s.shiftSemitones, fineCents: s.fineCents,
      lineOffsets: s.lineOffsets ? Float64Array.from(s.lineOffsets) : null,
      autoCurve: !!s.autoCurve,
    };
  }

  async function doFullResynth(audioSessionId = S.audioSessionId) {
    const renderT0 = performance.now();
    const segsPlain = S.segments.map(segmentToPlain);
    let res;

    if (IS_IOS) {
      // iPhone memory-first path. Worker transfer would require cloning every
      // source channel first, temporarily adding another full-song PCM copy.
      // Keep the same DSP but render from the existing source arrays.
      await new Promise(requestAnimationFrame);
      res = { channels: await PE.resynthesizeChunked(
        S.origChannels, S.sr, S.pitchTrack, segsPlain,
        { blockFrames: 16384 }
      ) };
    } else {
      // Android/desktop retain Worker execution to keep the UI responsive.
      const channelsCopy = S.origChannels.map((c) => Float32Array.from(c));
      res = await workerCall(
        { type: 'resynth', channels: channelsCopy, sr: S.sr, pitchTrack: S.pitchTrack, segments: segsPlain },
        channelsCopy.map((c) => c.buffer)
      );
    }

    if (audioSessionId !== S.audioSessionId) return;
    S.editedChannels = res.channels;
    console.info(`[PitchEditor] full resynthesis ${(performance.now() - renderT0).toFixed(0)} ms (${IS_IOS ? 'iOS chunked memory-first' : 'worker'})`);
  }

  // Builds the small local slice (input channels + a matching offset
  // pitchTrack/segments) needed to re-render just the audio around one
  // segment. Anchored on the segment's immediate neighbors when they
  // exist (a safe, deterministic splice point since the neighbor's own
  // audio comes out identical whether included or not); falls back to a
  // fixed time pad at the start/end of the track.
  function buildLocalRegion(segId) {
    const segs = S.segments;
    const segIndex = segs.findIndex((s) => s.id === segId);
    if (segIndex < 0) return null;
    const seg = segs[segIndex];
    const prev = segs[segIndex - 1] || null;
    const next = segs[segIndex + 1] || null;
    // Preserve adjacent-note context, but do not automatically render an
    // entire neighboring note. A bounded pitch-aware margin provides several
    // periods for PSOLA + the existing feather transition.
    const centerHz = seg.medianMidi != null ? PE.midiToFreq(seg.medianMidi) : 120;
    const pad = Math.max(0.055, Math.min(0.14, 6 / Math.max(70, centerHz) + 0.035));
    const duration = S.origChannels[0].length / S.sr;
    const prevBoundary = prev ? Math.max(prev.startTime, prev.endTime - pad) : seg.startTime - pad;
    const nextBoundary = next ? Math.min(next.endTime, next.startTime + pad) : seg.endTime + pad;
    const regionStartSec = Math.max(0, Math.min(seg.startTime - pad, prevBoundary));
    const regionEndSec = Math.min(duration, Math.max(seg.endTime + pad, nextBoundary));
    if (regionEndSec <= regionStartSec) return null;

    const { times, f0s, voiced, clarity } = S.pitchTrack;
    let lo = 0, hi = times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < regionStartSec) lo = m + 1; else hi = m; }
    const fLo = lo;
    lo = fLo; hi = times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= regionEndSec) lo = m + 1; else hi = m; }
    const fHi = lo;
    if (fHi <= fLo) return null;

    const localTimes = new Float64Array(fHi - fLo);
    for (let i = fLo; i < fHi; i++) localTimes[i - fLo] = times[i] - regionStartSec;
    const localPitchTrack = {
      times: localTimes,
      f0s: f0s.slice(fLo, fHi),
      voiced: voiced.slice(fLo, fHi),
      clarity: clarity ? clarity.slice(fLo, fHi) : undefined,
      hopSize: S.pitchTrack.hopSize, frameSize: S.pitchTrack.frameSize,
    };

    const localSegments = [];
    for (const s of segs) {
      if (s.endTime <= regionStartSec || s.startTime >= regionEndSec) continue;
      const plain = segmentToPlain(s);
      plain.startFrame = Math.max(0, s.startFrame - fLo);
      plain.endFrame = Math.min(fHi - fLo, s.endFrame - fLo);
      plain.startTime = s.startTime - regionStartSec;
      plain.endTime = s.endTime - regionStartSec;
      localSegments.push(plain);
    }

    const regionStartSample = Math.round(regionStartSec * S.sr);
    const regionEndSample = Math.min(S.origChannels[0].length, Math.round(regionEndSec * S.sr));
    if (regionEndSample <= regionStartSample) return null;
    const localChannels = S.origChannels.map((ch) => Float32Array.from(ch.subarray(regionStartSample, regionEndSample)));

    return { regionStartSample, regionEndSample, localChannels, localPitchTrack, localSegments };
  }

  async function doPartialResynth(segId, audioSessionId = S.audioSessionId) {
    const partialT0 = performance.now();
    const region = buildLocalRegion(segId);
    if (!region) { await doFullResynth(audioSessionId); return; } // safety net -- fall back rather than skip the edit
    const { regionStartSample, regionEndSample, localChannels, localPitchTrack, localSegments } = region;
    const localN = regionEndSample - regionStartSample;
    const res = await workerCall(
      { type: 'resynth', preferMainThread: true, channels: localChannels, sr: S.sr, pitchTrack: localPitchTrack, segments: localSegments },
      localChannels.map((c) => c.buffer)
    );
    if (audioSessionId !== S.audioSessionId || !S.editedChannels) return;
    res.channels.forEach((ch, c) => {
      if (S.editedChannels[c]) S.editedChannels[c].set(ch.subarray(0, localN), regionStartSample);
    });
    console.info(`[PitchEditor] local resynthesis ${(performance.now() - partialT0).toFixed(0)} ms, ${(localN / S.sr).toFixed(2)} s region`);
  }

  async function rebuildEditedBuffer() {
    const channels = S.editedChannels || S.origChannels;
    if (!channels || !channels.length) return;
    const len = channels[0].length;
    const buf = S.audioCtx.createBuffer(S.numCh, len, S.sr);
    for (let c = 0; c < S.numCh; c++) {
      const dst = buf.getChannelData(c);
      const src = channels[Math.min(c, channels.length - 1)];
      dst.set(src.length === len ? src : src.subarray(0, len));
    }
    S.editedBuffer = buf;
  }

  // ============================================================
  // Playback
  // ============================================================

  // Solo-preview just one note's audio (its own [startTime,endTime) slice
  // of the current edited buffer), independent of the main playhead/play
  // button -- lets the user quickly audition an edit without playing the
  // whole track. Interrupts any previous solo preview so rapid edits don't
  // pile up overlapping audio.
  async function playSegmentSolo(seg) {
    if (!seg || !S.origChannels) return;
    const generation = S.soloPreviewGeneration = (S.soloPreviewGeneration || 0) + 1;
    if (!S.editedBuffer) await rebuildEditedBuffer();
    if (document.hidden || generation !== S.soloPreviewGeneration) return;
    if (S.soloSource) { try { S.soloSource.onended = null; S.soloSource.stop(); } catch (e) {} S.soloSource = null; }
    await unlockAudio();
    if (document.hidden || generation !== S.soloPreviewGeneration || !S.editedBuffer) return;
    const src = S.audioCtx.createBufferSource();
    src.buffer = S.editedBuffer;
    src.connect(S.audioCtx.destination);
    const start = Math.max(0, Math.min(seg.startTime, S.editedBuffer.duration - 0.001));
    const dur = Math.max(0.02, Math.min(seg.endTime - seg.startTime, S.editedBuffer.duration - start));
    src.start(0, start, dur);
    src.onended = () => { if (S.soloSource === src) S.soloSource = null; };
    S.soloSource = src;
  }

  function seekTo(t) {
    const dur = S.editedBuffer ? S.editedBuffer.duration :
      (S.editedChannels && S.editedChannels[0] ? S.editedChannels[0].length / S.sr : 0);
    t = Math.max(0, Math.min(dur, t));
    const wasPlaying = S.playing;
    if (wasPlaying) stopPlayback(true);
    else S.playbackGeneration = (S.playbackGeneration || 0) + 1;
    S.playStartOffsetSec = t;
    if (wasPlaying) startPlayback();
    render();
  }

  async function startPlayback(skipFlush = false) {
    if (!S.origChannels) return;
    const generation = S.playbackGeneration = (S.playbackGeneration || 0) + 1;
    const audioSessionId = S.audioSessionId;
    stopReference();
    await unlockAudio();
    if (document.hidden || generation !== S.playbackGeneration || audioSessionId !== S.audioSessionId) return;

    // On slower iPhones the user can hit Play before the debounce/Worker has
    // committed the latest pitch edit. Always catch audio up to the UI first.
    if (!skipFlush && (
      S.audioRevision < S.editRevision ||
      S.resynthBusy || S.pendingFullResynth ||
      S.pendingResynthSet.size > 0 || S.resynthQueued
    )) {
      toastMsg('補正を音声へ反映中…', 1200);
      await flushResynth();
      if (document.hidden || generation !== S.playbackGeneration || audioSessionId !== S.audioSessionId) return;
    }
    if (!S.editedBuffer) await rebuildEditedBuffer();
    if (document.hidden || generation !== S.playbackGeneration || audioSessionId !== S.audioSessionId) return;
    if (!S.editedBuffer) return;

    const src = S.audioCtx.createBufferSource();
    src.buffer = S.editedBuffer;
    src.connect(S.audioCtx.destination);
    const offset = Math.min(S.playStartOffsetSec, S.editedBuffer.duration - 0.001);
    src.start(0, Math.max(0, offset));
    src.onended = () => { if (S.playSource === src) { S.playing = false; $('playBtn').innerHTML = '▶<span class="toolLabel">再生</span>'; } };
    S.playSource = src;
    S.playStartCtxTime = S.audioCtx.currentTime;
    S.playing = true;
    $('playBtn').innerHTML = '⏸<span class="toolLabel">停止</span>';
    requestAnimationFrame(tick);
  }
  function stopPlayback(keepOffset) {
    S.playbackGeneration = (S.playbackGeneration || 0) + 1;
    if (S.playSource) {
      try { S.playSource.onended = null; S.playSource.stop(); } catch (e) {}
      S.playSource = null;
    }
    if (S.playing && !keepOffset) S.playStartOffsetSec = getPlayheadTime();
    else if (S.playing) S.playStartOffsetSec = getPlayheadTime();
    S.playing = false;
    $('playBtn').innerHTML = '▶<span class="toolLabel">再生</span>';
  }
  $('playBtn').addEventListener('click', async () => {
    if (S.playing) stopPlayback();
    else {
      try { await startPlayback(); }
      catch (err) {
        console.error(err);
        toastMsg('Safariで音声再生を開始できませんでした。もう一度タップしてください。', 3500, true);
      }
    }
  });

  // ============================================================
  // Export
  // ============================================================
  let pendingExportFile = null;
  let pendingExportAction = null;

  function setExportAction(btn, action) {
    pendingExportAction = action;
    btn.dataset.exportAction = action;
    const isShare = action === 'share';
    btn.innerHTML = isShare ? '↗<span class="toolLabel">共有</span>' : '⬇<span class="toolLabel">保存WAV</span>';
    btn.title = isShare ? 'タップして共有シートを開く' : 'タップしてWAVを端末に保存';
    btn.setAttribute('aria-label', isShare ? 'WAVを共有' : 'WAVを端末に保存');
  }

  function resetExportAction(btn) {
    pendingExportFile = null;
    pendingExportAction = null;
    delete btn.dataset.exportAction;
    btn.innerHTML = '⬇<span class="toolLabel">書き出し</span>';
    btn.title = '24-bit WAVで書き出し';
    btn.removeAttribute('aria-label');
  }

  function exportFilename(baseName) {
    const safeBase = String(baseName || 'audio')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '').slice(0, 120) || 'audio';
    return `${safeBase}_edited.wav`;
  }

  function downloadBlob(blob, outName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  $('exportBtn').addEventListener('click', async () => {
    const btn = $('exportBtn');
    if (pendingExportFile) {
      try {
        if (pendingExportAction === 'share') {
          try {
            const result = navigator.share({ files: [pendingExportFile], title: pendingExportFile.name });
            if (!result || typeof result.then !== 'function') throw new Error('Web Share did not start');
            // Keep the toolbar available while iOS presents the share sheet.
            // If the user dismisses it with a transient share error, they can
            // immediately use the offered Save action without an extra wait.
            btn.disabled = false;
            await result;
            resetExportAction(btn);
            toastMsg('共有を終了しました');
          } catch (shareErr) {
            if (shareErr && shareErr.name === 'AbortError') {
              resetExportAction(btn);
              toastMsg('共有をキャンセルしました');
            } else {
              console.warn('Native share could not start; offering a fresh-gesture download', shareErr);
              setExportAction(btn, 'download');
              toastMsg('共有を開始できませんでした。もう一度タップして端末に保存してください。', 5000, true);
            }
          }
        } else {
          btn.disabled = true;
          downloadBlob(pendingExportFile, pendingExportFile.name);
          resetExportAction(btn);
          toastMsg('書き出しました');
        }
      } catch (err) {
        console.error(err);
        toastMsg('書き出しに失敗しました', 3500, true);
      } finally {
        btn.disabled = false;
      }
      return;
    }
    btn.disabled = true;
    const previousMarkup = btn.innerHTML;
    const previousTitle = btn.title;
    const previousAriaLabel = btn.getAttribute('aria-label');
    btn.innerHTML = '…<span class="toolLabel">準備中</span>';
    try {
      await flushResynth();
      const exportT0 = performance.now();
      const exportChannels = S.editedChannels || S.origChannels;
      const blob = await PE.encodeWavChunked(exportChannels, S.sr, { framesPerChunk: IS_IOS ? 16384 : 32768 });
      console.info(`[PitchEditor] WAV encode ${(performance.now() - exportT0).toFixed(0)} ms, ${(blob.size / 1048576).toFixed(1)} MB`);
      const outName = exportFilename(S.fileBaseName);
      const outFile = new File([blob], outName, { type: 'audio/wav' });
      const canShareFile = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [outFile] }));

      // Encoding may outlast Safari's transient activation. Ask for a fresh
      // tap after encoding so both the share sheet and download start reliably.
      if (IS_IOS || IS_ANDROID) {
        pendingExportFile = outFile;
        setExportAction(btn, canShareFile ? 'share' : 'download');
        toastMsg('WAVの準備ができました。下のボタンをもう一度タップしてください。', 5000);
        return;
      }

      // iPhone Safari handles a real File through the native share sheet more reliably
      // than a synthetic <a download> in some versions.
      if (canShareFile) {
        try {
          await navigator.share({ files: [outFile], title: outName });
          toastMsg('書き出しました');
        } catch (shareErr) {
          if (shareErr && shareErr.name === 'AbortError') {
            toastMsg('共有をキャンセルしました');
          } else {
            // Long resynthesis/encoding can outlive Safari's transient user
            // activation and make Web Share reject even though canShare()
            // succeeded. The already-created WAV is still valid, so fall
            // back to a normal download instead of losing the export.
            console.warn('Native share unavailable after export; falling back to download', shareErr);
            downloadBlob(blob, outName);
            toastMsg('書き出しました');
          }
        }
      } else {
        downloadBlob(blob, outName);
        toastMsg('書き出しました');
      }
    } catch (err) {
      console.error(err);
      toastMsg('書き出しに失敗しました', 3500, true);
    } finally {
      btn.disabled = false;
      if (!pendingExportFile) {
        btn.innerHTML = previousMarkup;
        btn.title = previousTitle;
        if (previousAriaLabel === null) btn.removeAttribute('aria-label');
        else btn.setAttribute('aria-label', previousAriaLabel);
      }
    }
  });
  // Ensures S.editedChannels is fully caught up with every edit made so
  // far before export reads it -- fires whatever's pending immediately
  // (skipping the debounce) and then polls briefly in case a resynth was
  // already in flight (runPendingResynth only queues a follow-up in that
  // case rather than awaiting it, so a plain single call isn't enough of
  // a guarantee here).
  async function flushResynth() {
    clearTimeout(S.resynthTimer);
    await runPendingResynth();
    while (S.resynthBusy || S.pendingFullResynth || S.pendingResynthSet.size > 0 || S.resynthQueued) {
      await new Promise((r) => setTimeout(r, 30));
    }
    if (S.audioRevision < S.editRevision) {
      // If a Safari Worker died during a render, force one reliable local/full retry.
      S.pendingFullResynth = true;
      const savedWorker = worker;
      if (IS_IOS) worker = null;
      try {
        await runPendingResynth();
      } finally {
        if (!worker && savedWorker && !IS_IOS) worker = savedWorker;
      }
    }
  }

})();
