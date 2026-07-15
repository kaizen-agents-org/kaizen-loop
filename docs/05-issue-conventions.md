# 05. Issue 規約

Kaizen Loop は GitHub Issues を「改善のキュー」として使う。本ドキュメントはラベル体系・テンプレート・ライフサイクルを定める。

## 1. ラベル体系

`kaizen init` がすべて作成する(冪等)。

### 対象識別

| ラベル | 意味 |
|---|---|
| `kaizen` | **必須**。夜間メンテナンスの処理対象であることを示す。これが無い Issue には一切触れない |

### 優先度(任意・排他)

| ラベル | 意味 | 目安 |
|---|---|---|
| `kaizen:P0` | 最優先 | 利用がブロックされる・データを壊す |
| `kaizen:P1` | 高 | 主要機能の不具合・毎回遭遇する不便 |
| `kaizen:P2` | 通常(省略時のデフォルト扱い) | 軽微な不具合・改善・ドキュメント |

### 反映ポリシー指定(任意・排他)

| ラベル | 意味 |
|---|---|
| `kaizen:direct` | 検証が通れば直接コミットしてよい、という登録者の意思表示(保護パス・検証パスの要件は免除されない) |
| `kaizen:pr-only` | 必ず PR にする(機械判定より優先) |

### エージェント指定(任意・排他)

| ラベル | 意味 |
|---|---|
| `kaizen:agent:claude` | builder-agent へ Claude を希望バックエンドとして渡す |
| `kaizen:agent:codex` | builder-agent へ Codex を希望バックエンドとして渡す |

### 即時実行トリガー(任意)

| ラベル | 意味 |
|---|---|
| `kaizen:now` | Phase 4 予定の `kaizen watch` 常駐モード(→ [09-instant-run.md](./09-instant-run.md) §3.4)が検知して即時処理する。現行 CLI では自動処理されない |

### Goal 連携(オーケストレータが管理)

| ラベル | 意味 |
|---|---|
| `kaizen:goal` | `kaizen goal run` が作成した Goal-linked Issue。本文の `kaizen-loop:goal` marker で Goal state と紐づく |

### primary disposition(オーケストレータが管理)

primary disposition は次のうち最大 1 つだけを付ける。`kaizen:needs-human` の不変条件は、**現在未回答の具体的な人間向け確認がある場合に限って存在する**ことである。一般的な失敗、試行上限、上流作業、PR Guardian、checkpoint 復旧には使用しない。

| ラベル | 付与者 | 意味 |
|---|---|---|
| `kaizen:needs-human` | オーケストレータ | 構造化 `humanRequest` による未回答の質問・承認依頼。回答または承認後に人間が外す。解除は同一 request の acknowledgement として記録され、同じ request では再付与しない |
| `kaizen:retryable` | オーケストレータ | timeout、rate limit、実行ホスト欠落など一時的な外部障害。scheduled 実行で自動再試行し、連続 retry budget 枯渇時は `kaizen:attempts-exhausted` へ遷移 |
| `kaizen:blocked` | オーケストレータ | 自動処理が技術的・状態的理由で続行不能。人間への質問を意味しない。原因を解消して再試行する場合はこのラベルを外す |
| `kaizen:upstream-first` | オーケストレータ | source-of-truth / upstream の変更が先。上流対応完了後、再評価する場合に外す |
| `kaizen:not-actionable` | オーケストレータ | 現在の Issue は安全な改善として実行不能。内容を実質的に修正して再評価する場合に外す |
| `kaizen:attempts-exhausted` | オーケストレータ | 自動試行 budget 枯渇。原因と retry 方針を確認し、明示的に 1 回再試行する場合に外す。過去の attempt 履歴だけでは再選択を妨げず、再失敗時はラベルを再付与する |

`kaizen:in-progress` は primary disposition ではなく実行中を示す lifecycle ラベルである。処理開始時に既存 disposition をクリアし、終了時に結果に対応する disposition へ遷移する。24h 超で stale 扱いとする。

#### human request acknowledgement protocol

1. オーケストレータは versioned `kaizen-loop:human-request` marker をコメントし、同じ request fingerprint と `pending` state を保存してから `kaizen:needs-human` を付ける。
2. request fingerprint は構造化 `reasonCode` と安定した lowercase `requestKey` から作る。質問の言い換えでは同じ key を保ち、別の意思決定だけ新しい key にする。自由文の blocked reason や表示用質問文だけでは human request に分類しない。
3. `pending` marker の後にラベルが実際に付与され、さらに人間が外した timeline がある場合だけ `acknowledged` とする。marker 書き込みまたはラベル付与の失敗を承認と誤認しない。自動化は PR merge、Issue close、別 disposition への遷移を理由にこのラベルを外さない。
4. acknowledged 済みの同一 request は再付与しない。別の reason / 質問は別 request として新たに確認できる。
5. 旧形式コメントや、protocol 導入前からラベルが無いことは acknowledgement とみなさない。

generic disposition 遷移、PR merge、Issue close は pending な `kaizen:needs-human` を外さない。自動化による削除を許すのは、人間の解除と stale run の再付与が競合した際に、人間の解除状態を復元する場合だけである。ラベル付与の直前・直後にも timeline を再取得し、人間の解除を優先する。

## 2. Issue テンプレート

`kaizen init` が `.github/ISSUE_TEMPLATE/kaizen.yml` を生成する。GitHub の Web UI から登録する場合のフォーム。

```yaml
name: "🔄 Kaizen(改善依頼)"
description: 夜間メンテナンスエージェントに修正・改善を依頼する
labels: ["kaizen"]
body:
  - type: textarea
    id: problem
    attributes:
      label: 問題 / 改善したいこと
      description: 何が起きたか・何が不便か。エラーメッセージはそのまま貼る
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: 再現手順
      description: 実行したコマンド・操作。再現できないと夜間エージェントは修正を断念しやすい
      placeholder: |
        1. `kaizen status --json` を実行
        2. ...
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: 期待する動作
    validations:
      required: true
  - type: textarea
    id: scope
    attributes:
      label: 関係しそうな場所(任意)
      description: ファイル名・関数名・ログなど、わかる範囲で。夜間エージェントの調査時間を大きく節約できる
  - type: dropdown
    id: priority
    attributes:
      label: 優先度
      options: ["P2(通常)", "P1(高)", "P0(最優先)"]
      default: 0
```

> dropdown の優先度はテンプレートでは本文に残るだけなので、`kaizen report --priority` か手動ラベル付けを正とする。Web UI からの登録を主経路にする場合は GitHub Actions でのラベル自動付与を Phase 3 で検討(→ [08-roadmap.md](./08-roadmap.md))。

## 3. 良い Kaizen Issue の条件(利用側 AI への指示にも使う)

夜間エージェントは登録者に質問できない(非同期・無人)。したがって Issue は**単独で行動可能(self-contained & actionable)**である必要がある:

1. **再現手順が具体的**: コマンド・入力・環境
2. **期待と実際のギャップが明確**
3. **スコープが 1 つ**: 複数の問題は複数の Issue に分ける(1 Issue = 1 修正 = 1 コミット/PR)
4. **手がかりがある**: エラーメッセージ全文、関係するファイル名

利用側 AI エージェントが `kaizen report` で登録する際は、上記を満たす本文を生成すること(ターゲットプロジェクトの CLAUDE.md / AGENTS.md にこの規約を記載することを推奨。`kaizen init` が追記を提案する)。

## 4. Issue ライフサイクル

```mermaid
stateDiagram-v2
    [*] --> Open: 登録(kaizen ラベル)
    Open --> InProgress: 夜間実行が選択<br/>(kaizen:in-progress 付与)
    InProgress --> Closed: 直接コミット成功<br/>(結果コメント + クローズ)
    InProgress --> PRWaiting: PR 作成<br/>(in-progress 剥がし)
    PRWaiting --> Closed: 人間が PR マージ<br/>(Closes #N で自動クローズ)
    PRWaiting --> Open: 人間が PR クローズ<br/>(コメントで差し戻し理由を書く)
    InProgress --> Retryable: 一時的外部障害<br/>(kaizen:retryable)
    Retryable --> InProgress: scheduled retry
    Retryable --> AttemptsExhausted: retry budget 枯渇
    InProgress --> Blocked: 自動処理続行不能<br/>(kaizen:blocked)
    InProgress --> NeedsHuman: 具体的な確認要求<br/>(kaizen:needs-human)
    NeedsHuman --> Open: 人間が回答・承認 +<br/>needs-human を外す
    InProgress --> UpstreamFirst: 上流対応が先
    InProgress --> NotActionable: 現在は実行不能
    Blocked --> Open: blocker 解消 +<br/>blocked を外す
    AttemptsExhausted --> Open: retry 方針確認 +<br/>attempts-exhausted を外す
    UpstreamFirst --> Open: 上流対応完了 +<br/>upstream-first を外す
    NotActionable --> Open: Issue を実質修正 +<br/>not-actionable を外す
    InProgress --> Open: stale 回復<br/>(24h 超の in-progress)
```

`InProgress --> Open` と `InProgress --> NeedsHuman` では、安全な Issue branch と実装 checkpoint を保持する。各 terminal disposition は表に記載した条件を満たして人間が対応ラベルを外すと `Open` に戻り、次の選択で `InProgress` へ遷移する。再選択後は同じ branch を新しい worktree に接続し、直近の失敗理由を builder-agent へ渡して途中から再開する。`forbiddenPaths` を含む変更は保持せず、checkpoint branch が消失している場合は `recovery-needed` として人間へ handoff する。PR 作成後は durable guardian job が merge-ready になるまで担当する。

途中 diff がある場合は draft PR も作成する。ユーザーは draft PR の description で停止理由・検証状況・残作業を確認でき、`kaizen status` の `implementations.items` では phase、branch、attempt、最終更新、blocker、PR URL を確認できる。24 時間以上更新されていない非終端状態は `implementations.stale` に数える。

### 人間の関与ポイント(まとめ)

| 状況 | 人間がやること |
|---|---|
| PR ができている | レビューしてマージ(またはクローズ + 理由コメント) |
| `kaizen:needs-human` | コメントの具体的な質問に回答または承認し、ラベルを外す。解除は同一 request への回答として永続化される |
| `kaizen:blocked` / `kaizen:attempts-exhausted` | blocker と retry 方針を確認し、再試行するときだけ該当ラベルを外す |
| `kaizen:upstream-first` | 上流対応を完了してからラベルを外す |
| `kaizen:not-actionable` | Issue を実質的に修正し、再評価するときにラベルを外す |
| 直接コミットに問題があった | revert し、当該 Issue を `kaizen:pr-only` 付きで再オープン |

## 5. AI(利用側)からの登録経路

```sh
# 推奨: kaizen report(ラベル・書式が保証される)。登録だけなら queued 実行許可は付けない
echo "$STRUCTURED_BODY" | kaizen report "<タイトル>" --body-file - --priority P1 --json

# queued 実行に載せる場合は明示する
kaizen queue <Issue番号>

# 代替: gh CLI 直接(kaizen ラベルを必ず付けること。opt-in 運用で実行許可するなら kaizen:ready も付ける)
gh issue create --label kaizen --title "..." --body "..."
```

`kaizen` は Kaizen 管理対象であることを示す。`issues.selection.mode: opt-in` の場合、scheduled / backlog 実行に載せるには `issues.selection.includeLabel`(デフォルト `kaizen:ready`)が別途必要。Issue 登録 skill は、ユーザが「queue」「実行して」「kaizen-loop に載せて」と明示した場合だけ ready label を付ける。
