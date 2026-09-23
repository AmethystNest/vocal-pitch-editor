# Vocal Pitch Editor v22

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

Windows + Playwright Chromiumで `npm run test:browser` 相当のE2Eを実行し、アップロード → Worker解析 → 24-bit WAV書き出しまでPASSを確認済み。Web Audioは入力ファイルのサンプルレートではなくAudioContextのネイティブレートへデコードするため、E2Eは出力レートそのものではなく、対応範囲・チャンネル数・24-bit深度・時間長を検証する。実ボーカルの聴感、編集ジェスチャ、iPhone Safari実機は別途最終確認が必要。

`BROWSER=mobile` を指定すると、390×844・DPR 3・タッチ有効・iPhone User-AgentのChromiumで、横はみ出し、音源読込、再生タップ、WAV書き出しとiOS専用コード経路を検証できる。Windows PowerShellでは `$env:BROWSER='mobile'; python tests/browser_e2e.py` を実行する。これはiPhone実機Safariの代替ではない。

## v22 iPhone/PWA reliability

GitHub Pages向けの実ファイル配置を `src/` / `tests/` に統一。iPhoneの未読込キャンバスタップも共通のファイル選択経路を使う。Service Workerはv22キャッシュへ更新し、インストール後に即時activateできるようにして、ホーム画面PWAが旧v19 JavaScriptを保持し続ける問題を防ぐ。
