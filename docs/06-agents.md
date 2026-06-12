# 06. エージェントアダプタ仕様

メンテナンスエージェントとして **Claude Code** と **Codex CLI** の両方をサポートする。オーケストレータからは共通インターフェース(`AgentAdapter`、→ [01-architecture.md](./01-architecture.md) §2.3)越しに扱い、CLI ごとの差異はアダプタ内に閉じ込める。

## 1. 選択ロジック

優先順位(上が優先):

1. Issue ラベル `kaizen:agent:claude` / `kaizen:agent:codex`
2. `kaizen run --agent` オプション
3. 設定 `agent.default`
4. `agent.fallback: true` のとき、上記が利用不可なら他方へフォールバック(その旨を Issue コメントと `summary.json` に記録)

`isAvailable()` の判定: CLI バイナリが PATH に存在し、かつ認証済みであること(`claude` は `claude -p "ok" --max-turns 1` 相当の軽量疎通、`codex` は `codex login status` 相当。実装時に各 CLI の最新の確認手段に追従する)。

## 2. アダプタごとの実行仕様

> **注意**: 各 CLI のフラグは変化が速い。以下は設計時点の想定であり、実装時には最新ドキュメントに追従する。フラグの組み立てはアダプタ内の 1 関数に集約し、変更に強くする。

### 2.1 ClaudeCodeAdapter

```sh
cd <workspaceDir> && claude -p "<prompt>" \
  --output-format json \
  --permission-mode acceptEdits \
  --allowedTools "Bash(git add:*) Bash(git commit:*) Bash(npm:*) Read Write Edit Glob Grep" \
  [--model <agent.model.claude>]
```

- `--output-format json` の `result` フィールドから最終応答を取得し、出力契約(§4)の JSON を抽出する
- **push・PR 作成・gh 操作はツール許可に含めない**(反映はオーケストレータの責務。エージェントには物理的に不可能にする)
- ワークスペースは隔離クローンなので `acceptEdits` で十分。`bypassPermissions` は使わない(Bash 全許可を避ける)

### 2.2 CodexAdapter

```sh
cd <workspaceDir> && codex exec "<prompt>" \
  --sandbox workspace-write \
  --json \
  [--model <agent.model.codex>]
```

- `--sandbox workspace-write` でワークスペース外への書き込みとネットワークを制限する
- JSON イベントストリームから最終メッセージを取得し、出力契約の JSON を抽出する
- Codex はデフォルトでコミットを行わない場合があるため、プロンプトでコミットまでを明示的に指示し、未コミットならオーケストレータが回収コミットする(→ [04-nightly-pipeline.md](./04-nightly-pipeline.md) §4)

### 2.3 共通の実行制御

- 作業ディレクトリ: 必ずワークスペース(隔離クローン)
- タイムアウト: `issueTimeoutMinutes`。超過時はプロセスグループごと SIGTERM → 10 秒後 SIGKILL
- 環境変数: 最小限に絞る(PATH、HOME、各 CLI の認証に必要なもののみ)。ターゲットプロジェクトの `.env` は**渡さない**
- 生ログ(stdout/stderr 全量)を `runs/<ts>/issue-<N>/agent.log` に保存

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

1. エージェントの最終応答から最後の JSON コードブロックを抽出してパース
2. パース失敗 / `status` 欠落の場合: ワークスペースの実際の diff を確認し、
   - diff があり検証が通る → `status: "fixed"`, `summary: "(エージェント報告のパースに失敗。diff から自動生成)"` として続行(**実際のコードの状態を正とする**)
   - diff がない → `error` 扱い(失敗処理へ)
3. `status` と実際の diff が矛盾する場合(`fixed` なのに diff なし等)も実際の状態を正とする

## 5. エージェント間の公平性と比較

- どちらのアダプタにも同一のプロンプト契約・制約・検証を適用する
- `summary.json` にエージェント名を記録するため、`kaizen status --metrics` でエージェント別の成功率・所要時間を比較できる(ドッグフーディングの一環として、どちらが自プロジェクトに向くかをデータで判断する)
