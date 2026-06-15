## ADR-013: プレースホルダー戦略 — ALWAYS_FULL + WSS イベント駆動

**決定**: 起動時に `/tree` で全ツリーを取得し、`CF_POPULATION_POLICY_ALWAYS_FULL` でプレースホルダーを一括作成、WSS で差分プッシュ受信する。

**却下した選択肢**:

- **PARTIAL + FETCH_PLACEHOLDERS によるオンデマンド**: ディレクトリ展開時のレイテンシで Explorer が固まる、UX が劣る
- **ポーリングベースの差分同期**: WSS のリアルタイム性が出ない、サーバー負荷が高い

**選択理由**:

- エクスプローラー操作が即座に反応する(オフラインファイルと同じ感覚)
- WSS で他クライアントの変更がリアルタイム反映
- 実機検証で UX が劇的に改善することを確認

**実装上の知見(実機検証由来)**:

- ALWAYS_FULL でも OS が `FETCH_PLACEHOLDERS` を送ることがあるため、空リストで即答するハンドラーを残す必要あり
- 再起動時に `CfCreatePlaceholders` が `ERROR_ALREADY_EXISTS (0x800700B7)` を返すのは正常動作として扱う
- WSS は Deno が `for await` ループ break 時に watcher を自動クローズするので、`onclose` での `watcher.close()` は二重クローズになる。`closeWatcher` ガードで防ぐ
- 起動時の `CreatePlaceholders` だけでは Explorer に表示されない。`SHCNE_UPDATEDIR` を打って再列挙を促す必要あり

**スケーラビリティの制約**:

- 数万ファイル超える場合、起動時の `/tree` 取得と `CreatePlaceholders` に時間がかかる
- 現実的上限は 10万ファイル程度
- それ以上のスケールが必要になったら、ルート直下のみ ALWAYS_FULL、サブディレクトリは PARTIAL のハイブリッド戦略へ移行を検討

**フォールバック / 再接続**:

- WSS 切断時は 5 秒バックオフで自動再接続(`RunEventLoopWithReconnectAsync`)
- イベント取りこぼし時は手動の `OnSyncNow` で全同期回復

**関連 ADR**:

- ADR-006(イベント通知): 本決定で WSS を正式採用

---
