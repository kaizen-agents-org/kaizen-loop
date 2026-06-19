# 11. Goal mode

Goal mode は、1 回の Issue 修正では終わらない目的を `KAIZEN_HOME` 配下のローカル状態として管理し、必要な scoped Issue を作りながら既存の Issue-to-PR パイプラインを繰り返す。

## コマンド

```sh
kaizen goal create "Goal objective" --json
kaizen goal run <Goal ID> --max-iterations 1 --json
kaizen goal status <Goal ID> --json
kaizen goal list --json
kaizen goal stop <Goal ID> --reason "superseded"
```

状態は `KAIZEN_HOME/projects/<slug>/goals/<Goal ID>.json` に保存する。`run` 中は同じディレクトリに `<Goal ID>.lock` を作り、同一 Goal の重複実行を防ぐ。通常の Issue 処理は既存の `run.lock` も使うため、Goal run と nightly run も同時には進まない。

## 状態

Goal state の `status` は次のいずれか。

| status | 意味 |
|---|---|
| `active` | 次の `goal run` で継続できる |
| `running` | Goal lock を保持して iteration 実行中 |
| `succeeded` | 評価が成功と判断した |
| `blocked` | 評価が人間対応待ちと判断した |
| `stopped` | `goal stop` で停止された |
| `failed` | Issue 作成、pipeline 実行、評価コマンドなどの機械的失敗 |

`failed` は再実行可能。`succeeded` / `blocked` / `stopped` は再実行しない。

## Goal-linked Issue

`goal run` は evaluator の `nextIssue`、または既定テンプレートから Issue を作る。Issue には以下を付与する。

- `kaizen` と priority label
- `kaizen:ready`
- `kaizen:pr-only`
- `kaizen:goal`
- 本文末尾の `<!-- kaizen-goal {"id":"...","project":"..."} -->` marker

作成後は `kaizen run --issue <番号> --trigger instant` 相当で既存の builder-agent / verifier / pr-guardian パイプラインを使う。

## 評価コマンド

`.kaizen/config.yml` の `commands.goalEvaluate` を設定すると、各 iteration の前後で機械的評価を実行する。

```yaml
commands:
  goalEvaluate: "node scripts/evaluate-goal.mjs"
```

呼び出し時の契約:

- cwd は対象リポジトリ
- stdin は `{ "phase": "before"|"after", "goal": <GoalState> }`
- `KAIZEN_GOAL_PHASE` は `before` または `after`
- `KAIZEN_GOAL_STATE_PATH` は現在の Goal state JSON
- `KAIZEN_GOAL_RESULT_PATH` に結果 JSON を書ける。stdout JSON も受け付ける

結果 JSON:

```json
{
  "status": "continue",
  "summary": "Next scoped step is clear.",
  "reason": "",
  "nextIssue": {
    "title": "Implement one scoped slice",
    "body": "Detailed issue body for the builder.",
    "priority": "P2",
    "labels": ["area:cli"]
  }
}
```

`status` は `continue` / `succeeded` / `blocked`。`continue` の場合、`nextIssue` を返すと次の Issue 作成内容を制御できる。`succeeded` は Goal 完了、`blocked` は人間対応待ちとして停止する。

`commands.goalEvaluate` が `null` の場合、既定評価は 1 iteration を作成し、その Issue-to-PR 実行が失敗・ブロックしなければ Goal を `succeeded` にする。
