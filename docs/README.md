# Kaizen Loop 仕様書

Kaizen Loop は、対象プロジェクトに「日中ドッグフーディング → 問題を Issue 登録 → 夜間に AI メンテナンスエージェントが自動改善 → 翌朝には最新の状態」という自己改善ループを仕込む CLI ツールである。

## ドキュメント構成

| ドキュメント | 内容 |
|---|---|
| [00-overview.md](./00-overview.md) | コンセプト、ゴール、ループのライフサイクル、用語定義 |
| [01-architecture.md](./01-architecture.md) | 全体構成、コンポーネント、ワークスペースモデル |
| [02-cli-spec.md](./02-cli-spec.md) | CLI コマンド仕様 |
| [03-config-spec.md](./03-config-spec.md) | 設定ファイル仕様(リポジトリ設定・ローカル状態) |
| [04-nightly-pipeline.md](./04-nightly-pipeline.md) | 夜間メンテナンスパイプラインの詳細フロー |
| [05-issue-conventions.md](./05-issue-conventions.md) | ラベル体系、Issue テンプレート、Issue ライフサイクル |
| [06-agents.md](./06-agents.md) | builder-agent / verifier アダプタ仕様、プロンプト契約 |
| [07-safety.md](./07-safety.md) | ガードレール、失敗モード、キルスイッチ |
| [08-roadmap.md](./08-roadmap.md) | 実装フェーズ計画 |
| [09-instant-run.md](./09-instant-run.md) | 即時改善実行(`kaizen fix` / `report --now` / `watch`) |

## 確定済みの設計方針

| 項目 | 決定 |
|---|---|
| Issue 管理 | GitHub Issues(`kaizen` ラベルで対象を識別) |
| 実行基盤 | ローカルマシン(macOS: launchd / Linux: cron) |
| AI エージェント | builder-agent 経由で修正し、verifier で追加レビュー |
| 改善の反映 | ハイブリッド — 低リスクは main 直接コミット、高リスクは PR。ラベルで強制指定可 |
| ツール形態 | Node.js (TypeScript) 製 CLI。`npx kaizen-loop` で利用 |
| 作業場所 | 開発者の作業ツリーとは分離した専用クローン(`~/.kaizen/workspaces/`) |
