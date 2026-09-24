# Vocal Pitch Editor

## v50 mobile toolbar scroll cues

Show a directional edge cue while the compact toolbar has more tools off-screen, and update it as users scroll toward either end. Mobile E2E verifies both directions at a 320px viewport so the one-row toolbar remains discoverable without shrinking touch targets.

## v49 accurate no-Xing MP3 VBR preflight

Correct MPEG Layer bitrate tables and sample equal start, middle and end windows so Xing-less MP3 VBR duration estimates do not miss a high-bitrate section near the end. Synthetic VBR regression fixtures confirm oversized vocals and references are rejected before decode, while short real MP3, M4A and AAC still load on a compact iPhone-sized viewport.

## v48 compressed input-buffer peak

The iPhone compressed-audio preflight includes the source file's temporary ArrayBuffer in the peak working-set estimate while `decodeAudioData` allocates decoded PCM. Compact E2E covers a near-limit M4A where decoded audio alone fits but the compressed input buffer would exceed the cap.

## v47 compressed-audio memory preflight

Before decoding on iPhone, estimate the expanded working set of MP3 (Xing/frame sampling), M4A (movie header at the beginning or end), and AAC/ADTS (sampled frames). Oversized vocal files are rejected before `decodeAudioData`; an oversized reference file is rejected while preserving the loaded vocal. Compact iPhone E2E covers long synthetic headers for all three formats and verifies short real MP3/M4A/AAC still load. The Service Worker cache is v47.

## v46 horizontal pan cancellation verification

Horizontal swipes that begin on a note retain both the finger-anchored pan origin and original viewport. Cancelling the gesture restores the original view; compact iPhone E2E checks visibility, page-hide rollback and orientation recovery.

## v45 cancelled horizontal pan recovery

Cancelling a horizontal swipe that begins on a note restores the original viewport when iOS interrupts the gesture during rotation, backgrounding or page teardown. Compact mobile E2E covers all three interruption paths.

## v44 reduced motion

When iOS or the browser requests reduced motion, the loading spinner becomes static and the pitch inspector skips its entrance transition. The 320×568 mobile E2E verifies both styles under the reduced-motion preference. The Service Worker cache is v44.

## v43 VoiceOver note-navigation focus

The previous/next note controls remain keyboard-focusable at the first and last notes while exposing the unavailable direction with `aria-disabled`. This prevents iOS VoiceOver focus from disappearing when a boundary note is selected. Closing the pitch inspector now clears its visible and accessibility state consistently. Mobile E2E covers one-note boundaries, forward/backward navigation through three notes, compact-screen separation, and inspector dismissal. The QA workflow runs this browser suite at 320×568 on every push and pull request. The Service Worker cache is v43.

## v42 reference correction feedback

Bulk correction is disabled when the reference has no matching notes or when every detected note already matches the current pitch. The analysis message reports the number of actionable corrections or explains why none can be applied. Mobile browser E2E checks the identical-reference no-op case. The Service Worker cache is v42.

## v41 mobile assistive-controls layout

When keyboard or VoiceOver note-navigation controls receive focus, the mobile note inspector reserves space for the fixed navigation bar so pitch controls remain reachable. The Service Worker cache is v41.

## v40 accessible note position

VoiceOver and keyboard note navigation announce the selected note's position in the analyzed sequence. The Service Worker cache is v40 so installed browsers refresh the updated app shell and audio editor code.

## v39 audio-session recovery

When an imported track is replaced, audio metadata including the filename and iPhone low-memory analysis indicator is cleared with the released buffers. A failed oversized replacement now returns to a clean, accessible picker without stale track details or an unnecessary decode. Mobile E2E also moves playback into the background, checks the safe stopped state, restores the AudioContext, and starts playback again. Touch devices use the mobile editing panel in landscape even when the CSS viewport is wider than 700px; the panel stays within the actual viewport height. The Service Worker cache is v39.

## v38 landscape editing

On mobile, the pitch inspector is constrained to the available screen height and scrolls internally when the device rotates to landscape. The rotation E2E test now changes the viewport from portrait to landscape, waits for the pitch canvas to resize at device pixel ratio, scrolls to a correction target, and applies an edit before restoring portrait. The Service Worker cache is v38.

## v37 iPhone touch targets

Pitch correction and inspector controls now provide at least 44×44 CSS-pixel touch targets on mobile, including the six fine-adjustment buttons, strength presets, slider, and close control. The six-button row tightens its gaps to remain fully tappable at 320px width. Mobile browser tests measure the actual rendered target sizes and verify the inspector remains within the screen. The Service Worker cache is v37.

## v36 accessible first-run flow

Before a vocal track is loaded, VoiceOver and keyboard navigation now focus the audio picker instead of stepping through unavailable editing tools. The picker has a clear accessible name, remains available after import errors, and editor controls return to the normal focus order once analysis succeeds. Mobile browser checks cover the initial and loaded states. The Service Worker cache is v36.

## v35 iPhone export reliability

On iPhone and Android, WAV encoding completes first and the export button then offers a clearly labeled second tap to open the native share sheet or save the file. This fresh user gesture avoids losing browser activation during long encoding; a failed share keeps the WAV ready and switches the next tap to download. Export filenames are sanitized for device filesystems, the button remains usable while the share sheet is open, and its toolbar label stays intact after each export. Browser E2E covers edited/undone WAV output, native-share success and cancellation, and share failure followed by save. The Service Worker cache is v35.

## v33 iPhone accessibility and PWA support

PCM/float WAV files, including standard WAVE_FORMAT_EXTENSIBLE PCM/float subformats, are inspected from their RIFF header before full-file decoding. On iPhone, vocal and reference imports are checked against the combined estimated working set before calling `decodeAudioData`; rejected references leave the current vocal session intact. Compressed or unknown WAV subformats continue through Web Audio decoding and are checked against the actual decoded buffer. VoiceOver users can select adjacent detected notes with accessible previous/next controls; keyboard focus reveals those controls visually, the pitch canvas is linked to live pitch details, and recoverable failures use assertive announcements. Browser page zoom remains available, and the PWA shell, standalone manifest, matching launch colors, and iOS home-screen icon are covered by browser checks. Service Worker updates revalidate shell assets to avoid stale HTTP cache entries. The cache is v39.

`BROWSER=mobile-mini` exercises a 320×568 touch viewport, verifies oversized vocal and combined vocal/reference WAV preflights make zero decode calls, then loads, edits, plays, and exports a normal WAV.

`BROWSER=mobile-aac` uses FFmpeg to create a standalone AAC/ADTS source and verifies import, analysis, reference playback, pitch editing, and WAV export in an iPhone-UA Chromium session. `BROWSER=mobile-m4a` separately covers AAC in the M4A container; both require FFmpeg and are automated browser checks, not a substitute for iPhone Safari testing.

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
`npm run qa` validates JS syntax plus deterministic F0/noise/dry-path regression tests. GitHub Actions additionally runs the 320×568 iPhone E2E, long-track memory mode and audio-session replacement checks, WebKit mobile coverage, FFmpeg-generated MP3/M4A/AAC imports, the iPhone share/download handoff and HTTPS offline-PWA reload on pushes and pull requests.

## v20: 回帰テスト基盤

`npm run qa` で構文、既存F0テスト、編集ピッチ・通常/分割レンダー一致、24-bit stereo WAVヘッダー、Worker解析メッセージを検査。GitHub Actionsでもpush/PRごとに実行する。DSPとUIの本体はv19から変更していない。`requestAnimationFrame` はNodeテスト環境でのみ模擬。実ブラウザ・iPhone Safariでの音質・操作テストは別途必要。

## v21 browser E2E
`npm run test:browser` starts a local HTTP server, uses Playwright with Chromium, uploads a generated 220 Hz WAV, waits for Worker analysis, downloads the 24-bit WAV, and validates sample rate, channel count and duration. Requires Python Playwright and Chromium. Not part of CI until runner setup is validated.

Windows + Playwright Chromiumで `npm run test:browser` 相当のE2Eを実行し、アップロード → Worker解析 → 24-bit WAV書き出しまでPASSを確認済み。Web Audioは入力ファイルのサンプルレートではなくAudioContextのネイティブレートへデコードするため、E2Eは出力レートそのものではなく、対応範囲・チャンネル数・24-bit深度・時間長を検証する。実ボーカルの聴感、編集ジェスチャ、iPhone Safari実機は別途最終確認が必要。

`BROWSER=mobile` を指定すると、390×844・DPR 3・タッチ有効・iPhone User-AgentのChromiumで、横はみ出し、音源読込、ノート選択、±10¢補正とUndo、ノート分割とUndo、二本指ピンチ、再生、WAV書き出しを検証できる。`BROWSER=mobile-long` は75.2秒音源でiPhone向けダウンサンプル解析を含めて検証する。Windows PowerShellでは `$env:BROWSER='mobile'; python tests/browser_e2e.py` または `$env:BROWSER='mobile-long'; python tests/browser_e2e.py` を実行する。これはiPhone実機Safariの代替ではない。

`BROWSER=mobile-se` は375×667・DPR 2のコンパクト画面でタッチ編集、斜めの二本指ズーム時に誤ったノート編集が起きないこと、お手本音源解析・再生を検証する。iPhoneではボーカルとお手本を合わせたメモリ見積りが上限に近い場合に参照音源を拒否し、理由を表示する。`BROWSER=pwa-offline` は一時的な自己署名HTTPSサーバーでService Workerを登録し、オフライン再読込後の音源解析・再生・書き出しまで検証する。HTTPS試験にはPythonの`cryptography`パッケージが必要。どちらもChromiumによる自動テストで、iPhone実機Safariの最終確認は別途必要。

`BROWSER=mobile-cycle` は参照音源の再生中にメイン音源を差し替え、旧参照・Undo履歴が解除され、新しい音程だけを書き出すことを検証する。

`BROWSER=webkit` はPlaywright WebKitの390×844 iPhoneユーザーエージェントでレイアウトを検証し、Web Audio APIが使える環境では読込・編集・再生・WAV保存フォールバックも実行する。OS共有シート自体は自動化せず、保存経路を確認する。Windows配布WebKitにWeb Audio APIがない環境ではシェル確認のみの部分PASSになる。いずれも実機iPhone Safariの代替ではない。

`BROWSER=mobile-mp3` と `BROWSER=mobile-m4a` は、iPhone User-AgentのChromiumでFFmpeg生成のMP3/AAC音源をデコードし、解析・タッチ編集・Undo・WAV書き出しまで検証する。これらの追加カバレッジだけFFmpegが必要。

## v22 iPhone/PWA reliability

GitHub Pages向けの実ファイル配置を `src/` / `tests/` に統一。iPhoneの未読込キャンバスタップも共通のファイル選択経路を使う。Service Workerはv22キャッシュへ更新し、インストール後に即時activateできるようにして、ホーム画面PWAが旧v19 JavaScriptを保持し続ける問題を防ぐ。

## Architecture references

GitHub OSSの比較、採用した技術構成、ライセンス・安全性・更新状況の確認結果は [`docs/OSS-RESEARCH.md`](docs/OSS-RESEARCH.md) を参照。
