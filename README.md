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

`BROWSER=mobile` を指定すると、390×844・DPR 3・タッチ有効・iPhone User-AgentのChromiumで、横はみ出し、音源読込、ノート選択、±10¢補正とUndo、ノート分割とUndo、二本指ピンチ、再生、WAV書き出しを検証できる。`BROWSER=mobile-long` は75.2秒音源でiPhone向けダウンサンプル解析を含めて検証する。Windows PowerShellでは `$env:BROWSER='mobile'; python tests/browser_e2e.py` または `$env:BROWSER='mobile-long'; python tests/browser_e2e.py` を実行する。これはiPhone実機Safariの代替ではない。

`BROWSER=mobile-se` は375×667・DPR 2のコンパクト画面でタッチ編集と二本指ズームを検証する。`BROWSER=pwa-offline` は一時的な自己署名HTTPSサーバーでService Workerを登録し、オフライン再読込後の音源解析・再生・書き出しまで検証する。HTTPS試験にはPythonの`cryptography`パッケージが必要。どちらもChromiumによる自動テストで、iPhone実機Safariの最終確認は別途必要。

## v22 iPhone/PWA reliability

GitHub Pages向けの実ファイル配置を `src/` / `tests/` に統一。iPhoneの未読込キャンバスタップも共通のファイル選択経路を使う。Service Workerはv22キャッシュへ更新し、インストール後に即時activateできるようにして、ホーム画面PWAが旧v19 JavaScriptを保持し続ける問題を防ぐ。

## Architecture references

GitHub OSSの比較、採用した技術構成、ライセンス・安全性・更新状況の確認結果は [`docs/OSS-RESEARCH.md`](docs/OSS-RESEARCH.md) を参照。
