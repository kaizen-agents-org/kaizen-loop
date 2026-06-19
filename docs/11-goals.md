# 11. Goal 機能

Goal は、単発 Issue では終わらない目的を「計画 → 実装 → テスト → 評価」の小さな iteration に分けて進める上位ループである。既存の Issue-to-PR pipeline を置き換えず、Goal runner が次の小さな Issue を作り、`runKaizen` と同じ安全装置で処理する。

## 使い分け

| 状況 | コマンド |
|---|---|
| 1 つの明確なバグや改善を今すぐ直す | `kaizen report --now` / `kaizen fix <issue>` |
| 既存の queued Issue をまとめて処理する | `kaizen improve` |
| 達成条件に向けて複数 iteration を回す | `kaizen goal` |

Goal を使う場合も、実装単位は常に GitHub Issue と PR / direct commit で記録される。

## CLI

```sh
kaizen goal create "Improve onboarding reliability" \
  --description "First-run setup should be reliable for new projects." \
  --success "npm test and npm run typecheck pass" \
  --success "README quickstart covers init, report, fix, and goal" \
  --max-iterations 5 \
  --json

kaizen goal run <goal-id> --yes --json
kaizen goal status <goal-id> --json
kaizen goal list --json
kaizen goal stop <goal-id> --reason "No longer needed" --json
```

`goal run --json` と非 TTY 実行では `--yes` が必須。これは Goal runner が複数 Issue を自動作成しうるため、利用側エージェントに明示的な実行承認を要求するためである。

## 状態

Goal 状態はローカル状態として保存し、対象リポジトリにはコミットしない。

```text
~/.kaizen/projects/<slug>/goals/<goal-id>/goal.json
```

`goal.json` には Goal の達成条件、制約、iteration 履歴、各 iteration の Issue 番号、run summary、評価結果を保存する。終了状態は `succeeded` / `blocked` / `failed` / `stopped` のいずれか。

## Iteration

1. Goal planner が次の小さな Issue を 1 件だけ提案する。
2. Goal runner が `kaizen`、`kaizen:goal`、queued 実行許可ラベル付きで Issue を作成する。
3. Issue 本文に Goal marker を残す。
4. Goal runner がその Issue 番号を指定して既存 pipeline を実行する。
5. Goal evaluator が run summary と Goal 履歴から達成度を評価する。
6. 未達なら次 iteration、達成・blocked・failed なら終了する。

`goal.evaluation.command` が設定されている場合、Goal runner は evaluator の前にそのコマンドを実行する。コマンドが失敗した場合、AI evaluator が誤って `succeeded` を返しても Goal は成功扱いにならず、`continue` として扱われる。これにより coverage、統合テスト、ドキュメント検査などの機械的な達成条件を Goal の終了条件に組み込める。

Issue marker:

```markdown
<!-- kaizen-loop:goal {"goalId":"goal-20260618T120000Z-improve-onboarding","iteration":1} -->
```

## Agent Contract

Goal planner / evaluator は `goal.agent` の command で呼ばれる。prompt は stdin、結果は `KAIZEN_GOAL_RESULT_PATH` または stdout の最後の JSON で返す。

Planner result:

```json
{
  "status": "issue",
  "reason": "Why this is the right next step.",
  "nextIssue": {
    "title": "Add onboarding smoke test",
    "body": "Add a small smoke test for first-run setup.",
    "priority": "P2"
  }
}
```

Evaluator result:

```json
{
  "status": "continue",
  "confidence": 0.75,
  "reason": "Tests pass, but docs still miss the goal command.",
  "satisfiedCriteria": ["npm test passes"],
  "missingCriteria": ["README quickstart covers goal"],
  "nextIssue": {
    "title": "Document goal quickstart",
    "body": "Add goal create/run examples to README.",
    "priority": "P2"
  }
}
```

Planner status is `issue` / `succeeded` / `blocked`. Evaluator status is `succeeded` / `continue` / `blocked` / `failed`.

## 利用側エージェント向けルール

- 複数 cycle が必要な目的には積極的に `kaizen goal` を使う。
- 「ゴール」「目標」「達成するまで」「改善し続ける」「評価しながら」「設計・実装・テストを回す」「品質を上げる」「カバレッジを上げる」「ドキュメントを整備する」のような依頼は、単発 Issue と断定できない限り Goal 候補として扱う。
- 単発の明確な修正、再現条件がある 1 バグ、1 ファイル/1 挙動に閉じた改善には `kaizen report --now` または `kaizen fix` を使う。
- Goal のために利用側エージェントが複数 Issue を手動作成しない。Issue 生成は Goal runner に任せる。
- `kaizen goal status --json` を source of truth として読む。
- Goal が `succeeded` / `blocked` / `failed` / `stopped` になったら停止する。
- secrets、課金、本番インフラ、破壊的変更は Goal でも明示的な人間承認なしに進めない。
