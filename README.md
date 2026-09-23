# Vocal Pitch Editor

## v37 iPhone touch targets

Pitch correction and inspector controls now provide at least 44×44 CSS-pixel touch targets on mobile, including the six fine-adjustment buttons, strength presets, slider, and close control. The six-button row tightens its gaps to remain fully tappable at 320px width. Mobile browser tests measure the actual rendered target sizes and verify the inspector remains within the screen. The Service Worker cache is v37.

## v36 accessible first-run flow

Before a vocal track is loaded, VoiceOver and keyboard navigation now focus the audio picker instead of stepping through unavailable editing tools. The picker has a clear accessible name, remains available after import errors, and editor controls return to the normal focus order once analysis succeeds. Mobile browser checks cover the initial and loaded states. The Service Worker cache is v36.

## v35 iPhone export reliability

On iPhone and Android, WAV encoding completes first and the export button then offers a clearly labeled second tap to open the native share sheet or save the file. This fresh user gesture avoids losing browser activation during long encoding; a failed share keeps the WAV ready and switches the next tap to download. Export filenames are sanitized for device filesystems, the button remains usable while the share sheet is open, and its toolbar label stays intact after each export. Browser E2E covers edited/undone WAV output, native-share success and cancellation, and share failure followed by save. The Service Worker cache is v35.

## v33 iPhone accessibility and PWA support

PCM/float WAV files, including standard WAVE_FORMAT_EXTENSIBLE PCM/float subformats, are inspected from their RIFF header before full-file decoding. On iPhone, vocal and reference imports are checked against the combined estimated working set before calling `decodeAudioData`; rejected references leave the current vocal session intact. Compressed or unknown WAV subformats continue through Web Audio decoding and are checked against the actual decoded buffer. VoiceOver users can select adjacent detected notes with accessible previous/next controls; keyboard focus reveals those controls visually, the pitch canvas is linked to live pitch details, and recoverable failures use assertive announcements. Browser page zoom remains available, and the PWA shell, standalone manifest, matching launch colors, and iOS home-screen icon are covered by browser checks. Service Worker updates revalidate shell assets to avoid stale HTTP cache entries. The cache is v37.

`BROWSER=mobile-mini` exercises a 320×568 touch viewport, verifies oversized vocal and combined vocal/reference WAV preflights make zero decode calls, then loads, edits, plays, and exports a normal WAV.

## v27 mobile accessibility

The pitch roll can receive keyboard focus. Left and right select notes; up and down shift the selected note by one semitone. The selected note's before/after pitch is announced to assistive technology, and active tool states are exposed. On narrow screens, Open, playback, Undo and WAV export stay at the start of the toolbar. The Service Worker cache is v27.

Previous mobile reliability improvements include interrupted-touch rollback and Web Audio unlock before reference playback on iPhone.

Development source is modularized without changing the confirmed UI or DSP behavior.

- `src/engine.js`: F0, note analysis, DTW/reference logic, TD-PSOLA, WAV
- `src/worker.js`: analysis/resynthesis/reference worker protocol
- `src/app.js`: UI, editing state, playback/render/export orchestration
- `index.html`: markup/styles and module entry loading

Run `npm run check` for syntax checks. Serve over HTTP(S) for Worker/PWA testing.

## Device verification

Automated mobile tests emulate iPhone viewport dimensions and touch in Chromium; they do not prove real iOS Safari behavior. Before calling an iPhone release verified, test Safari and the Add to Home Screen app on a physical device: import WAV and M4A from Files, analyze and edit a note, use VoiceOver and a hardware keyboard to navigate/correct/undo, play vocal/reference, background and resume the app during playback, rotate while dragging, export through Share and Save to Files, then relaunch offline. Record the iPhone model, iOS version, source format/duration and result for each path.

## QA
`npm run qa` validates JS syntax plus deterministic F0/noise/dry-path regression tests.

## v20: 回帰テスト基盤

`npm run qa` で構文、既存F0テスト、編集ピッチ・通常/分割レンダー一致、24-bit stereo WAVヘッダー、Worker解析メッセージを検査。GitHub Actionsでもpush/PRごとに実行する。DSPとUIの本体はv19から変更していない。`requestAnimationFrame` はNodeテスト環境でのみ模擬。実ブラウザ・iPhone Safariでの音質・操作テストは別途必要。

## v21 browser E2E
`npm run test:browser` starts a local HTTP server, uses Playwright with Chromium, uploads a generated 220 Hz WAV, waits for Worker analysis, downloads the 24-bit WAV, and validates sample rate, channel count and duration. Requires Python Playwright and Chromium. Not part of CI until runner setup is validated.

Windows + Playwright Chromiumで `npm run test:browser` 相当のE2Eを実行し、アップロード → Worker解析 → 24-bit WAV書き出しまでPASSを確認済み。Web Audioは入力ファイルのサンプルレートではなくAudioContextのネイティブレートへデコードするため、E2Eは出力レートそのものではなく、対応範囲・チャンネル数・24-bit深度・時間長を検証する。実ボーカルの聴感、編集ジェスチャ、iPhone Safari実機は別途最終確認が必要。

`BROWSER=mobile` を指定すると、390×844・DPR 3・タッチ有効・iPhone User-AgentのChromiumで、横はみ出し、音源読込、ノート選択、±10¢補正とUndo、ノート分割とUndo、二本指ピンチ、再生、WAV書き出しを検証できる。`BROWSER=mobile-long` は75.2秒音源でiPhone向けダウンサンプル解析を含めて検証する。Windows PowerShellでは `$env:BROWSER='mobile'; python tests/browser_e2e.py` または `$env:BROWSER='mobile-long'; python tests/browser_e2e.py` を実行する。これはiPhone実機Safariの代替ではない。

`BROWSER=mobile-se` は375×667・DPR 2のコンパクト画面でタッチ編集、斜めの二本指ズーム時に誤ったノート編集が起きないこと、お手本音源解析・再生を検証する。iPhoneではボーカルとお手本を合わせたメモリ見積りが上限に近い場合に参照音源を拒否し、理由を表示する。`BROWSER=pwa-offline` は一時的な自己署名HTTPSサーバーでService Workerを登録し、オフライン再読込後の音源解析・再生・書き出しまで検証する。HTTPS試験にはPythonの`cryptography`パッケージが必要。どちらもChromiumによる自動テストで、iPhone実機Safariの最終確認は別途必要。

`BROWSER=mobile-cycle` は参照音源の再生中にメイン音源を差し替え、旧参照・Undo履歴が解除され、新しい音程だけを書き出すことを検証する。

`BROWSER=webkit` はPlaywright WebKitの390×844モバイルシェルと横はみ出しを検証する。Windows配布のPlaywright WebKitにWeb Audio APIがない環境では、音声処理を実行せず部分PASSとして明示する。この結果はiPhone Safari音声対応の判定には使えない。

`BROWSER=mobile-mp3` と `BROWSER=mobile-m4a` は、iPhone User-AgentのChromiumでFFmpeg生成のMP3/AAC音源をデコードし、解析・タッチ編集・Undo・WAV書き出しまで検証する。これらの追加カバレッジだけFFmpegが必要。

## v22 iPhone/PWA reliability

GitHub Pages向けの実ファイル配置を `src/` / `tests/` に統一。iPhoneの未読込キャンバスタップも共通のファイル選択経路を使う。Service Workerはv22キャッシュへ更新し、インストール後に即時activateできるようにして、ホーム画面PWAが旧v19 JavaScriptを保持し続ける問題を防ぐ。

## Architecture references

GitHub OSSの比較、採用した技術構成、ライセンス・安全性・更新状況の確認結果は [`docs/OSS-RESEARCH.md`](docs/OSS-RESEARCH.md) を参照。
