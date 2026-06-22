# 12. Scheduler Provider 同期仕様

この文書は、Kaizen Loop の定期実行を Codex Automations、Claude Code routines、launchd、cron、その他外部ツールへ広げるための設計仕様である。

現行実装は `.kaizen/config.yml` の `scheduler.jobs` に定義した任意 job を macOS では launchd、Linux では cron に同期する。`nightly` / `afternoon` / `poll` の旧固定 job 設定は schema で受け付けない。`scheduler.provider` は schema 上は存在するが、現行の `scheduler sync` は OS に応じた launchd / cron 生成だけを行い、Codex Automations / Claude Code routines / external provider adapter は未実装である。

以降の provider adapter、drift 判定、registry binding、Codex Automation 同期例は将来設計であり、現行 CLI の実装済み範囲は §10 に明記する。

## 1. 背景と目的

実行基盤が Codex Automations、Claude Code routines、launchd、cron などに増えると、設定が複数箇所に分散しやすい。

避けたい状態:

- `.kaizen/config.yml` では job が有効だが、外部 automation が作られていない
- Codex Automation は残っているが、Kaizen 側では scheduler が disabled になっている
- job の時刻を変更したが、launchd / cron / automation の実体が古い時刻のまま
- provider を切り替えた後も旧 provider のジョブが残り、同じ Issue を二重処理する
- `nightly` / `afternoon` のような名前に合わないユースケースでも、その名前に合わせて設定を書く必要がある

目的:

- `.kaizen/config.yml` を scheduler の唯一の desired state にする
- job 名・実行時刻・実行ポリシーを任意に定義できるようにする
- Codex Automations、Claude Code routines、launchd、cron などを provider として差し替え可能にする
- `plan` / `sync` / `status` で desired state と actual state の差分を見える化する
- Kaizen が作成した外部ジョブだけを安全に更新・削除する

## 2. 基本方針

| 項目 | 方針 |
|---|---|
| Source of truth | `<repo>/.kaizen/config.yml` |
| ローカル状態 | `~/.kaizen/registry.json` は外部ジョブ ID や同期メタデータのみ保持する |
| 外部実体 | Codex Automation、Claude routine、launchd plist、cron 行など。provider adapter が作成・更新・削除する |
| 同期単位 | project slug + arbitrary job id |
| 実行内容 | provider は Kaizen Loop を起動するだけ。Issue 選択、排他制御、PR 作成、結果コメントは `kaizen run` が担当する |
| 安全性 | Kaizen 管理マーカーがある外部ジョブだけを自動更新・削除する |

## 3. Desired State モデル

現行設定は、固定フィールドではなく `scheduler.jobs` に任意 job を定義する。起動回数は job 数ではなく `schedule` で表現する。たとえば「1日3回」は `everyHours: 8`、「1日12回」は `everyHours: 2` であり、起動回数が増えても Kaizen Loop 本体のコードは変えない。

```yaml
scheduler:
  provider: launchd
  jobs:
    maintenance:
      enabled: true
      schedule:
        type: interval
        everyHours: 8
        anchorTime: "02:45"
      run:
        mode: maintenance
        lateStartGuard: false

    issue-watch:
      enabled: false
      schedule:
        type: interval
        everyMinutes: 5
      run:
        mode: watch
        skipIfRunning: true
```

この形では `maintenance`、`issue-watch` はユーザーが選ぶ任意の job id である。Kaizen Loop は job id の名前に意味を持たせない。同じ run policy を複数時刻で動かしたいだけなら、job を増やさず schedule expression を変える。

### Schedule

schedule は「いつ起動するか」だけを表す。`run` policy とは分離する。

```ts
type SchedulerSchedule =
  | { type: 'interval'; everyMinutes?: number; everyHours?: number; anchorTime?: string }
  | { type: 'times'; times: string[] }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; days: string[]; time: string }
  | { type: 'rrule'; value: string };
```

推奨する使い分け:

| type | 用途 |
|---|---|
| `interval` | 「N分ごと」「N時間ごと」。1日3回なら `everyHours: 8`、1日12回なら `everyHours: 2` |
| `times` | 毎日決まった複数時刻に起動する。例: `["02:00", "10:00", "18:00"]` |
| `daily` | 毎日1回の単純な時刻指定。`times` の要素1個と等価だが読みやすさのため許可する |
| `weekly` | 曜日と時刻を指定する |
| `rrule` | provider で表現できる高度な繰り返し。portable ではない場合があるため、可能なら上記 type を優先する |

例:

```yaml
# 1日3回
schedule:
  type: interval
  everyHours: 8
  anchorTime: "02:45"

# 1日12回
schedule:
  type: interval
  everyHours: 2
  anchorTime: "00:00"

# 時刻を明示した1日3回
schedule:
  type: times
  times: ["02:45", "10:45", "18:45"]
```

`anchorTime` は1日内の起点時刻である。`everyHours: 8` と `anchorTime: "02:45"` は、ローカルタイムで `02:45`, `10:45`, `18:45` に起動する。現行の launchd / cron 実装は、`anchorTime` 付き `everyHours` が24を割り切らない場合は unsupported としてエラーにする。将来の provider-aware `plan` では、provider で正確に表現できない schedule を `unsupported` として報告する。

### Run policy

job が `kaizen run` をどの挙動で起動するかを `run` に定義する。

```ts
type SchedulerRunPolicy =
  | {
      mode: 'maintenance';
      lateStartGuard?: boolean;
      maxIssues?: number;
    }
  | {
      mode: 'watch';
      skipIfRunning?: boolean;
      maxIssues?: number;
    };
```

`mode` の意味:

| mode | 意味 |
|---|---|
| `maintenance` | open Issue を通常の scheduler run として処理する |
| `watch` | 軽量な監視起動。対象 Issue がなければすぐ終了し、重複起動は `skipIfRunning` で抑制できる |

`lateStartGuard` は「予定時刻から大きく遅れて起動した場合にスキップするか」を表す。従来の `nightly` だけに紐づく概念ではなく、job ごとに選べる policy とする。

### 内部正規化モデル

```ts
type SchedulerProviderName =
  | 'launchd'
  | 'cron'
  | 'codex-automation'
  | 'claude-routine'
  | 'external';

interface DesiredSchedulerJob {
  slug: string;
  repo: string;
  localPath: string;
  workspacePath: string;
  provider: SchedulerProviderName;
  id: string;
  enabled: boolean;
  schedule: SchedulerSchedule;
  run: SchedulerRunPolicy;
}
```

## 4. 旧設定からの置き換え

現行 scheduler schema は `scheduler.jobs` に一本化している。`scheduler.nightly` / `scheduler.afternoon` / `scheduler.poll` は読み続けない。

既存プロジェクト向けの migration コマンドは未実装である。必要になった場合は、以下のようなコマンドで `scheduler.jobs` へ書き換える想定とする。

```sh
kaizen migrate scheduler-jobs [--project <slug>] [--write]
```

変換例:

| 旧設定 | 新 job への変換 |
|---|---|
| `scheduler.nightly` + `scheduler.afternoon` | `id: maintenance`, `schedule.type: times`, `times: [nightly.time, afternoon.time]`, `run.mode: maintenance` |
| `scheduler.nightly` のみ | `id: maintenance`, `schedule.type: daily`, `time: nightly.time`, `run.mode: maintenance`, `lateStartGuard: true` |
| `scheduler.poll` | `id: issue-watch`, `schedule.type: interval`, `run.mode: watch`, `skipIfRunning: true` |

移行ルール:

- migration は既存設定を読み、`scheduler.jobs` を生成し、旧フィールドを削除する
- provider 未指定の既存プロジェクトは、macOS なら `launchd`、Linux なら `cron` を migration 時に明示する
- `--schedule <HH:MM>` は固定 job 前提のため、新しい schedule 変更では `kaizen scheduler set-schedule --job <id> ...` または config 編集を使う。現行 CLI の `init --schedule` と `scheduler sync --schedule` は互換用に残っている
- provider-aware scheduler は `scheduler.jobs` がない config をエラーにする

## 5. Provider Adapter

provider は共通 interface を実装する。

```ts
interface SchedulerProvider {
  inspect(slug: string): Promise<ActualSchedulerJob[]>;
  plan(desired: DesiredSchedulerJob[]): Promise<SchedulerPlan>;
  apply(plan: SchedulerPlan): Promise<SchedulerApplyResult>;
  disable(slug: string, options?: { terminateRunning?: boolean }): Promise<SchedulerApplyResult>;
}
```

`inspect` は外部実体を読み、Kaizen 管理マーカーや registry の binding を使って actual state を返す。`plan` は desired と actual の差分を計算する。`apply` は差分を反映する。

### launchd provider

現行の macOS 実装を adapter 化する。

- job ごとに `~/Library/LaunchAgents/com.kaizen-loop.<slug>.<job-id>.plist` を管理する
- `schedule.type: daily` / `times` / `weekly` は `StartCalendarInterval`
- `schedule.type: interval` は `StartInterval`
- `schedule.type: rrule` は launchd で表現できる範囲だけ受け付け、表現できない場合は `plan` で unsupported とする
- `launchctl bootstrap` / `bootout` で有効化・無効化する

### cron provider

現行の Linux 実装を adapter 化する。

- crontab に Kaizen 管理マーカー付きの行を追加する
- `schedule.type: daily` / `times` / `weekly` は cron の時刻指定へ展開する
- `schedule.type: interval` は cron で表現できる範囲へ変換する
- `schedule.type: rrule` は cron で表現できる範囲だけ受け付け、表現できない場合は `plan` で unsupported とする
- Kaizen 管理マーカーが一致する行だけを更新・削除する

### codex-automation provider

Codex Automations を使って Kaizen Loop を実行する provider。job ごとに cron automation を作る。

provider は Codex Automation の id を安定化する。

```text
kaizen-loop-<slug>-<job-id>
```

Codex Automation が任意 metadata を持てない場合は、prompt 内に短い管理マーカーを含める。

```text
Managed by kaizen-loop.
slug: <slug>
job: <job-id>
provider: codex-automation
configHash: <hash>
```

実行 prompt は job id に依存しない。

```text
Run kaizen-loop for project <slug> using scheduler job <job-id>.
Use the registered local project and workspace.
Report the concise run outcome.
```

### claude-routine provider

Claude Code routines を使う将来 provider。Codex Automation provider と同じ desired model を使い、routine 名・schedule・prompt・working directory を同期する。実装時に Claude Code routines の永続化形式に合わせて marker の保存場所を決める。

### external provider

外部ツールや社内スケジューラ向けの将来 escape hatch。Kaizen Loop は直接外部 API を知らず、設定された command / script に desired state JSON を渡す。

```yaml
scheduler:
  provider: external
  external:
    command: "kaizen-scheduler-sync"
  jobs:
    maintenance:
      enabled: true
      schedule:
        type: daily
        time: "02:45"
      run:
        mode: maintenance
```

この `scheduler.external` 設定は現行 schema には存在しない。external command は将来、`inspect` / `plan` / `apply` / `disable` 相当の subcommand を受け取る統合ポイントとして扱う。

## 6. `kaizen run` との接続

provider は最終的に `kaizen run` を起動する。provider 対応後は、job id と run policy を明示して起動できるようにする。

```sh
kaizen run --project <slug> --scheduled --job <job-id>
```

`kaizen run` は registry と config から job を解決し、`run.mode` / `lateStartGuard` / `skipIfRunning` / `maxIssues` を適用する。

provider が生成する外部ジョブは `--trigger` を使わない。実行サマリには `schedulerJob` として job id を記録する。

## 7. Registry Binding

`~/.kaizen/registry.json` は source of truth ではなく、外部実体との紐付けを保存する。

```json
{
  "version": 1,
  "projects": {
    "kaizen-agents-org-kaizen-loop": {
      "repo": "kaizen-agents-org/kaizen-loop",
      "localPath": "/Volumes/SSD/ghq/github.com/kaizen-agents-org/kaizen-loop",
      "workspacePath": "/Users/me/.kaizen/workspaces/kaizen-agents-org-kaizen-loop",
      "scheduler": {
        "provider": "codex-automation",
        "managedJobs": {
          "maintenance": {
            "externalId": "kaizen-loop-kaizen-agents-org-kaizen-loop-maintenance",
            "lastSyncedAt": "2026-06-22T02:45:00+09:00",
            "configHash": "abc123"
          }
        }
      }
    }
  }
}
```

provider 対応後、registry は scheduler の desired state を持たない。`scheduler.managedJobs` は外部実体の binding だけを表す。

## 8. 管理マーカーと config hash

外部実体には Kaizen 管理対象であることを示す marker を入れる。

必須情報:

- `managedBy: kaizen-loop`
- `slug`
- `job`
- `provider`
- `configHash`

`configHash` は provider に渡す desired job の正規化 JSON から計算する。外部実体の marker hash と現在の config hash が異なる場合、`plan` は update または drift として扱う。

marker の保存場所:

| provider | 保存場所 |
|---|---|
| launchd | plist label / file path / XML comment または registry binding |
| cron | marker comment |
| codex-automation | automation id、name、prompt 内 marker |
| claude-routine | routine metadata、description、prompt 内 marker |
| external | 外部 provider の metadata |

## 9. 差分判定

この節は provider-aware scheduler の将来設計である。現行の `kaizen scheduler plan` は external actual state や drift を読まず、`sync` が登録対象にする desired job だけを表示する。

`kaizen scheduler plan` は desired state と actual state を比較し、次の action を出す。

| 状態 | action |
|---|---|
| desired enabled だが actual がない | `create` |
| desired enabled で actual はあるが schedule / prompt / command / hash が違う | `update` |
| desired disabled で actual がある | `disable` または `delete` |
| actual があるが registry binding がない。ただし Kaizen marker はある | `adoptable` |
| actual があるが marker がない | `unmanaged` |
| actual hash が registry hash と異なり、外部で手編集された可能性がある | `drift` |
| provider が変更された | old provider の `disable` + new provider の `create` |

drift の扱い:

- `sync` は通常、`drift` を上書きしない
- `sync --force` は drift を desired state で上書きする
- `adopt` は Kaizen marker がある既存外部ジョブを registry に取り込む
- marker がない unmanaged job は自動変更しない

## 10. CLI

現行実装済みの scheduler コマンド:

```sh
kaizen scheduler status [--project <slug>] [--json]
kaizen scheduler plan [--project <slug>] [--json]
kaizen scheduler sync [--project <slug>] [--schedule <HH:MM>] [--json]
kaizen scheduler set-schedule --job <job-id> [--project <slug>] (--daily <HH:MM> | --times <HH:MM,...> | --every-hours <N> [--anchor-time <HH:MM>] | --every-minutes <N>) [--json]
kaizen scheduler disable [--project <slug>] [--all] [--json]
```

役割:

| コマンド | 役割 |
|---|---|
| `status` | config 上の enabled job、local registry の有効状態、既定 provider 名を表示する |
| `plan` | `sync` が登録対象にする desired job を表示し、変更はしない |
| `sync` | config に合わせて launchd plist または cron 行を作成・更新する |
| `set-schedule` | job の schedule expression を変更する |
| `disable` | Kaizen 管理ジョブを無効化する |

`kaizen enable` / `kaizen disable` は互換用エイリアスとして残っており、内部では同じ launchd / cron 同期・解除処理を呼ぶ。ユーザー向けの新しい scheduler 操作は `kaizen scheduler ...` に統一する。

provider-aware scheduler で追加予定のコマンド:

```sh
kaizen scheduler sync [--project <slug>] [--force] [--json]
kaizen scheduler adopt [--project <slug>] [--provider <provider>] [--json]
```

`--force` は drift 上書き、`adopt` は Kaizen marker がある既存外部ジョブの registry binding 取り込みに使う想定で、現行 CLI には未実装である。

## 11. Codex Automation 同期例

設定:

```yaml
scheduler:
  provider: codex-automation
  jobs:
    maintenance:
      enabled: true
      schedule:
        type: interval
        everyHours: 8
        anchorTime: "02:45"
      run:
        mode: maintenance
        lateStartGuard: false
```

`kaizen scheduler plan` の例:

```json
{
  "slug": "kaizen-agents-org-kaizen-loop",
  "provider": "codex-automation",
  "actions": [
    {
      "action": "create",
      "job": "maintenance",
      "externalId": "kaizen-loop-kaizen-agents-org-kaizen-loop-maintenance",
      "cron": "45 2,10,18 * * *"
    }
  ]
}
```

1日12回に変える場合は、同じ job の schedule だけを変更する。

```yaml
scheduler:
  provider: codex-automation
  jobs:
    maintenance:
      enabled: true
      schedule:
        type: interval
        everyHours: 2
        anchorTime: "00:00"
      run:
        mode: maintenance
        lateStartGuard: false
```

時刻を固定したい場合は `times` を使う。

```yaml
schedule:
  type: times
  times: ["00:00", "02:00", "04:00", "06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"]
```

Codex Automation は job 実行基盤であり、Issue 選択、排他制御、PR 作成、結果コメントは従来どおり Kaizen Loop 本体が行う。

## 12. 移行計画

1. 完了: `scheduler.jobs` の設定仕様を schema に追加する
2. 完了: `kaizen run --job <job-id>` を追加し、job ごとの run policy を適用する
3. 完了: `kaizen scheduler status` / `plan` / `sync` / `set-schedule` / `disable` を launchd / cron 向けに実装する
4. 未実装: `kaizen migrate scheduler-jobs` を実装し、旧 scheduler 設定を `jobs` へ書き換えられるようにする
5. 未実装: provider-aware `plan` で既存 launchd / cron / Codex Automation の actual state と drift を可視化する
6. 未実装: `codex-automation` provider の `sync` を実装する
7. 未実装: `launchd` / `cron` の既存実装を provider adapter へ移す
8. 未実装: `kaizen enable` / `disable` を互換 alias として残しつつ、ユーザー向け導線を `kaizen scheduler sync` / `disable` に統一する
9. 未実装: `adopt` で既存 Codex Automation を registry binding に取り込めるようにする
10. 未実装: Claude Code routines provider を、永続化 API / ファイル形式が確定した時点で追加する
11. 未実装: `doctor` に provider drift チェックを追加する

## 13. 非目標

- `nightly` / `afternoon` / `poll` を scheduler 設定インターフェイスとして残すこと
- Codex Automation、Claude routine、launchd、cron を同時に正として扱うこと
- marker のない外部ジョブを自動削除すること
- provider ごとの認証情報を Kaizen Loop が保持すること
- scheduled run の処理内容を provider に分散すること。provider は起動だけを担当し、処理本体は `kaizen run` が担当する
