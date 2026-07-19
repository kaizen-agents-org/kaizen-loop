# 02. CLI コマンド仕様

パッケージ名: `kaizen-loop`。バイナリ名: `kaizen`(`npx kaizen-loop` でも同一エントリ)。

```
kaizen <command> [options]

Commands:
  init        ターゲットプロジェクトに Kaizen Loop を導入する
  run         夜間メンテナンスパイプラインを実行する(スケジューラからも呼ばれる)
  fix         Issue を即時修正する(夜間を待たない。→ 09-instant-run.md)
  report      Kaizen Issue を素早く登録する(人間・AI 共用)
  smoke       sandbox issue-to-PR E2E smoke run を実行し証跡を保存する
  queue       既存 Issue を queued 実行対象にする
  unqueue     既存 Issue を queued 実行対象から外す
  improve     queued/backlog Issue をユーザー操作で即時処理する
  goal        複数 iteration の Goal を作成・実行・評価する
  status      ループの状態・直近の実行結果を表示する
  scheduler   スケジューラ job を管理する
  fleet       repo 群の registry/workspace/label/scheduler を再構築する
  guardian    非同期 PR Guardian job を確認・実行する
  logs        実行ログを表示する
  doctor      環境診断・修復
  list        登録済みプロジェクト一覧
  enable      互換用: scheduler sync と同等
  disable     互換用: scheduler disable と同等
  watch       未実装。Phase 4 予定

Global Options:
  --project <slug>   対象プロジェクト指定(省略時はカレントディレクトリから解決)
  --json             機械可読出力(AI エージェントからの利用を想定)
  -h, --help / -V, --version
```

すべてのコマンドは終了コード `0`(成功)/ `1`(失敗)/ `2`(設定・環境エラー)を返す。

---

## `kaizen init`

カレントディレクトリのリポジトリに Kaizen Loop を導入する。**冪等**(再実行しても安全。既存設定は上書き確認)。

```
kaizen init [--agent claude|codex] [--schedule "02:00"] [--yes]
```

### 処理内容

1. **前提検査**: Git リポジトリであること、GitHub リモート(origin)があること、`gh auth status` が通ること。失敗時は是正方法を表示して終了コード 2
2. **対話セットアップ**(`--yes` で全デフォルト採用):
   - builder-agent へ渡す希望バックエンド(生成時のデフォルト: claude)。このリポジトリのコミット済み `.kaizen/config.yml` は `agent.default: codex` を設定するため、通常の Issue 処理は Codex を希望バックエンドとして渡す
   - 起動時刻(デフォルト: 02:00。登録済みプロジェクトと重複しない時刻を提案)
   - 検証コマンド(`package.json` 等から `test` / `lint` / `build` を自動検出して提案)
3. **ファイル生成**(リポジトリ内 → 要コミット):
   - `.kaizen/config.yml`(→ [03-config-spec.md](./03-config-spec.md))
   - `.github/ISSUE_TEMPLATE/kaizen.yml`(→ [05-issue-conventions.md](./05-issue-conventions.md))
4. **GitHub ラベル作成**(冪等): `kaizen`, `kaizen:P0/P1/P2`, `kaizen:direct`, `kaizen:pr-only`, `kaizen:in-progress`, primary disposition (`kaizen:needs-human`, `kaizen:retryable`, `kaizen:blocked`, `kaizen:upstream-first`, `kaizen:not-actionable`, `kaizen:attempts-exhausted`), `kaizen:goal`, `kaizen:agent:claude`, `kaizen:agent:codex`
5. **ローカル登録**: `~/.kaizen/registry.json` にプロジェクト追加、専用クローン作成(`~/.kaizen/workspaces/<slug>/`)
6. 完了サマリと「次のステップ」(生成ファイルのコミット、`kaizen scheduler sync` によるスケジューラ登録、最初の Issue 登録方法)を表示

---

## `kaizen run`

夜間パイプライン([04-nightly-pipeline.md](./04-nightly-pipeline.md))を 1 回実行する。手動実行・デバッグにも使う。

```
kaizen run [--project <slug>] [--scheduled] [--issue <番号>] [--dry-run]
           [--job <job-id>] [--trigger manual|scheduled|afternoon|instant|watch]
           [--max-issues <N>] [--agent claude|codex]
```

| オプション | 意味 |
|---|---|
| `--scheduled` | 無人実行モード。対話なし。スケジューラからの呼び出し専用 |
| `--job <job-id>` | `scheduler.jobs.<job-id>` の run policy で実行する。provider-aware scheduler が生成するジョブはこれを使う |
| `--trigger <trigger>` | 既存の明示実行契機。`instant` は即時実行、`manual` は手動実行。旧 scheduler 互換以外では `--job` を使う |
| `--issue <番号>` | 指定 Issue のみ処理(優先度選択をスキップ)。デバッグ・即時修正用 |
| `--dry-run` | Issue 取得・除外フィルタ・優先順位による選択までを実行し、**ワークスペース変更・push・コメントは行わない**。リスク判定は実 diff が必要なため実行しない |
| `--max-issues <N>` | この実行に限り処理上限を上書き |
| `--agent <agent>` | builder-agent へ渡す希望バックエンドを上書き(`claude` または `codex`) |
| `--agent` | この実行に限りエージェントを上書き |

`--scheduled` は常に registry の専用 workspace にある `.kaizen/config.yml` を運用設定として使う。通常の手動実行は開発 checkout の設定を使う。scheduled実行ではprojectの有効状態やdry-runの有無にかかわらず、workspace設定が欠落または不正な場合は開発checkoutへfallbackせず失敗するため、先に `kaizen fleet refresh --sync` でworkspaceを復旧する。

### 終了時の通知(macOS)

`--scheduled` 時、実行完了・失敗時に `osascript` で通知センターに結果サマリを表示する(設定 `report.notification: true` のとき)。

---

## `kaizen fix`

Issue を**即時**に修正する(夜間スケジュールを待たない)。パイプライン・安全装置は `run` と共通で、トリガーと対話性のみが異なる。詳細仕様は [09-instant-run.md](./09-instant-run.md)。

```
kaizen fix <Issue番号> [--project <slug>] [--agent claude|codex] [--yes] [--json]
```

- TTY 実行時は main への直接 push 前に**確認プロンプト**を出す(`--yes` でスキップ)
- 非 TTY 時は `instant.unattendedMode`(デフォルト: PR に切替)に従う
- 夜間実行と同一ロックを共有。実行中なら中止する

タイトル指定による起票 + 即時処理は `kaizen report "<タイトル>" --now` を使う。`kaizen fix "<タイトル>"` と `--wait` は未実装。

---

## `kaizen improve`

溜まっている Kaizen Issue を、ユーザの意思で今すぐ改善ループに流す。内部的には `run` と同じ Issue 選択、worktree 分離、PR 作成、pr-guardian を使い、実行契機は即時実行(`instant`)として記録する。

```
kaizen improve [--project <slug>] [--issue <番号[,番号...]>] [--dry-run]
               [--max-issues <N>] [--agent claude|codex] [--yes] [--json]
```

| オプション | 意味 |
|---|---|
| `--issue <番号[,番号...]>` | 指定した Issue だけを対象にする。省略時は `kaizen` label の open issue から通常の優先順位で選ぶ |
| `--dry-run` | 対象 Issue と skip 理由だけを表示し、実装・検証・PR 作成は行わない |
| `--max-issues <N>` | この実行に限り処理上限を上書き。`--issue` 指定時は省略すると指定数を上限にする |
| `--agent <agent>` | builder-agent へ渡す希望バックエンドを上書き(`claude` または `codex`) |
| `--yes` | 実行計画の確認を省略する。非 TTY / `--json` で実行する場合は必須 |

TTY では実行前に対象 Issue の計画を表示して確認する。`--json` や自動化から使う場合は `--dry-run` で計画を確認するか、`--yes` で明示的に実行する。

---

## `kaizen goal`

複数の設計・実装・テスト・評価サイクルが必要な目的を Goal として管理する。Goal は Issue の代替ではなく、Goal runner が小さな `kaizen` Issue を 1 件ずつ作成し、既存の Issue-to-PR pipeline に流してから達成度を評価する上位ループである。詳細は [11-goals.md](./11-goals.md)。

```
kaizen goal create "<title>" --success "<criteria>" [--success "<criteria>"]
                   [--description <body>] [--description-file <path|->]
                   [--constraint <constraint>] [--max-iterations <N>] [--json]

kaizen goal run <goal-id> [--agent claude|codex] [--yes] [--json]
kaizen goal status <goal-id> [--json]
kaizen goal list [--json]
kaizen goal stop <goal-id> [--reason <reason>] [--json]
```

| オプション | 意味 |
|---|---|
| `--success <criteria>` | Goal の達成条件。少なくとも 1 つ必須。複数回指定できる |
| `--constraint <constraint>` | Goal 全体に適用する制約。複数回指定できる |
| `--max-iterations <N>` | この Goal の最大自動 iteration 数。省略時は `goal.maxIterations` |
| `--yes` | `goal run` を非対話で実行する。非 TTY / `--json` では必須 |

Goal が作成する Issue には `kaizen:goal` と queued 実行許可ラベルを付け、本文に `<!-- kaizen-loop:goal ... -->` marker を残す。

---

## `kaizen report`

Kaizen Issue を素早く登録する。**人間と AI エージェント(利用側)の共用インターフェース**。内部は `gh issue create`。

```
kaizen report "<タイトル>" [--body <本文>] [--body-file <path|->]
              [--priority P0|P1|P2] [--direct|--pr-only]
              [--agent claude|codex] [--label <追加ラベル>...]
              [--queue|--no-queue] [--now]
```

- `--now`: 登録後そのまま即時修正を実行する(`report` + `fix` の合成。→ [09-instant-run.md](./09-instant-run.md) §3.2)
- `--queue`: `issues.selection.includeLabel`(デフォルト `kaizen:ready`)を付け、queued 実行の対象にする
- `--no-queue`: Issue は登録するが queued 実行許可ラベルを付けない。`--now` でも明示実行のみ行う

### 例

```sh
# 人間: 手早く 1 行で
kaizen report "CLI の --json が status コマンドで効かない" --priority P1

# AI エージェント: 構造化した本文を stdin から
echo "$BODY" | kaizen report "起動時に config 検証エラーの行番号が出ない" --body-file - --json
```

- `--priority` 省略時は P2
- `--direct` は `kaizen:direct`、`--pr-only` は `kaizen:pr-only` ラベルを付与
- `--now` は未指定時の `--queue` と同じく実行許可ラベルを付ける。即時実行だけにしたい場合は `--now --no-queue`
- `--json` 時は作成された Issue の番号と URL を JSON で返す(AI が後続処理に使える)
- 本文が Issue テンプレートの必須セクション(再現手順 / 期待動作)を欠く場合は警告を出すが登録は通す(夜間エージェントが「情報不足」と判断した場合の挙動は [04-nightly-pipeline.md](./04-nightly-pipeline.md) §6)

---

## `kaizen smoke`

Sandbox repository で実 GitHub 境界を含む issue-to-PR smoke run を 1 件実行し、readiness review 用の証跡 JSON を保存する。内部は `report --now` と同じ instant pipeline を使うが、作成 Issue には `kaizen:pr-only` を付け、GitHub の closing issue 認識を `gh pr view --json closingIssuesReferences` で確認する。

```sh
kaizen smoke [--project <slug>] [--title <title>] [--body <body>]
             [--body-file <path|->] [--priority P0|P1|P2]
             [--agent claude|codex] [--yes] [--json]
```

証跡は `~/.kaizen/projects/<slug>/smoke-runs/<run-id>-issue-<番号>.json` に保存する。artifact には Issue、branch、PR、mechanical verification log、verifier verdict/log、closing issue recognition、guardian outcome を含める。詳細は [13-sandbox-smoke.md](./13-sandbox-smoke.md)。

非 TTY / `--json` で実行する場合は `--yes` が必須。production repository ではなく、harmless なテスト PR を許容する sandbox repository に対して実行する。

---

## `kaizen queue` / `kaizen unqueue`

既存 Issue を queued 実行対象に出し入れする。

```
kaizen queue <Issue番号...> [--project <slug>]
kaizen unqueue <Issue番号...> [--project <slug>]
kaizen queue --list [--project <slug>]
```

- `queue` は `issues.label` と `issues.selection.includeLabel` を付ける
- `unqueue` は `issues.selection.includeLabel` だけを外す
- `queue --list` は queued 実行許可ラベル付きの open Issue を表示する
- `issues.selection.mode: opt-in` では `queue` された Issue だけが scheduled / backlog 実行候補になる

---

## `kaizen status`

```
kaizen status [--project <slug>] [--metrics] [--json]
```

表示内容:

- スケジューラの有効/無効、次回起動時刻
- 直近の実行: 日時、処理件数、成功/失敗、直接コミット/PR の内訳
- 現在オープンな Kaizen Issue 数(優先度別)、`kaizen:needs-human` の件数(**人間の対応待ち**として強調)
- オープン中の kaizen PR 一覧(レビュー待ち)
- PR guardian job 数。open PR に対応しない非終端 job は `guardian.stale` として表示する
- Issue 実装 checkpoint の phase、branch、attempt、最終更新、停止理由、draft/ready PR。24 時間以上更新されていない非終端 checkpoint は `implementations.stale` として表示する
- `configuration` に運用設定の参照元(`workspace` または fallback の `local`)を表示する
- state file が非終端でも PR が既に merge 済みなら表示上は terminal success / complete として補正する。確認できなかった PR 番号は `pullRequestReconciliation.unknown` に残し、正常扱いしない
- `origin/main` に未取り込みのコミットがあり、対応するオープン PR がない remote branch
- `--metrics`: 累積メトリクス、直近 7 日の review-window メトリクス(→ [00-overview.md](./00-overview.md) §6)、sandbox smoke artifact の pass/fail・最新実行日時(`reviewWindow.sandboxSmoke`)、現在の owner-wide 生成 PR WIP 状態(`wipLimit`)と最古の生成 PR の滞留日数を表示する。`generatedPullRequests` には open 生成 PR の作成時刻/滞留日数、review-window 内に merge された生成 PR の merge 時刻、commit source、PR 作成後に追加された人間または非 automation の follow-up commit 分母を含める。欠損 summary は `unreadableRuns` として表示し、読み取れる run の分母を保持する

朝のルーティンは `kaizen status` → `git pull` → 必要なら PR レビュー、を想定する。

---

## `kaizen fleet refresh`

登録済み Kaizen fleet を `~/.kaizen/registry.json` から発見し、各 workspace が次の monitor / scheduler pass に戻れる状態かを検証する。PR merge 後の dogfood では `npm run dogfood:fleet-refresh` を使う。

```
kaizen fleet refresh [--project <slug>] [--sync] [--json]
```

| オプション | 意味 |
|---|---|
| `--project <slug>` | fleet 全体ではなく 1 project だけ検証する |
| `--sync` | 各 workspace を clone 済みにし、`git.defaultBranch` へ fetch / reset / clean してから検証する |
| `--json` | project ごとの `config` / `workspace` / `sync` / `setup` / `verify` 結果を JSON で返す |

検証では各リポジトリの `.kaizen/config.yml` を読み、`commands.setup` と `commands.verify` を workspace 上で実行する。未設定の setup / verify は成功扱いで `not configured` と表示する。いずれかの project で config 読み込み、workspace 確認、sync、setup、verify が失敗した場合、コマンド全体は失敗として終了コード `1` を返す。

---

## `kaizen guardian`

`guardian.mode: async` で保存された PR Guardian job を扱う。

```
kaizen guardian list [--project <slug>] [--json]
kaizen guardian run <pr> [--project <slug>] [--json]
kaizen guardian watch [--project <slug>] [--json]
```

- `list`: 保存済み job を表示する
- `run <pr>`: 指定 PR の job を実行する。PR head SHA が保存済み job と違う場合は新しい job を作り、古い結論を再利用しない
- `watch`: pending job と retry budget が残る blocked job を順に実行する

---

## `kaizen scheduler`

スケジューラ登録の確認・同期・無効化。`disable` は**キルスイッチ**であり、即座に確実に止まることを最優先とする。

```
kaizen scheduler status [--project <slug>]
kaizen scheduler plan [--project <slug>]
kaizen scheduler sync [--project <slug>]
kaizen scheduler set-schedule --job <job-id> (--daily <HH:MM> | --times <HH:MM,...> | --every-hours <N> [--anchor-time <HH:MM>] | --every-minutes <N>)
kaizen scheduler disable [--project <slug>] [--all]
```

- macOS: plist の `launchctl bootstrap` / `bootout`
- Linux: crontab エントリの追加 / 削除
- `sync` は `.kaizen/config.yml` の `scheduler.jobs` を読み、job ごとの plist / cron 行を登録する
- `run.mode: smoke` の job は `kaizen smoke --yes` 相当の sandbox issue-to-PR run を実行し、job id を artifact の trigger に記録する
- `plan` は登録対象の desired state を表示し、変更はしない
- `set-schedule` は job の schedule expression を `.kaizen/config.yml` に書き込む
- `disable --all`: 登録済み全プロジェクトを無効化
- `disable` は実行中の run があれば、ロックファイルの PID に SIGTERM を送って中断させる(中断時の安全性は [07-safety.md](./07-safety.md) §4)

新しい scheduler 操作は `kaizen scheduler ...` に統一する。固定名の `nightly` / `afternoon` / `poll` は設定インターフェイスとして扱わない。

`kaizen enable` / `kaizen disable` は互換用エイリアスとして残っており、内部では同じ launchd / cron 同期・解除処理を呼ぶ。新しい手順やドキュメントでは `kaizen scheduler sync` / `kaizen scheduler disable` を使う。

---

## `kaizen fleet`

Kaizen Loop 自体を更新したあとに、複数 repo のローカル実行環境を desired state へ戻す。`~/.kaizen/registry.json` が消えた、古い scheduler config が残った、launchd / cron が古い `dist/cli.js` を呼んでいる、workspace が欠けている、といった状態をまとめて修復する。

```
kaizen fleet [--manifest <path> | --root <path> [--owner <owner>] [--repo <name|owner/name>...]]
             [--verify] [--prune] [--dry-run]
             [--no-config] [--no-workspace] [--no-labels] [--no-scheduler] [--no-lock-repair]
```

- `--root`: repo checkout が並ぶディレクトリ。省略時はカレント Git repo の親ディレクトリ
- `--manifest`: registry に依存しない authoritative inventory。`--root` / `--owner` / `--repo` とは併用しない
- `--owner`: 対象 GitHub owner。省略時はカレント repo の origin から推定
- `--repo`: 対象の完全な期待集合。1件でも発見できなければ変更前に失敗する。省略時は `--root` 直下の `.kaizen/config.yml` を持つ repo を owner で絞って発見する
- `--prune`: 期待集合にない registry entry を削除する。`--manifest` または明示的な `--repo` 完全集合が必須
- `--dry-run`: 計画だけ表示し、ファイル・registry・GitHub・scheduler を変更しない
- `--no-config`: 旧 `scheduler.nightly` / `scheduler.afternoon` / `scheduler.poll` から `scheduler.jobs` への移行をしない
- `--no-workspace`: `~/.kaizen/workspaces/<slug>` を作成・修復しない
- `--no-labels`: GitHub labels を作成・修復しない
- `--no-scheduler`: launchd / cron を同期しない
- `--no-lock-repair`: PID が存在しない stale `run.lock` を削除しない
- `--verify`: 各 fleet workspace を default branch に同期し、`commands.setup` と `commands.verify` を実行してローカル runner のテスト準備状態を確認する

標準の machine-local inventory は `~/.kaizen/fleet.yml` に置く。相対 `localPath` は manifest の親ディレクトリから解決される。

```yaml
version: 1
owner: kaizen-agents-org
projects:
  - repo: .github
    localPath: /stable/checkouts/.github
  - repo: builder-agent
    localPath: /stable/checkouts/builder-agent
  - repo: kaizen-loop
    localPath: /stable/checkouts/kaizen-loop
  - repo: verifier
    localPath: /stable/checkouts/verifier
```

標準の dogfood 復旧手順:

```sh
npm run dogfood:sync
npm run dogfood:verify
node dist/cli.js run --project kaizen-agents-org-kaizen-loop --dry-run --json
```

`fleet` は全対象の checkout・origin・config を preflight してから適用する。設定または verify が1件でも失敗した場合、部分的な registry は commit しない。registry は process lock 内で atomic replace される。通常の scheduled run の `lastRun` telemetry は `~/.kaizen/projects/<slug>/last-run.json` に保存し、topology registry を書き換えない。

破損復旧では registry 内の `localPath` を信用せず、`kaizen fleet --manifest ~/.kaizen/fleet.yml --prune` を使う。Kaizen Loop の config schema や scheduler 生成物を変更した場合も、安定した checkout を指す manifest から `fleet` を実行する。

---

## `kaizen logs`

```
kaizen logs [--project <slug>] [--run <timestamp>] [--issue <番号>] [--guardian] [--follow]
```

- 引数なし: 直近の実行の `summary.json` を表示
- `--issue`: その Issue のエージェントログ・検証ログを表示
- `--guardian`: 非同期 PR Guardian job state JSON を表示
- `--follow`: 実行中の run をテイルする(夜間実行を手動で見守る場合)

---

## `kaizen doctor`

環境診断。`init` の前提検査 + ワークスペースの健全性検査。

```
kaizen doctor [--project <slug>] [--repair]
```

検査項目: gh 認証、開発 checkout と workspace の設定ファイルのスキーマ妥当性、builder-agent、verifier、pr-guardian skill runner、ワークスペースパスの存在。運用検査には workspace 設定を使い、開発 checkout と意味的に異なる場合は `configuration.drift` に診断情報を返す。この差は feature branch 上の作業でも発生し得るため、それだけでは `ok: false` にしない。構造化された `verifier --version --json` を利用できる場合は、ビルド時 commit とリンク先 checkout の commit も比較し、stale build を診断エラーにする。旧 verifier のプレーンな version 出力は互換モードとして受け付ける。

`--repair`: 設定から必要な GitHub ラベルを再作成する。複数 repo の registry 再構築、stale ロック削除、ワークスペース再作成、スケジューラ定義の再生成は `kaizen fleet` を使う。

---

## `kaizen list`

```
kaizen list [--json]
```

`~/.kaizen/registry.json` の登録プロジェクト一覧(slug、パス、スケジュール、有効/無効、直近実行結果)を表示する。
