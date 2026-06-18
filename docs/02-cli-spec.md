# 02. CLI コマンド仕様

パッケージ名: `kaizen-loop`。バイナリ名: `kaizen`(`npx kaizen-loop` でも同一エントリ)。

```
kaizen <command> [options]

Commands:
  init        ターゲットプロジェクトに Kaizen Loop を導入する
  run         夜間メンテナンスパイプラインを実行する(スケジューラからも呼ばれる)
  fix         Issue を即時修正する(夜間を待たない。→ 09-instant-run.md)
  report      Kaizen Issue を素早く登録する(人間・AI 共用)
  goal        複数 iteration の Goal を作成・実行・評価する
  watch       kaizen:now ラベルを監視して即時修正する常駐モード(→ 09-instant-run.md)
  status      ループの状態・直近の実行結果を表示する
  enable      スケジューラを有効化する
  disable     スケジューラを無効化する(キルスイッチ)
  logs        実行ログを表示する
  doctor      環境診断・修復
  list        登録済みプロジェクト一覧

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
   - builder-agent へ渡す希望バックエンド(デフォルト: claude)
   - 起動時刻(デフォルト: 02:00。登録済みプロジェクトと重複しない時刻を提案)
   - 検証コマンド(`package.json` 等から `test` / `lint` / `build` を自動検出して提案)
3. **ファイル生成**(リポジトリ内 → 要コミット):
   - `.kaizen/config.yml`(→ [03-config-spec.md](./03-config-spec.md))
   - `.github/ISSUE_TEMPLATE/kaizen.yml`(→ [05-issue-conventions.md](./05-issue-conventions.md))
4. **GitHub ラベル作成**(冪等): `kaizen`, `kaizen:P0/P1/P2`, `kaizen:direct`, `kaizen:pr-only`, `kaizen:in-progress`, `kaizen:needs-human`, `kaizen:goal`, `kaizen:agent:claude`, `kaizen:agent:codex`
5. **ローカル登録**: `~/.kaizen/registry.json` にプロジェクト追加、専用クローン作成(`~/.kaizen/workspaces/<slug>/`)
6. **スケジューラ登録**: `kaizen enable` 相当を実行(`--no-schedule` でスキップ可)
7. 完了サマリと「次のステップ」(生成ファイルのコミット、最初の Issue 登録方法)を表示

---

## `kaizen run`

夜間パイプライン([04-nightly-pipeline.md](./04-nightly-pipeline.md))を 1 回実行する。手動実行・デバッグにも使う。

```
kaizen run [--project <slug>] [--scheduled] [--issue <番号>] [--dry-run]
           [--trigger manual|scheduled|instant|watch]
           [--max-issues <N>] [--agent claude|codex]
```

| オプション | 意味 |
|---|---|
| `--scheduled` | 無人実行モード。対話なし。スケジューラからの呼び出し専用 |
| `--trigger <trigger>` | 実行契機を明示する。`scheduled` は nightly job、`watch` は poll job、`instant` は即時実行、`manual` は手動実行 |
| `--issue <番号>` | 指定 Issue のみ処理(優先度選択をスキップ)。デバッグ・即時修正用 |
| `--dry-run` | Issue 取得・除外フィルタ・優先順位による選択までを実行し、**ワークスペース変更・push・コメントは行わない**。リスク判定は実 diff が必要なため実行しない |
| `--max-issues <N>` | この実行に限り処理上限を上書き |
| `--agent <agent>` | builder-agent へ渡す希望バックエンドを上書き(`claude` または `codex`) |
| `--agent` | この実行に限りエージェントを上書き |

### 終了時の通知(macOS)

`--scheduled` 時、実行完了・失敗時に `osascript` で通知センターに結果サマリを表示する(設定 `report.notification: true` のとき)。

---

## `kaizen fix`

Issue を**即時**に修正する(夜間スケジュールを待たない)。パイプライン・安全装置は `run` と共通で、トリガーと対話性のみが異なる。詳細仕様は [09-instant-run.md](./09-instant-run.md)。

```
kaizen fix <Issue番号>                          # 既存 Issue を即時処理
kaizen fix "<タイトル>" [--body <本文>]          # 起票 + 即時処理
          [--priority P0|P1|P2] [--direct|--pr-only] [--agent claude|codex]
          [--yes] [--wait] [--json]
```

- TTY 実行時は main への直接 push 前に**確認プロンプト**を出す(`--yes` でスキップ)
- 非 TTY 時は `instant.unattendedMode`(デフォルト: PR に切替)に従う
- 夜間実行と同一ロックを共有。実行中なら中止(`--wait` で完了待ち)

Phase 2 で実装する範囲は `kaizen fix <Issue番号>`、`--agent`、`--yes`、`--json`。タイトル指定による起票 + 即時処理と `--wait` は Phase 3 で実装する。

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
- `--metrics`: 累積メトリクス(→ [00-overview.md](./00-overview.md) §6)

朝のルーティンは `kaizen status` → `git pull` → 必要なら PR レビュー、を想定する。

---

## `kaizen enable` / `kaizen disable`

スケジューラ登録の有効化・無効化。`disable` は**キルスイッチ**であり、即座に確実に止まることを最優先とする。

```
kaizen enable [--project <slug>] [--schedule "HH:MM"]
kaizen disable [--project <slug>] [--all]
```

- macOS: plist の `launchctl bootstrap` / `bootout`
- Linux: crontab エントリの追加 / 削除
- `enable` は `.kaizen/config.yml` の `scheduler.nightly` / `scheduler.poll` を読み、nightly と poll をそれぞれ登録する。`--schedule` は nightly の時刻だけを一時上書きする
- `disable --all`: 登録済み全プロジェクトを無効化
- `disable` は実行中の run があれば、ロックファイルの PID に SIGTERM を送って中断させる(中断時の安全性は [07-safety.md](./07-safety.md) §4)

---

## `kaizen logs`

```
kaizen logs [--project <slug>] [--run <timestamp>] [--issue <番号>] [--follow]
```

- 引数なし: 直近の実行の `run.log` を表示
- `--issue`: その Issue のエージェントログ・検証ログを表示
- `--follow`: 実行中の run をテイルする(夜間実行を手動で見守る場合)

---

## `kaizen doctor`

環境診断。`init` の前提検査 + ワークスペースの健全性検査。

```
kaizen doctor [--project <slug>] [--repair]
```

検査項目: git / gh / builder-agent / verifier の存在、Node バージョン、設定ファイルのスキーマ妥当性、ワークスペースの整合性(origin 一致、fetch 可能か)、ロックファイルの stale 検知、スケジューラ登録と registry の整合。

`--repair`: 壊れたワークスペースの再クローン、stale ロックの削除、スケジューラ定義の再生成。

---

## `kaizen list`

```
kaizen list [--json]
```

`~/.kaizen/registry.json` の登録プロジェクト一覧(slug、パス、スケジュール、有効/無効、直近実行結果)を表示する。
