# PitchEditor — 製品固有AGENTS.md

本書はPitchEditorの恒久的な製品仕様・品質基準・固有禁止事項・QAを定義する。全プロジェクト共通の行動原則は `C:\Users\tsuki\.codex\AGENTS.md` に従う。既存ツールの所在・実動/過去実測・隔離環境は、上位AGENTSの方針に従い、正式な正常基準開発環境マスター `C:\Users\tsuki\Documents\Codex\2026-09-25\NORMAL-BASELINE-ENVIRONMENT-MASTER.md` を参照し、必要な実行経路を使用前に再確認する。現在のGit状態、作業途中、直近の障害、次工程は `HANDOFF.md` に記録する。実装前に必要な範囲で `README.md`、`docs/OSS-RESEARCH.md`、関連ソース/テストを確認する。

## 1. 製品目標・確定範囲

- 既存のブラウザベースPitchEditorを、実用可能な高品質の**ローカル処理型・インストール可能なボーカルピッチ編集PWA**として完成させる。音質、ピッチ解析/編集精度、安定性、操作性、低メモリ動作を重視する。iPhone/Safariを最重要対象としつつAndroid/PCの既存動作も維持する。PC上で動いたことだけでiPhone対応完了とはしない。
- 現在の製品範囲：ボーカル音源の読み込み、検出ノート/波形・ピッチ表示、ノート選択とピッチ/cent/補正強度編集、プレビュー・通常再生・solo audition、Undo、参照音源の解析/DTW位置合わせ・提案と実行可能な一括補正、WAV書き出し、インストール/オフラインPWA、アクセシブルなノート移動。WAV/MP3/M4A/AAC入力は実装済みだが、実際のデコード可否はブラウザ依存。各機能の**現在の実動状態**は変更時に検証し、実装の存在だけで正常動作を断定しない。
- 将来の数値品質目標、性能予算、リリース日、未承認の新機能・クラウド同期・外部AIサービス・新UI/フレームワークは確定仕様とみなさない。Work会話の未参照部分を推測で「承認済み」にしない。

## 2. 現行アーキテクチャと製品固有の禁止事項

- 現行構成：`index.html`（UI）、`src/app.js`（操作/再生/読み込み/メモリ/書き出し）、`src/engine.js`（YIN F0、ノート分割、参照DTW、TD-PSOLA、WAV）、`src/worker.js`（解析/参照/レンダー）、`sw.js`・`manifest.webmanifest`・アイコン（PWA）。Canvas、Web Audio、専用Worker、vanilla JavaScriptを用いる軽量な静的PWA。**現行実装でAudioWorklet/WASMを使用しているとは断定しない**。導入時はiPhone Safari対応と実測を確認する。
- 音源は原則ブラウザ内でローカル処理し、共有/ダウンロードはユーザーの明示操作でのみ開始する。無断アップロードや遠隔音声処理を追加しない。
- 現行のUI・解析・DSPの責務分離、YIN/DTW/TD-PSOLA経路と承認済みUIを、比較・根拠・必要な承認なしに置換/大幅再設計しない。特定ライブラリを永久固定する趣旨ではない。OSSの構造は参考にできるが、ライセンス/セキュリティ審査なしにAGPLのOpenVox/openDAWソースを移植しない。大規模フレームワークやニューラルモデルの採用は別途設計判断と承認を要する。詳細は `docs/OSS-RESEARCH.md`。
- 現在正常な読み込み、表示、note編集、通常/参照再生、solo audition、DSP、export、アクセシビリティ、mobile/PWAを保護する。無関係な機能を変更せず、変更がこれらに波及する場合は回帰確認する。

## 3. 音質・DSPの変更基準

- 速度・実装容易性のみを理由に音質を下げない。現行DSPの置換・解析/補正方式変更時は、可能な限り同じ実音声と条件で変更前後の出力を比較する。変更目的に応じてピッチ精度、formant、artifact、timing、音色、CPU、peak memory、iPhone実行性、安定性を測定/聴取し、確認できない項目を明記する。
- 原音レートのチャンネルデータは試聴/書き出し用に保護し、解析用縮小信号は用途終了後に解放する。iPhone向けの分割・メモリ優先レンダー、長時間音源とボーカル/参照の合算メモリ見積り、圧縮音源のdecode前preflightを維持する。不要な全尺コピーや無制限decodeを避ける。
- WAV exportのコンテナ/ビット深度/チャンネル/長さ、通常レンダーと分割レンダーの整合、Undo後出力、聴感とアーティファクトを変更影響に応じて検証する。

## 4. iPhone/Safari・UI/UX固有品質

- Safariのファイル選択（Files、WAV/MP3/M4A/AAC）、Web Audioのunlock・AudioContext停止/復帰、Worker、必要に応じたAudioWorklet/WASM互換性、PWAのインストール/オフライン再起動、Service Worker更新を考慮する。iPhoneでのメモリ上限・長時間音源・画面回転・viewport/safe area・タッチ中断・背景化/復帰を重点対象とする。
- 既存のタップ領域、スクロール/ピンチ/パン、ノート選択・cent調整、再生、コンパクト画面のツールバー/インスペクタ、VoiceOver/キーボード移動、reduced motionを保護する。回転やタッチキャンセル時に誤編集やビュー状態の破損を生じさせない。
- **solo audition**：背景化で既存ソロ再生を停止し、非同期buffer生成/unlock後の古いプレビューが遅れて再生を開始しないことを確認する。通常再生・参照再生の停止/復帰を壊さない。現在の修正の実機有効性は `HANDOFF.md` で別管理する。
- **mobile export**：WAVエンコード完了後、新たなユーザー操作でネイティブ共有/保存を開始する二段階フローを保護する。共有キャンセル/失敗時はWAVを保持し、ダウンロード等へ安全にフォールバックする。非同期エンコード後の古いユーザーactivationに依存しない。

## 5. PitchEditor専用QA

- 変更後は影響範囲に応じて `npm run qa`（構文、F0/エンジン、回帰）を実行する。必要なら `npm run check`、`npm run test:engine`、`npm run test:regression` を個別実行。PowerShellで`npm.ps1`が制限される場合は既存の`npm.cmd`を使い、システムポリシーは変更しない。
- ブラウザ/PWAに影響する場合は、現在の権限で実行可能なPlaywrightまたは同等のブラウザ経路を選ぶ。既存 `tests/browser_e2e.py` の `BROWSER` モード（chromium、mobile、mobile-se、mobile-mini、mobile-long、mobile-cycle、mobile-mp3/m4a/aac、mobile-share-success/cancel/fallback、webkit、pwa-offline）から影響範囲を選ぶ。必要な依存が無ければ無断導入しない。HTTP(S)、Service Worker更新/オフライン再起動、Worker解析、note操作/Undo、再生/solo、背景化、音声出力、exportを関連する変更ごとに確認する。
- DSP変更では合成テストだけでなく実音声を使ったピッチ、formant、artifact、タイミング、聴感、WAV出力の比較を可能な範囲で行う。長時間音源・圧縮形式・ボーカル/参照合算peak memoryとiPhone向け分割処理を必要に応じて確認する。
- iPhone実機が利用できない場合もPC静的QA、回帰、実ブラウザ、モバイル模擬、音声解析、メモリ/性能調査を継続する。**PC側確認済み／ブラウザ確認済み／モバイルエミュレーション確認済み／iPhone Safari実機確認済み・未確認**を必ず区別する。Playwright WebKitやiPhone UA Chromiumを物理Safariの証拠としない。
- 実機が利用可能になったら `README.md` のdevice matrixに従い、Safariとホーム画面PWAでFilesからWAV/M4A読込、解析・編集・Undo、VoiceOver/キーボード、通常/参照/solo再生、背景化/復帰、ドラッグ中の回転、共有・Save to Files、オフライン再起動を検証し、機種/iOS版/音源形式・長さ/結果を記録する。

## 6. 状態管理

`HANDOFF.md` は現在状態・履歴・未解決事項・次工程の記録とし、branch/HEAD/origin・未コミットファイル・直近のWinError・検証成否・中断点をここに固定しない。`README.md` はユーザー向け機能・device matrix、`docs/OSS-RESEARCH.md` はOSS比較・設計判断、各ソース/テストは実装の根拠とする。資料間の記述が食い違えば現在の実装とテストを確認し、推測で確定仕様を削除しない。