## ADR-001: プロトコル選択 — CfApi + HTTPS

**決定**: Windows Cloud Files API(CfApi)+ HTTPS REST API を採用。

**却下した選択肢**:

- **WebDAV**: Microsoft が 2023 年に非推奨化、Windows 10/11 でデフォルト無効、将来削除予定
- **SMB / Samba 拡張**: プロトコル設計古い、Zero Trust と非整合、Windows カーネル実装への依存から脱却不可
- **独自プロトコル**: 既存ツール(curl、ブラウザ等)でデバッグできない

**選択理由**:

- CfApi は OneDrive 級の UX(エクスプローラー統合、オンデマンドハイドレーション)
- HTTPS 単一ポート(443)でファイアウォール・プロキシ越しでも動作
- TLS 1.3 で暗号化、Zero Trust と整合
- モダンな認証(OIDC、JWT)と統合しやすい

---
