# 07. 安全性設計

無人・夜間・自動 push という性質上、安全装置は機能と同等以上に重要である。本ドキュメントはガードレール、失敗モード、停止手段を定める。

## 1. 多層ガードレール(まとめ)

| 層 | 装置 | 防ぐもの |
|---|---|---|
| 物理隔離 | 専用クローンでのみ作業(→ [01-architecture.md](./01-architecture.md) §3) | 開発者の作業ツリー・未コミット変更の破壊 |
| 権限 | エージェントに push / gh を許可しない(→ [06-agents.md](./06-agents.md) §2) | エージェント単独でのリモート反映 |
| パス | `protectedPaths`(変更可だが強制 PR)/ `forbiddenPaths`(変更即失敗) | CI・秘密情報・ループ自身の設定の無審査変更 |
| 検証 | テスト・lint 必須。検証なしプロジェクトは直接コミット禁止 | 壊れたコードの main 混入 |
| 量 | `maxChangedLines` / `maxChangedFiles` 超は強制 PR | 大規模変更の無審査反映 |
| 回数 | `maxVerifyRetries` / `maxAttemptsPerIssue` / `maxIssuesPerNight` | 無限リトライ・暴走によるトークン浪費 |
| 時間 | Issue 単位・実行全体のタイムアウト | ハング・長時間占有 |
| 排他 | `run.lock`(PID 検証つき) | 多重実行による競合 |
| 停止 | `kaizen disable` / `PAUSE` ファイル / ラベル操作 | 異常時に止められない事態 |

## 2. キルスイッチ(止め方の階層)

| 手段 | 効果 | 即効性 |
|---|---|---|
| `kaizen disable` | スケジューラ解除 + 実行中プロセスに SIGTERM | 即時 |
| `touch ~/.kaizen/projects/<slug>/PAUSE` | 次回以降の実行をプリフライトで中止(スケジューラ定義は残る)。SSH 越し・スクリプトから止めたいとき用 | 次回実行から |
| Issue から `kaizen` ラベルを外す | その Issue だけ対象外に | 次回実行から |
| `kaizen:needs-human` を付ける | その Issue の自動処理を停止し人間に委ねる | 次回実行から |

### SIGTERM 受信時の挙動(グレースフルシャットダウン)

1. 新しい Issue の処理を開始しない
2. 実行中のエージェントプロセスを SIGTERM → 10 秒後 SIGKILL
3. 処理中だった Issue: ワークスペースを reset、`kaizen:in-progress` を剥がし、「中断された」コメントを残す(可能なら。GitHub 到達不能でも終了は妨げない)
4. `summary.json` に `result: "aborted"` を記録、ロック解放

## 3. 失敗モード分析

| 失敗モード | 検知 | 対処 |
|---|---|---|
| エージェントが誤った修正をして検証も通ってしまう | 検知不能(残存リスク) | 緩和: 量の上限で影響範囲を制限、結果コメントで翌朝に可視化、回帰テスト追加をプロンプトで要求。事後: 人間が revert + `kaizen:pr-only` で再オープン |
| エージェントのハング | タイムアウト | プロセスツリー kill → 失敗処理 |
| エージェントが無関係なファイルを大量変更 | diff 検査(行数・ファイル数・パス) | 強制 PR or 失敗。`forbiddenPaths` は即失敗 |
| テストがもともと壊れている(エージェントのせいでない) | ベースライン検証: **修正前に一度 verify を実行**し、失敗するなら「環境/既存の問題」としてエージェントを起動しない | `in-progress` を剥がし、result marker なしの中断コメントを残して実行全体を中止 |
| flaky テスト | 検証失敗 → リトライで通ることがある | `maxVerifyRetries` の範囲で自然吸収。頻発するならそれ自体を Kaizen Issue にする(ドッグフーディング) |
| 夜間に人間が main へ push | push 前 fetch + rebase + 再検証(→ [04-nightly-pipeline.md](./04-nightly-pipeline.md) §7a) | 競合時は PR フォールバック |
| gh / API 障害・レート制限 | コマンド失敗 | 指数バックオフ ×3 → 実行中止(中途半端に続けない) |
| Mac がスリープしていた | launchd が起床時に実行 | §6 の「遅延実行ガード」で制御 |
| 前回実行のクラッシュ(ロック残留・in-progress 残留) | ロックの PID 生存確認 / in-progress の 24h ルール | stale 回収(自動) |
| ワークスペース破損 | fetch / setup 失敗 | 実行中止 + 通知。現時点の `kaizen doctor --repair` はラベル修復のみで、ワークスペース再クローンは手動対応 |
| 設定ファイルの誤り | 起動時スキーマ検証 | 実行せず終了コード 2 + 通知 |
| ディスク逼迫 | プリフライトで空き容量チェック(< 2GB で中止) | 実行中止 + 通知 |

## 4. 直接コミットの安全条件(再掲・正規化)

main への直接 push が許されるのは、以下が**すべて**真のときのみ:

1. `policy.mode` が `hybrid` または `direct-only`
2. `commands.verify` が定義済みで、全コマンドが成功した
3. 変更が `protectedPaths` / `forbiddenPaths` に触れていない
4. `kaizen:pr-only` ラベルがない
5. (`policy.mode: direct-only`)または(`kaizen:direct` ラベルがある)または(変更量が上限以下)
6. push 直前の rebase 後にも検証が成功した

ひとつでも欠ければ PR(または失敗)。`direct-only` は「直接コミットを優先する」指定であり、検証なし・保護パス変更・`kaizen:pr-only`・禁止パス変更を上書きしない。この条件は実装上 1 つの純関数 `decideReflection(diffStats, labels, config, verifyResult): 'direct' | 'pr'` に集約し、ユニットテストで全パターンを固定する。

## 5. 秘密情報の扱い

- Kaizen Loop はトークン・API キーを保存しない。GitHub 認証は `gh`、AI 実行は `builder-agent` / `verifier` に委譲
- エージェントプロセスへ渡す環境変数は最小限(→ [06-agents.md](./06-agents.md) §2.3)。ターゲットプロジェクトの `.env` は渡さない
- `**/.env*` はデフォルトで `protectedPaths`。ログへの秘密情報混入を避けるため、エージェントログは GitHub へは「要約 + 末尾抜粋」のみ投稿し、全量はローカルにのみ保存

## 6. スリープ復帰時の遅延実行ガード

launchd は取りこぼしたスケジュールを起床時に実行するため、「朝 9 時に Mac を開いた瞬間に夜間メンテが走り出す」ことがある。これは仕様として許容するが、以下で制御する:

- 設定 `run.latestStartHour`(デフォルト: 7)— nightly の scheduled 実行が大幅に遅れて起動した場合(この時刻を過ぎていたら)、実行をスキップして「スキップした」通知のみ出す(日中の開発と夜間メンテの同時進行を防ぐ)。`scheduler.poll` の `watch` trigger には適用しない
- スキップされた Issue は翌晩そのまま対象になる(取りこぼしによるロストはない)

> `latestStartHour` は [03-config-spec.md](./03-config-spec.md) の `run` セクションに含める(デフォルト 7 時)。

## 7. 信頼の段階的引き上げ(運用推奨)

導入直後から全自動 push は推奨しない。推奨ステップ:

1. **週 1〜2 回、`kaizen run --dry-run`** で選択・除外理由だけ確認
2. 既定の **`policy.mode: pr-only`** で数日運用し、PR の品質を観察
3. 品質に納得したら **`hybrid`** に切り替え、`maxChangedLines` を小さめ(例: 50)から始める
4. メトリクス(revert 率)を見ながら上限を緩める

`kaizen init` はデフォルトで `pr-only` を生成する。直接コミットは `hybrid` または `direct-only` への明示変更後にだけ候補になる。
