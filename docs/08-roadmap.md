# 08. 実装ロードマップ

「ループが 1 周回ること」を最速で達成し、Kaizen Loop 自身を最初のターゲットプロジェクトにしてドッグフーディングしながら肉付けする。

## Phase 1 — MVP: ループを 1 周回す

**ゴール**: `kaizen init` → Issue 登録 → `kaizen run`(手動)→ PR ができる、までが通る。

| # | 項目 | 内容 |
|---|---|---|
| 1-1 | プロジェクト基盤 | TypeScript / CLI 骨格 / 設定スキーマ(`config.yml` のパースと検証) |
| 1-2 | `kaizen init`(最小) | 前提検査、config 生成、ラベル作成、専用クローン作成、registry 登録(スケジューラ登録なし) |
| 1-3 | GitHub クライアント | gh ラッパー: issue list / comment / label / pr create |
| 1-4 | ワークスペースマネージャ | clone / sync(reset --hard + clean)/ ブランチ作成 |
| 1-5 | ClaudeCodeAdapter | headless 実行、プロンプト契約、出力パース、タイムアウト |
| 1-6 | オーケストレータ(縮小版) | Issue 選択 → 修正 → 検証(リトライなし)→ **PR のみ**(`pr-only` 固定)→ 結果コメント |
| 1-7 | `kaizen run --dry-run` / `--issue` | デバッグ経路 |
| 1-8 | ロック・タイムアウト | run.lock、Issue/全体タイムアウト(安全装置は MVP から入れる) |

**Phase 1 完了の検証**: kaizen-loop リポジトリ自身に `kaizen init` し、実際の Issue を 1 件夜間修正させて PR が立つこと。

## Phase 2 — 自動化と両エージェント対応

**ゴール**: 無人で毎晩回り、ready-for-review PR を作成する。直接コミットは明示 opt-in の反映モードとして残す。Claude/Codex を切り替えられる。

| # | 項目 | 内容 |
|---|---|---|
| 2-1 | スケジューラ | `scheduler.jobs` からの launchd plist 生成 / crontab 管理、`scheduler sync` / `scheduler disable`、互換用 `enable` / `disable`、`--scheduled --job` モード |
| 2-2 | PR-first 反映 | ready-for-review PR 作成を既定にする。明示 opt-in 用にリスク判定(`decideReflection` 純関数 + 全パターンのユニットテスト)と直接コミット経路(rebase + 再検証 + PR フォールバック)を持つ |
| 2-3 | 検証リトライ | エラーフィードバック付き再修正(`maxVerifyRetries`) |
| 2-4 | CodexAdapter | codex exec 対応、フォールバックロジック |
| 2-5 | 試行回数管理 | 結果コメントの機械可読マーカー、`maxAttemptsPerIssue`、`kaizen:needs-human` エスカレーション |
| 2-6 | `kaizen report` | 人間・AI 共用の Issue 登録、`--json` |
| 2-7 | `kaizen status` / `logs` / `doctor` / `list` | 朝の確認ルーティンと運用コマンド一式 |
| 2-8 | ベースライン検証 | 修正前 verify による「もともと壊れている」検知(→ [07-safety.md](./07-safety.md) §3) |
| 2-9 | 遅延実行ガード | `latestStartHour`(→ [07-safety.md](./07-safety.md) §6) |
| 2-10 | `kaizen fix <Issue番号>` | 既存 Issue の即時処理。確認プロンプト・ロック共存(→ [09-instant-run.md](./09-instant-run.md)) |

**Phase 2 完了の検証**: 1 週間、人手の介在なしに毎晩実行され、標準設定では ready-for-review PR が作成されること。直接コミット opt-in リポジトリでは方針どおりに PR / 直接コミットが振り分けられること。

## Phase 3 — 運用品質・計測

**ゴール**: ループの品質をデータで改善できる。

| # | 項目 | 内容 |
|---|---|---|
| 3-1 | メトリクス | `kaizen status --metrics`(成功率・リードタイム・エージェント別比較) |
| 3-2 | revert 検知 | 明示 opt-in 直接コミットがその後 revert されたかを追跡(自動修正の品質指標) |
| 3-3 | プロンプトカスタマイズ | `.kaizen/prompts/fix.md` によるテンプレート上書き |
| 3-4 | テンプレート登録の自動ラベル | Web UI 登録時の優先度ラベル自動付与(GitHub Actions、任意導入) |
| 3-5 | ナイトリーサマリ Issue(任意) | 1 晩 1 コメントの集約レポートを GitHub 上にも残すオプション |
| 3-6 | 複数プロジェクト運用の改善 | 起動時刻の自動分散、`kaizen list` の充実 |
| 3-7 | 即時実行の拡充 | `report --now`、`kaizen improve`、`instant.unattendedMode`、`--json` 結果出力 |

## Phase 4 — 拡張(必要になったら)

- `kaizen watch`(`kaizen:now` ラベル駆動の常駐即時実行。→ [09-instant-run.md](./09-instant-run.md) §3.4)
- `kaizen fix "<タイトル>"`(起票 + 即時処理の別名。現行は `kaizen report "<タイトル>" --now` を使う)
- Scheduler provider 同期(Codex Automations、Claude Code routines、launchd、cron、外部ツールを `.kaizen/config.yml` から `plan` / `sync` / `status` する。→ [12-scheduler-providers.md](./12-scheduler-providers.md))
- GitHub Actions ランナー対応(マシン非依存の夜間実行)
- 他ホスティング(GitLab)・他エージェント CLI への対応(アダプタ追加)
- Issue の自動トリアージ(重複検知・優先度提案)
- 「利用ログからの自動 Issue 起票」(ドッグフーディング中のエラーを検知して登録する利用側フック)

## 未決事項(実装前に判断が必要)

| # | 事項 | 現時点の仮置き |
|---|---|---|
| U-1 | Codex CLI の最新フラグ体系(`exec` / sandbox / JSON 出力)の確認 | [06-agents.md](./06-agents.md) §2.2 の想定で設計。実装時に最新ドキュメントへ追従 |
| U-2 | `commands.setup` の自動検出範囲(npm / pnpm / yarn / bun / cargo / pip …) | Phase 1 は npm 系のみ自動検出、他は手動設定 |
| U-3 | ブランチ保護ルールがあるリポジトリでの opt-in 直接コミット | `hybrid` でも push 失敗時は PR フォールバックで自然に吸収。init 時に保護ルールを検出して `pr-only` を提案 |
| U-4 | モノレポ(ワークスペース内サブプロジェクト)対応 | 初期スコープ外。config はリポジトリルート 1 つのみ |
