# 03. 設定ファイル仕様

設定は 2 層に分かれる(→ [01-architecture.md](./01-architecture.md) §4):

1. **リポジトリ設定** `<repo>/.kaizen/config.yml` — チームで共有するポリシー。コミットする
2. **ローカル状態** `~/.kaizen/registry.json` ほか — マシン固有。コミットしない

## 1. リポジトリ設定 `.kaizen/config.yml`

`kaizen init` が生成する。起動時に JSON Schema で厳格に検証し、不正な場合は**実行せず**終了コード 2(夜間の無人実行で誤った設定のまま動くことを防ぐ)。

### フルサンプル(デフォルト値つき)

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
  maxIssuesPerNight: 3       # 1 晩に処理する Issue の上限
  issueTimeoutMinutes: 30    # 1 Issue あたりのエージェント実行タイムアウト
  runTimeoutMinutes: 240     # 実行全体のタイムアウト(超過時は残 Issue をスキップして終了処理)
  maxVerifyRetries: 2        # 検証失敗時、エラーを添えてエージェントに再修正させる回数
  maxAttemptsPerIssue: 3     # 夜をまたいだ累計試行回数。超えたら kaizen:needs-human へ
  latestStartHour: 7         # scheduled 実行がこの時刻を過ぎて開始したらスキップ

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
  command: "codex"
  timeoutMinutes: 60
  maxAttempts: 5

policy:
  # 反映方法: hybrid | pr-only | direct-only
  # direct-only でも verify / protectedPaths / forbiddenPaths / pr-only ラベルの安全ゲートはバイパスしない
  mode: hybrid
  # hybrid 時の直接コミット許可条件(すべて満たす必要がある。→ 04-nightly-pipeline.md §6)
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
  unattendedMode: pr         # pr(PR に切替・デフォルト) | direct(夜間と同じ) | reject(中止)

report:
  notification: true         # macOS 通知センターへの完了通知
  # 各 Issue へ結果コメントを残す(無効化は非推奨)
  issueComments: true

issues:
  label: "kaizen"            # 処理対象を示すラベル
  # 優先度順(先頭が最優先)。同優先度は古い順
  priorityOrder: ["kaizen:P0", "kaizen:P1", "kaizen:P2"]
```

### フィールド規約

- 未知のキーはエラー(タイポによるサイレント無効化を防ぐ)
- `commands.verify` が自動検出できず未設定の場合、`init` は警告し、`run` は**検証なしの直接コミットを禁止**する(検証なし → 強制 PR モード)
- `commands.setup` が自動検出できない場合は `null` にする。`null` の場合、setup は実行しない
- `policy.mode: direct-only` は「可能なら PR ではなく直接コミットする」指定であり、安全ゲート違反時は PR または失敗に降格する
- `verifier.enabled: true` の場合、`open_pr` / `open_pr_with_warning` は常に ready-for-review の PR 作成へ進む。直接コミット判定は行わない。verifier は PR 作成可否のゲートであり、マージ承認ではない
- `guardian.enabled: true` の場合、PR 作成後に vendored `skills/pr-guardian/SKILL.md` を `guardian.command exec` で実行する。PR の mergeable 化、`gh run watch` による CI 監視、レビューコメントへの返信は skill 側の責務

## 2. ローカル登録簿 `~/.kaizen/registry.json`

`kaizen init` / `enable` / `disable` が管理する。手編集は想定しない(`kaizen list` / `doctor` で参照・修復)。

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

### macOS — `~/Library/LaunchAgents/com.kaizen-loop.<slug>.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kaizen-loop.s-hiraoku-myapp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/kaizen</string>
    <string>run</string>
    <string>--project</string><string>s-hiraoku-myapp</string>
    <string>--scheduled</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key>
  <string>/Users/me/.kaizen/projects/s-hiraoku-myapp/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/me/.kaizen/projects/s-hiraoku-myapp/launchd.err.log</string>
</dict>
</plist>
```

注意点(実装時の要件):

- `node` / `kaizen` は**絶対パス**で埋め込む(launchd の PATH は最小限のため)
- `gh` / `claude` / `codex` / `git` が見つかるよう、`EnvironmentVariables` に PATH を明示的に設定する
- plist に埋め込む文字列は XML escape する
- launchd はスリープ復帰時に取りこぼした `StartCalendarInterval` を実行するため、夜間スリープしていても朝の起床時にループが回る(→ [07-safety.md](./07-safety.md) §6 で朝実行時の挙動を規定)

### Linux — crontab エントリ

```cron
# KAIZEN-LOOP s-hiraoku-myapp (managed by kaizen-loop; do not edit)
0 2 * * * /path/to/node /path/to/kaizen run --project s-hiraoku-myapp --scheduled >> ~/.kaizen/projects/s-hiraoku-myapp/cron.log 2>&1
```

マーカーコメントで kaizen 管理行を識別し、`enable` / `disable` はその行のみを追加・削除する。

注意点(実装時の要件):

- `node` / `kaizen` / ログパスは絶対パスを使う
- パスや slug を crontab 行へ埋め込むときは POSIX shell として quote する
- `~/.kaizen/projects/<slug>/` は crontab 登録前に作成する
- cron は login shell ではないため、必要な PATH はコマンド行または wrapper 側で明示する
