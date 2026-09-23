# OSS reference review for PitchEditor

Reviewed 2026-09-24. This is an architecture and product comparison, not a security audit of the referenced projects.

## Selection

**Primary product reference: [alexcrist/autotone](https://github.com/alexcrist/autotone).** It is the closest match to PitchEditor's core problem: detect a vocal's pitch and correct it in a browser. It is a useful reference for the analysis → correction pipeline and keeping expensive signal work away from the UI thread. It is not a suitable implementation to copy wholesale: its own README describes file upload and stereo as future work, while PitchEditor must edit imported audio, retain stereo, support manual note-level correction, and work within iPhone memory limits.

Use [VadymYem/OpenVox](https://github.com/vadymyem/OpenVox) as a secondary reference for a documented local-first browser audio architecture, mobile/PWA scope, compatibility fallbacks, and validation discipline. It is a broad vocal-training and music studio rather than a focused offline vocal-tuning editor. Its README also explicitly separates optional analytics and browser speech recognition from the local audio path.

[andremichelle/openDAW](https://github.com/andremichelle/openDAW) is a useful boundary comparison for professional browser audio editing and extensible DSP, but its full DAW scope and licensing make it a poor implementation base for this small, installable editor.

## Comparison

| Project | Problem and users | Technology and safety observations | License and update state (review date) |
|---|---|---|---|
| [Autotone](https://github.com/alexcrist/autotone) | Browser pitch correction for singers or single-note instruments; its README frames the goal as fixing occasional off-pitch notes. README lists audio upload, stereo and separate reference audio as future work. | TensorFlow.js CREPE detection, an Emscripten/WebAssembly C pitch shifter, Web Audio, Web Workers, React and Webpack. Browser DSP and workers are useful patterns. GitHub shows MIT and no published advisories, but also no `SECURITY.md`; absence of advisories is not evidence of a security review. | MIT. Latest visible default-branch commit is 2023-01-26; the project should be treated as inactive for dependency and browser-compatibility assumptions. |
| [OpenVox Studio](https://github.com/vadymyem/OpenVox) | Broad voice practice, training, transcription and studio workflows for singers, teachers, choirs and musicians. | React/TypeScript/Vite; Web Audio with AudioWorklet and fallbacks; WASM pitch core with TypeScript fallback; IndexedDB and PWA. README documents a local audio path, while optional speech recognition and analytics can contact external services. It documents a security policy, SBOM, CodeQL, dependency review and dependency auditing; these are stronger visible process signals, not a guarantee of absence of vulnerabilities. | AGPL-3.0. Active in July 2026, but the repository describes itself as alpha; do not transplant its source into PitchEditor without accepting the license obligations. |
| [openDAW](https://github.com/andremichelle/openDAW) | General browser-based DAW and music production, for musicians and audio creators; includes a real-time monophonic autotune plugin among many devices. | Broad Web Audio application with plugins, WASM/Rust build components, FFmpeg and a larger development toolchain. Useful for separating audio devices and editor concerns, but much broader and heavier than PitchEditor. | AGPL-3.0-or-later or commercial license. Default branch had commits through 2026-08-29; active, but the source license is incompatible with casual code reuse in a differently licensed app. |

## Reuse and avoid

Reuse these design ideas at the architecture level:

- Keep pitch analysis and expensive DSP off the rendering path where memory permits; communicate through a small worker message protocol.
- Make the privacy boundary explicit: process imported audio locally and only create a share/download when the user asks.
- Keep the pitch engine independent of UI state so DSP behavior can be tested with deterministic fixtures.
- Use capability fallbacks and explicit limits for memory-constrained devices rather than silently exhausting mobile memory.

Avoid:

- Adding a large neural model/runtime only because Autotone uses CREPE. The model transfer and working set conflict with the iPhone memory budget, and PitchEditor already has a YIN/segmentation pipeline with regression coverage.
- Importing a full DAW framework or feature set for a focused note-correction workflow.
- Copying AGPL OpenVox/openDAW code into this repository without an intentional license change. Autotone's MIT license is permissive, but code reuse would still need its notices and a compatibility review of its bundled submodule and WASM components.
- Treating “no published advisories” or “local-first” claims as a security certification. Review runtime network calls, dependencies and user-visible privacy statements independently.

## PitchEditor technical decision and system shape

Keep the current static PWA stack: vanilla JavaScript, Web Audio API, Canvas, a dedicated Worker, and no runtime framework or remote audio service. Keep the current YIN pitch analysis, note segmentation, DTW reference alignment and TD-PSOLA correction engine rather than introducing Autotone's TensorFlow.js/CREPE and compiled shifter. The current split is:

```text
User-selected audio
  → Web Audio decode and iPhone memory guard
  → mono analysis copy (downsampled for long iPhone files)
  → Worker: pitch track and note segmentation
  → Canvas note editor and correction state
  → Worker or iPhone chunked rendering: TD-PSOLA
  → explicit WAV export / native share or download
```

Original-rate channel data stays available for listening and export; the reduced analysis signal can be released after pitch extraction. On iPhone the renderer uses chunked, memory-first processing. This keeps the useful pipeline separation from Autotone and the local/PWA discipline visible in OpenVox while keeping the implementation matched to PitchEditor's offline-file-editing and mobile-memory constraints.

The source review does not prove real iPhone Safari behavior. The iPhone-sized Chromium E2E is a useful device-layout and iOS-branch simulation; physical Safari testing remains a separate release check.

## Sources

- Autotone README, MIT license, commit history and security page: [README](https://github.com/alexcrist/autotone), [license](https://github.com/alexcrist/autotone/blob/main/LICENSE.txt), [commits](https://github.com/alexcrist/autotone/commits/main/), [security](https://github.com/alexcrist/autotone/security).
- OpenVox README, license, security/validation information and commit history: [README](https://github.com/vadymyem/OpenVox), [commits](https://github.com/vadymyem/OpenVox/commits/main/).
- openDAW README, licensing and commit history: [README](https://github.com/andremichelle/openDAW), [license terms](https://github.com/andremichelle/openDAW#dual-licensing-model), [commits](https://github.com/andremichelle/openDAW/commits/main/).
