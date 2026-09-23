# Vocal Pitch Editor v18

Development source is modularized without changing the confirmed UI or DSP behavior.

- `src/engine.js`: F0, note analysis, DTW/reference logic, TD-PSOLA, WAV
- `src/worker.js`: analysis/resynthesis/reference worker protocol
- `src/app.js`: UI, editing state, playback/render/export orchestration
- `index.html`: markup/styles and module entry loading

Run `npm run check` for syntax checks. Serve over HTTP(S) for Worker/PWA testing.

## QA
`npm run qa` validates JS syntax plus deterministic F0/noise/dry-path regression tests.

## v20: 回帰テスト基盤

`npm run qa` で構文、既存F0テスト、編集ピッチ・通常/分割レンダー一致、24-bit stereo WAVヘッダー、Worker解析メッセージを検査。GitHub Actionsでもpush/PRごとに実行する。DSPとUIの本体はv19から変更していない。`requestAnimationFrame` はNodeテスト環境でのみ模擬。実ブラウザ・iPhone Safariでの音質・操作テストは別途必要。

## v21 browser E2E
`npm run test:browser` starts a local HTTP server, uses Playwright with Chromium, uploads a generated 220 Hz WAV, waits for Worker analysis, downloads the 24-bit WAV, and validates sample rate, channel count and duration. Requires Python Playwright and Chromium. Not part of CI until runner setup is validated.

This execution environment blocked Chromium's navigation to 127.0.0.1 (`ERR_BLOCKED_BY_ADMINISTRATOR`), so browser E2E is **not verified here**. Do not interpret this as an application test failure or a pass. Real vocal, editing gestures and iPhone Safari still require testing.
