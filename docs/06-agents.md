# 06. エージェントアダプタ仕様

メンテナンスエージェントは **builder-agent** 経由で呼び出す。Kaizen Loop は Claude Code / Codex CLI を直接起動せず、オーケストレータからは `BuilderAgentAdapter` だけを実行する。Claude / Codex の選択情報は builder-agent への希望バックエンドとして渡す。

## 1. 選択ロジック

優先順位(上が優先):

1. Issue ラベル `kaizen:agent:claude` / `kaizen:agent:codex`
2. `kaizen run --agent` オプション
3. 設定 `agent.default`

この選択は `KAIZEN_PREFERRED_AGENT` として builder-agent に渡す。実際のフォールバック可否やモデル選択は builder-agent 側の責務。

`isAvailable()` の判定: `builder.command` に指定されたコマンドが PATH に存在し、軽量疎通(`--version`)できること。

## 2. アダプタごとの実行仕様

> **注意**: 各 CLI のフラグは変化が速い。以下は設計時点の想定であり、実装時には最新ドキュメントに追従する。フラグの組み立てはアダプタ内の 1 関数に集約し、変更に強くする。

### 2.1 BuilderAgentAdapter

```sh
cd <workspaceDir> && builder-agent < prompt
```

- プロンプトは stdin で渡す
- builder-agent は `.kaizen/builder/build-result.json`(設定 `builder.resultPath`)へ構造化結果を書く
- Kaizen Loop は stdout の自己申告ではなく、`build-result.json` を読み取って `AgentResult` に変換する
- `KAIZEN_BUILD_RESULT_PATH`、`KAIZEN_WORKSPACE_DIR`、`KAIZEN_PREFERRED_AGENT`、必要なら `KAIZEN_AGENT_MODEL` を環境変数として渡す
- **push・PR 作成・gh 操作は builder-agent に任せない**。反映はオーケストレータの責務

### 2.2 VerifierAgentAdapter

機械的検証(`commands.verify`)がすべて成功したあと、verifier-agent を呼び出す。

```sh
cd <workspaceDir> && verifier-agent < prompt
```

- verifier-agent は `verifier.resultPath` へ `{ "status": "approved" | "pr_only" | "rejected", ... }` を書く。stdout の最後の JSON もフォールバックとして読む
- `approved` / `pr_only` は PR 作成へ進む。verifier 有効時は直接コミット判定へ進まない
- `rejected` は理由を次の builder-agent プロンプトへ渡し、`run.maxVerifyRetries` の範囲で再修正させる
- `error` / 結果ファイルなしは当該 Issue の失敗扱い

### 2.3 共通の実行制御

- 作業ディレクトリ: 必ずワークスペース(隔離クローン)
- タイムアウト: `issueTimeoutMinutes`。超過時はプロセスグループごと SIGTERM → 10 秒後 SIGKILL
- 環境変数: 最小限に絞る(PATH、HOME、各 CLI の認証に必要なもののみ)。ターゲットプロジェクトの `.env` は**渡さない**
- builder-agent の生ログ(stdout/stderr 全量)を `runs/<ts>/issue-<N>/agent.log` に保存
- verifier-agent の生ログ(stdout/stderr 全量)を `runs/<ts>/issue-<N>/verifier.log` に保存

## 3. プロンプト契約(修正依頼)

オーケストレータがテンプレートから組み立てる。テンプレートは将来 `.kaizen/prompts/fix.md` で上書き可能にする(Phase 2)。

```markdown
あなたは「{repo}」の夜間メンテナンスエージェントです。以下の GitHub Issue を修正してください。

# Issue #{number}: {title}

{body}

## これまでのコメント(あれば)
{comments}

{過去の試行があれば: ## 前回の試行(N 回目)の失敗内容 → 失敗ログ要約}

# 制約(必ず守ること)

1. この Issue の修正だけを行う。無関係なリファクタリング・整形・依存更新はしない
2. 次の禁止パスは変更しない: {forbiddenPaths}
   (必要に見えても、変更せずに最終報告でその旨を説明し status を "blocked" にする)
3. 次の保護パスは必要最小限なら変更してよいが、人間レビューのため必ず PR になる: {protectedPaths}
4. git push・PR 作成・gh コマンドの実行は禁止(反映は別システムが行う)
5. 修正後、`{commands.verify}` が通ることを自分でも確認する
6. 既存のコードスタイル・規約(CLAUDE.md / AGENTS.md があれば従う)を尊重する
7. 修正が完了したら、変更をコミットする。コミットメッセージ: `kaizen: <変更の要約> (#{number})`
8. テストで保護できる修正には、可能な範囲で回帰テストを追加する

# 最終報告(必須)

作業完了後、最後の応答を次の JSON だけにする(コードフェンス付き):

​```json
{
  "status": "fixed" | "partial" | "blocked",
  "summary": "<何をどう直したか。日本語で 3 行以内>",
  "notes": "<レビュアーへの注意点・残課題。なければ空文字>",
  "blockedReason": "<blocked のときのみ: 何が不足しているか>"
}
​```
```

### 再修正プロンプト(検証失敗時)

```markdown
あなたの修正で検証が失敗しました。同じワークスペースで修正を続けてください。

# 失敗したコマンド
{verifyCommand}

# エラー出力(末尾 200 行)
{errorOutput}

(以降、制約・最終報告の指示は初回と同一)
```

## 4. 出力契約のパース

builder-agent の結果は `.kaizen/builder/build-result.json` から読む。

```json
{
  "status": "fixed",
  "summary": "何をどう直したか。日本語で 3 行以内",
  "notes": "",
  "blockedReason": ""
}
```

`status` は `fixed` / `partial` / `blocked`。結果ファイルがない、またはパースできない場合は `error` 扱いにする。

## 5. バックエンド比較

- Kaizen Loop 側のアダプタは builder-agent に固定する
- Claude / Codex の比較は `KAIZEN_PREFERRED_AGENT` と builder-agent 側の実行記録で行う
- `summary.json` の `agent` は `builder` を記録する
