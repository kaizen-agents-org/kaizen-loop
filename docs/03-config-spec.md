# 03. 設定ファイル仕様

設定は 2 層に分かれる(→ [01-architecture.md](./01-architecture.md) §4):

1. **リポジトリ設定** `<repo>/.kaizen/config.yml` — チームで共有するポリシー。コミットする
2. **ローカル状態** `~/.kaizen/registry.json` ほか — マシン固有。コミットしない

## 1. リポジトリ設定 `.kaizen/config.yml`

`kaizen init` が生成する。起動時に JSON Schema で厳格に検証し、不正な場合は**実行せず**終了コード 2(夜間の無人実行で誤った設定のまま動くことを防ぐ)。

### フルサンプル(生成時のデフォルト値つき)

以下は `kaizen init` が生成するデフォルト値のサンプル。このリポジトリのコミット済み `.kaizen/config.yml` は運用ポリシーとして `agent.default: codex` を設定しているため、通常の Issue 処理では Codex を希望バックエンドとして builder-agent へ渡す。

```yaml
# .kaizen/config.yml
version: 1

agent:
  # builder-agent へ渡す既定の希望バックエンド。Issue ラベル kaizen:agent:* が最優先で上書きする
  default: claude            # claude | codex
  # 互換用の設定。実際のフォールバックは builder-agent 側で扱う
  fallback: true
  # 希望バックエンドに対応するモデル指定。builder-agent へ KAIZEN_AGENT_MODEL として渡す
  model:
    claude: null             # 例: "claude-opus-4-8"
    codex: null              # 例: "gpt-5-codex"

run:
  maxIssuesPerNight: 3       # 自動実行 1 回あたりに処理する Issue の上限
  issueTimeoutMinutes: 120   # 1 Issue あたりのエージェント実行タイムアウト
  runTimeoutMinutes: 240     # 実行全体のタイムアウト(超過時は残 Issue をスキップして終了処理)
  maxVerifyRetries: 2        # 検証失敗時、エラーを添えてエージェントに再修正させる回数
  maxAttemptsPerIssue: 3     # 夜をまたいだ累計試行回数。超えたら kaizen:needs-human へ
  maxOpenPullRequests: 1     # 自動実行で新規 PR 作成を許可する repo 別 open PR 上限
  latestStartHour: 7         # scheduled 実行がこの時刻を過ぎて開始したらスキップ

safety:
  # workspace / worktree 作成前に必要な空き容量(MB)
  minFreeDiskMb: 1024
  # setup / verify / builder / verifier / guardian へ渡す process.env の allowlist
  # Kaizen 専用変数と短い Kaizen TMPDIR は実行時に追加される
  envAllowlist:
    - PATH
    - HOME
    - USER
    - LOGNAME
    - SHELL
    - TERM
    - LANG
    - LC_ALL
    - LC_CTYPE
    - TMPDIR
    - TMP
    - TEMP
    - KAIZEN_TMPDIR
    - KAIZEN_HOME
    - GH_CONFIG_DIR
    - SSH_AUTH_SOCK
    - GIT_SSH_COMMAND

scheduler:
  jobs:
    maintenance:
      enabled: true
      schedule:
        type: daily          # `kaizen run --scheduled --job maintenance`
        time: "02:45"
      run:
        mode: maintenance
        lateStartGuard: true
    maintenance-followup:
      enabled: true
      schedule:
        type: daily          # `kaizen run --scheduled --job maintenance-followup`
        time: "14:45"
      run:
        mode: maintenance
        lateStartGuard: false
    issue-watch:
      enabled: false
      schedule:
        type: interval       # `kaizen run --scheduled --job issue-watch`
        everyMinutes: 5
      run:
        mode: watch
        skipIfRunning: true  # 実体は run.lock。前回run中なら次の起動は即終了

commands:
  # ワークスペース reset 後、ベースライン検証前と作業ブランチ作成前に実行(依存インストール等)。null ならスキップ
  setup: "npm ci"
  # 検証コマンド。上から順に実行し、すべて成功で「検証パス」
  verify:
    - "npm test"
    - "npm run lint"
  # 検証コマンドのタイムアウト(分)
  verifyTimeoutMinutes: 15

builder:
  # Kaizen Loop は Claude/Codex を直接呼ばず、このコマンドへプロンプトを stdin で渡す
  command: "builder-agent"
  # builder-agent が構造化結果を書き込むパス(ワークスペース相対)
  resultPath: ".kaizen/builder/build-result.json"

verifier:
  # 機械的 verify 成功後に verifier を呼ぶ
  enabled: true
  command: "verifier"
  # verifier の構造化結果。status は open_pr | open_pr_with_warning | block_pr | needs_context
  # (旧 approved | pr_only | rejected も当面受け付ける)
  resultPath: ".kaizen/verifier/verify-result.json"
  timeoutMinutes: 15

guardian:
  # PR 作成後に skills/pr-guardian/SKILL.md を Codex で実行する
  enabled: true
  mode: sync                   # sync | async
  command: "codex"
  timeoutMinutes: 60
  maxAttempts: 5

goal:
  # 1 Goal あたりの最大自動 iteration 数
  maxIterations: 5
  # Goal runner が作る Issue に追加するラベル
  issueLabel: "kaizen:goal"
  evaluation:
    # Goal 固有の機械評価。設定すると AI evaluator が succeeded を返しても、このコマンドが失敗していれば Goal は成功扱いにしない
    command: null             # 例: "npm test && npm run coverage"
    timeoutMinutes: 15
  agent:
    # Planner / evaluator 用 agent。stdin で prompt を受け取り、JSON を返す
    command: "codex"
    args: ["exec", "--sandbox", "read-only", "-"]
    # 相対パスの場合はローカル Goal 状態ディレクトリ相対
    resultPath: "goal-result.json"
    timeoutMinutes: 20

policy:
  # 反映方法: pr-only | hybrid | direct-only
  # 既定は PR-first。hybrid / direct-only は明示 opt-in
  # direct-only でも verify / protectedPaths / forbiddenPaths / pr-only ラベルの安全ゲートはバイパスしない
  mode: pr-only
  # hybrid / direct-only 時の直接コミット許可条件(すべて満たす必要がある。→ 04-nightly-pipeline.md §6)
  directCommit:
    maxChangedLines: 150     # 追加+削除の合計
    maxChangedFiles: 5
  # 触れてよいが、触れたら必ず PR にするパス(glob)
  protectedPaths:
    - ".github/**"
    - "**/.env*"
    - "**/secrets/**"
    - "**/*migration*/**"
    - "Dockerfile"
    - ".kaizen/**"           # ループ自身の設定改変は必ず人間レビュー
  # エージェントがいかなる場合も変更してはならないパス(検出したら当該 Issue を失敗扱い)
  forbiddenPaths:
    - "**/.git/**"

git:
  defaultBranch: main
  branchPrefix: "kaizen/"    # 作業ブランチ: kaizen/issue-<N>-<slug>
  commitMessageFormat: "kaizen: {summary} (#{issue})"

instant:
  # 即時実行(kaizen fix / report --now / watch。→ 09-instant-run.md)
  # 非 TTY・無人の即時実行で「直接コミット」判定が出たときの挙動
  unattendedMode: pr         # pr(PR に切替・デフォルト) | direct(設定済み direct 経路) | reject(中止)

report:
  notification: true         # macOS 通知センターへの完了通知
  # 各 Issue へ結果コメントを残す(無効化は非推奨)
  issueComments: true

issues:
  label: "kaizen"            # Kaizen 管理対象を示す base ラベル
  selection:
    mode: auto               # auto | opt-in | manual-only
    includeLabel: "kaizen:ready"
    excludeLabels:
      - "kaizen:needs-human"
  # 優先度順(先頭が最優先)。同優先度は古い順
  priorityOrder: ["kaizen:P0", "kaizen:P1", "kaizen:P2"]
```

### フィールド規約

- 未知のキーはエラー(タイポによるサイレント無効化を防ぐ)
- `scheduler.provider` は省略可能。省略時、`kaizen scheduler status` / `plan` は macOS なら `launchd`、Linux なら `cron` と表示する。schema は `codex-automation` / `claude-routine` / `external` も受け付けるが、現行の `scheduler sync` は OS に応じた launchd / cron 生成だけを行う
- `commands.verify` が自動検出できず未設定の場合、`init` は警告し、`run` は**検証なしの直接コミットを禁止**する(検証なし → 強制 PR モード)
- `commands.setup` が自動検出できない場合は `null` にする。`null` の場合、setup は実行しない
- `safety.minFreeDiskMb` は workspace / worktree 作成前の空き容量 preflight。対象パスがまだ存在しない場合は既存の親ディレクトリを検査する
- `safety.envAllowlist` は agent と shell command へ渡す環境変数名の allowlist。`KAIZEN_BUILD_RESULT_PATH` などの Kaizen 専用変数と短い Kaizen `TMPDIR` / `TMP` / `TEMP` は実行時に追加される。`KAIZEN_TMPDIR` を渡すと temp directory を明示的に上書きできる
- `policy.mode` の既定は `pr-only`。直接コミットを許可するには `hybrid` または `direct-only` を明示する
- `policy.mode: direct-only` は「可能なら PR ではなく直接コミットする」指定であり、安全ゲート違反時は PR または失敗に降格する
- `run.maxOpenPullRequests` は scheduler job などの自動実行にだけ適用する repo 別 backpressure。未レビュー PR が溜まりすぎて競合やレビュー滞留を増やすのを避けるため、open PR 数が上限以上なら新しい Issue は選択せず、`kaizen fix` / `--issue` の明示実行は止めない。固定ブランチを再利用する sync PR (`codex/daily-dogfood-sync`、`codex/sync-kaizen-dogfood`、`codex/sync-kaizen-shared-skills`) はこのカウントから除外する
- `verifier.enabled: true` の場合、`open_pr` / `open_pr_with_warning` は常に ready-for-review の PR 作成へ進む。直接コミット判定は行わない。verifier は PR 作成可否のゲートであり、マージ承認ではない
- `guardian.enabled: true` の場合、PR 作成後に vendored `skills/pr-guardian/SKILL.md` を `guardian.command exec` で実行する。`guardian.mode: sync` は foreground run 内で実行し、`async` は `~/.kaizen/projects/<slug>/guardian/jobs/` に永続 job を enqueue して `kaizen guardian watch` / `kaizen guardian run <pr>` で再開する。PR の mergeable 化、`gh run watch` による CI 監視、未解決の actionable review feedback 対応、レビューコメントへの返信は skill 側の責務。各 pass 後に Kaizen Loop 本体が未解決・非 outdated の review thread を確認し、残っていれば `guardian.maxAttempts` まで再実行する。approval 不足は branch protection が明示要求している場合だけ blocker として扱う
- `goal.agent` は Goal planner / evaluator の呼び出し設定。`KAIZEN_GOAL_RESULT_PATH` に JSON を書くか、stdout の最後に JSON を出す。Goal runner はこの agent に実装や GitHub 操作をさせず、Issue 作成と既存 pipeline の呼び出しを自分で行う
- `goal.issueLabel` は `kaizen goal run` が生成する Issue に付けるラベル。実行対象の判定は通常の `issues.label` と queued label に従う
- `goal.evaluation.command` は Goal 達成の機械的な追加ゲート。設定されている場合、各 iteration 後に登録プロジェクトの checkout で実行し、失敗時は AI evaluator の `succeeded` を `continue` に降格する
- `issues.selection.mode: auto` は既存互換で、`issues.label` 付きの open Issue を自動選択候補にする
- `issues.selection.mode: opt-in` は `issues.label` と `issues.selection.includeLabel` の両方を持つ Issue だけを scheduled / backlog 実行候補にする
- `issues.selection.mode: manual-only` は scheduled / backlog 実行で Issue を自動選択しない。`kaizen fix <Issue番号>` などの明示実行は可能
- `issues.selection.excludeLabels` は selection mode より後の除外条件。デフォルトでは `kaizen:needs-human` を実行しない

## 2. ローカル登録簿 `~/.kaizen/registry.json`

`kaizen init` / `kaizen scheduler sync` / `kaizen scheduler disable` が管理する。手編集は想定しない(`kaizen list` / `doctor` で参照・修復)。

```json
{
  "version": 1,
  "projects": {
    "s-hiraoku-myapp": {
      "repo": "s-hiraoku/myapp",
      "localPath": "/Volumes/SSD/ghq/github.com/s-hiraoku/myapp",
      "workspacePath": "/Users/me/.kaizen/workspaces/s-hiraoku-myapp",
      "schedule": "02:00",
      "enabled": true,
      "createdAt": "2026-06-12T09:00:00+09:00",
      "lastRun": {
        "startedAt": "2026-06-12T02:00:03+09:00",
        "finishedAt": "2026-06-12T02:41:18+09:00",
        "result": "success",
        "processed": 3, "fixed": 2, "prCreated": 1, "failed": 0
      }
    }
  }
}
```

`schedule` は旧 scheduler 互換の時刻で、現行の job 定義では `.kaizen/config.yml` の `scheduler.jobs` が起動時刻の source of truth になる。`enabled` はローカル scheduler が有効化されているかを示すマシン固有状態。

## 3. 実行サマリ `runs/<timestamp>/summary.json`

1 回の `kaizen run` の機械可読レポート。`kaizen status` / `--metrics` の集計元。

```json
{
  "version": 1,
  "project": "s-hiraoku-myapp",
  "startedAt": "2026-06-12T02:00:03+09:00",
  "finishedAt": "2026-06-12T02:41:18+09:00",
  "trigger": "scheduled",
  "result": "success",
  "issues": [
    {
      "number": 42,
      "title": "status コマンドで --json が効かない",
      "priority": "kaizen:P1",
      "agent": "builder",
      "attempt": 1,
      "outcome": "direct-commit",
      "commit": "a1b2c3d",
      "changedFiles": 2,
      "changedLines": 38,
      "verifyRetries": 0,
      "durationMs": 412000
    },
    {
      "number": 43,
      "title": "設定リロード時に古い値が残る",
      "priority": "kaizen:P2",
      "agent": "builder",
      "attempt": 2,
      "outcome": "pr-created",
      "pr": 51,
      "reason": "changedLines(212) > maxChangedLines(150)",
      "durationMs": 1130000
    }
  ],
  "skipped": [
    { "number": 44, "reason": "maxIssuesPerNight reached" }
  ]
}
```

`outcome` の取りうる値: `direct-commit` | `pr-created` | `failed` | `blocked`(情報不足)| `skipped`。`kaizen:needs-human` は outcome ではなく、`failed` / `blocked` の結果として Issue に付与される状態ラベル。

## 4. スケジューラ定義(生成物)

この節は現行の launchd / cron 生成物を定義する。Codex Automations、Claude Code routines、外部スケジューラへ同じ scheduler 設定を同期する provider 設計は [12-scheduler-providers.md](./12-scheduler-providers.md) を参照。

### macOS — `~/Library/LaunchAgents/com.kaizen-loop.<slug>.<job>.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kaizen-loop.s-hiraoku-myapp.maintenance</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/kaizen</string>
    <string>run</string>
    <string>--project</string><string>s-hiraoku-myapp</string>
    <string>--scheduled</string>
    <string>--job</string><string>maintenance</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>45</integer></dict>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key>
  <string>/Users/me/.kaizen/projects/s-hiraoku-myapp/maintenance.launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/me/.kaizen/projects/s-hiraoku-myapp/maintenance.launchd.err.log</string>
</dict>
</plist>
```

`scheduler.jobs` の enabled job ごとに別 plist を生成する。たとえば watch job は `StartInterval` と `--job issue-watch` を使う:

```xml
<key>Label</key><string>com.kaizen-loop.s-hiraoku-myapp.issue-watch</string>
<key>ProgramArguments</key>
<array>
  <string>/path/to/node</string>
  <string>/path/to/kaizen</string>
  <string>run</string>
  <string>--project</string><string>s-hiraoku-myapp</string>
  <string>--scheduled</string>
  <string>--job</string><string>issue-watch</string>
</array>
<key>StartInterval</key><integer>300</integer>
```

注意点:

- `node` / `kaizen` は**絶対パス**で埋め込む(launchd の PATH は最小限のため)
- `gh` / `claude` / `codex` / `git` が見つかるよう、`EnvironmentVariables` に PATH を明示的に設定する
- plist に埋め込む文字列は XML escape する
- launchd はスリープ復帰時に取りこぼした `StartCalendarInterval` を実行するため、夜間スリープしていても朝の起床時にループが回る(→ [07-safety.md](./07-safety.md) §6 で朝実行時の挙動を規定)

### Linux — crontab エントリ

```cron
# KAIZEN-LOOP s-hiraoku-myapp (managed by kaizen-loop; do not edit) maintenance
45 2 * * * '/path/to/node' '/path/to/kaizen' run --project 's-hiraoku-myapp' --scheduled --job 'maintenance' >> '/Users/alice/.kaizen/projects/s-hiraoku-myapp/maintenance.cron.log' 2>&1
45 10 * * * '/path/to/node' '/path/to/kaizen' run --project 's-hiraoku-myapp' --scheduled --job 'maintenance' >> '/Users/alice/.kaizen/projects/s-hiraoku-myapp/maintenance.cron.log' 2>&1
45 18 * * * '/path/to/node' '/path/to/kaizen' run --project 's-hiraoku-myapp' --scheduled --job 'maintenance' >> '/Users/alice/.kaizen/projects/s-hiraoku-myapp/maintenance.cron.log' 2>&1
# KAIZEN-LOOP s-hiraoku-myapp (managed by kaizen-loop; do not edit) issue-watch
*/5 * * * * '/path/to/node' '/path/to/kaizen' run --project 's-hiraoku-myapp' --scheduled --job 'issue-watch' >> '/Users/alice/.kaizen/projects/s-hiraoku-myapp/issue-watch.cron.log' 2>&1
```

マーカーコメントで kaizen 管理行を識別し、`scheduler sync` / `scheduler disable` はその行のみを追加・削除する。`run.mode: watch` の job は対象 Issue がなければ `gh issue list` 後に即終了する軽量起動であり、`skipIfRunning: true` なら前回 run が続いている場合に `run.lock` でスキップされる。

注意点:

- `node` / `kaizen` / ログパスは絶対パスを使う
- パスや slug を crontab 行へ埋め込むときは POSIX shell として quote する
- `~/.kaizen/projects/<slug>/` は crontab 登録前に作成する
- cron は login shell ではないため、必要な PATH はコマンド行または wrapper 側で明示する
