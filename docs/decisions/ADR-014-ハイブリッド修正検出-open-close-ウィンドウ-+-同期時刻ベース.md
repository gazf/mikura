## ADR-014: ハイブリッド修正検出 — open/close ウィンドウ + 同期時刻ベース

**決定**: ファイル変更検出を 2 段階で行う。

1. **第1検出**: open/close ウィンドウ内で `LastWriteTimeUtc` が変化したか
2. **第2検出**: 最後に同期した時刻(`LastSyncedWriteTimes`)より新しい `LastWriteTimeUtc` か

どちらかが真なら `isModified = true` としてアップロード対象にする。

**背景**:

Notepad の `save-to-temp+rename` 保存や autosave は、OPEN/CLOSE のコールバックウィンドウ**外**で書き込みが発生する。第1検出だけでは漏れる。

**実装**:

`SyncContext.LastSyncedWriteTimes`(`ConcurrentDictionary<string, DateTime>`)を追加し:

- FullSync 時にサーバの `lastModified` を記録
- WSS イベント(created/modified)受信時にも記録
- close → `safeToDehydrate=true` の場合に現在の `writeTime` を記録(アップロード成功 or 純粋 read)

これにより、OPEN/CLOSE を伴わない書き込み(rename 保存等)も次回 close 時に拾える。

**選択理由**:

- USN ジャーナルや FileSystemWatcher を使う方法より軽量
- 設計判断として「2 段階検出」がシンプルで理解しやすい
- 実機で Notepad での編集が漏れる症状を直接解決した

---
