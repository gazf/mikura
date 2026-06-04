# Architecture Decision Records

実装に大きな影響を与える設計判断を、決定事項・選択肢・選択理由を残す形で記録する。

---

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

## ADR-002: Vanara.PInvoke.CldApi の不採用

**決定**: Vanara ライブラリを使わず、P/Invoke を自前実装する。

**却下理由**:

- ホットパスで `PinnedObject` + `Marshal.PtrToStructure` のヒープアロケが発生
- `DllImport` ベースで、`LibraryImport` や `UnmanagedCallersOnly` の利点を享受できない
- リフレクションベースのマーシャラで Native AOT に非対応
- 使わない数百関数がアセンブリに含まれる

**採用した代替**:

自前の `CfApi.Native` レイヤー。`LibraryImport`、`readonly struct`、関数ポインタ(`delegate* unmanaged`)、`Pack = 8` 明示等、モダン C# の機能をフル活用。

---

## ADR-003: レイヤー構造 — 5 層

**決定**: Native / Interop / Core / Transport / App の 5 層構造。

**各層の責務**:

- **CfApi.Native**: Win32 CfApi の P/Invoke 写像のみ。ビジネスロジックを持たない
- **CfApi.Interop**: Native 型と Domain 型の翻訳、コールバックディスパッチ。Native 型を外に漏らさない
- **Mikura.Core**: ドメインロジック、ユースケース、抽象インターフェース(`IMikuraServer`、`IEventStream` 等)
- **Mikura.Transport**: HTTP / WSS / SSE 等の通信実装
- **Mikura.App**: WinForms UI、設定、DI 組み立て、エントリポイント

**依存方向**:

```
Native ← Interop ← Core ← App
                    ↓
                 Transport → Deno Server
```

**選択理由**:

- 責務が明確、Clean Architecture 準拠
- Core は CfApi/HTTP の具体実装を知らない(テスト容易、移植容易)
- 将来の CLI / Web UI 追加時に Core / Transport を再利用可能

---

## ADR-004: オフライン時の挙動 — 読み取り専用または使用不可

**決定**: オフライン時は編集不可。環境に応じて「読み取り専用」または「使用不可」を選ぶ。

**却下した選択肢**:

- **オフライン編集 + 復帰時コンフリクト解決**: Nextcloud / OneDrive 的なアプローチ。コンフリクト発生源、UX を損なう

**選択理由**:

- コンフリクトを原理的に発生させない
- 監査・コンプライアンスがクリーン
- 実装が大幅にシンプル(UploadQueue、ConflictResolver が不要)
- 社内ファイルサーバー代替として妥当な割り切り

**実装方針**:

- ネットワーク状態監視
- オフライン時は FETCH_DATA で `STATUS_CLOUD_FILE_NETWORK_UNAVAILABLE` を返す
- タスクトレイで状態表示

---

## ADR-005: コンフリクト解決 — サーバー側ロック(初版)

**決定(初版)**: ファイル open 時にサーバー側ロックを取得、close + アップロード完了後に解放する。

**排他制御の 3 層**:

1. 論理ロック(サーバー側 KV): 他ユーザーへの編集中通知
2. ETag / If-Match(HTTP): ロック漏れの保険、並行 PUT を防ぐ
3. atomic rename(ファイルシステム): 書き込み中の中途半端なデータを他ユーザーから隠す

**現状**:

本 ADR は Phase 5 実装中に再評価され、**ADR-016 / ADR-018 で更新**された。SID ベース Liveness 管理 + コンフリクトファイル戦略(ADR-017)を採用している。

**関連 ADR**: ADR-016, ADR-017, ADR-018

---

## ADR-006: イベント通知 — WebSocket(WSS)採用

**決定**: WebSocket(WSS)で差分イベントをサーバーからプッシュ受信する。

**却下した選択肢**:

- **ポーリング**: リアルタイム性が出ない、サーバー負荷が高い
- **SSE 単独**: サーバーからの一方向のみ、双方向通信ができない

**SSE を補助に残す可能性**:

Cloudflare Tunnel 環境で WSS のアイドルタイムアウト(Free/Pro で 100 秒)が問題になる場合、SSE フォールバックを検討。現時点では WSS のみで実装。

**選択理由**:

- リアルタイム差分受信が可能
- 双方向通信(将来 ADR-018 のハートビート等)に活用可能
- 標準的なプロトコル、デバッグ容易

**関連 ADR**: ADR-013(本決定で WSS を正式採用), ADR-018(WSS で SID ハートビートを送る)

---

## ADR-007: 認証 — OIDC + JWT

**決定**: LDAP / Kerberos を使わず、OIDC(OpenID Connect)経由で認証、JWT で認可。

**選択理由**:

- Google Workspace、Microsoft 365、Okta、Keycloak 等と直接統合可能
- MFA 標準対応
- JWT で HTTP / WebSocket 両方に同じ認証機構
- ステートレス、スケール容易

**JWT クレーム設計**:

```json
{
  "sub": "user-id",
  "device_id": "laptop-abc123",
  "iat": 1234567890,
  "exp": 1234571490
}
```

短命(1 時間)+ リフレッシュトークン。デバイス ID も含め Zero Trust 対応。

---

## ADR-008: 権限モデル — パス + プリンシパル × アクション

**決定**: 「ユーザー / グループ」×「パス」×「read / write / admin」の細粒度認可。

**Deno KV スキーマ**:

```
["users", userId]                   → { id, name, email, groups }
["groups", groupId]                 → { id, name, members }
["permissions", path, type, id]     → { path, principal, access }
```

**アクセスチェック**:

- パスの親階層まで遡って判定
- ユーザー自身 + 所属グループの権限をチェック
- いずれかで許可があれば OK

---

## ADR-009: Zero Alloc の適用範囲

**決定**: モダン C# の機能は活用するが、過剰な最適化は避ける。

**適用する**:

- `LibraryImport` による source-generated マーシャラ
- 構造体の `readonly struct` 化
- 関数ポインタ(`delegate* unmanaged<>`)、Delegate 不使用
- `UnmanagedCallersOnly` コールバック
- ホットパスの `stackalloc` + `ArrayPool<T>` ハイブリッド

**適用しない(現時点)**:

- `ValueTask` 化(async 境界でメリット薄い)
- `PoolingAsyncValueTaskMethodBuilder`(効果が測れていない)
- カスタム `IValueTaskSource` 実装(オーバーエンジニアリング)
- UniTask 等の外部ライブラリ(標準機能で足りる)

**判断基準**: ボトルネックになってから最適化する。それまでは可読性・保守性優先。

---

## ADR-010: HTTP/2 の採用(将来)

**決定**: サーバー・クライアント両方で HTTP/2 を有効化する(Phase 5 完了後に実装)。

**理由**:

- `HttpClient` の設定で簡単に有効化可能
- ヘッダ圧縮(HPACK)で認証トークン繰り返しのオーバーヘッド削減
- 多重化でメタデータ取得の並列化
- HTTP/1.1 フォールバック自動対応

**HTTP/3 は見送り**:

- Deno、.NET 両方で実装が若い
- UDP 443 の企業ファイアウォール通過性に懸念

---

## ADR-011: テスト戦略

**決定**: サーバー側はインメモリ KV を使ったユニットテスト、クライアント側は実機テスト中心。

**サーバー側**:

- Deno 標準テスト + `:memory:` KV で独立テスト
- CI で `deno task test` を回す

**クライアント側**:

- Domain 層(Mikura.Core)はモック化してユニットテスト可能
- Interop 層以下は実機テスト必須(CfApi が Windows カーネル依存)
- E2E: Windows 実機で Explorer から操作確認

---

## ADR-012: OpenAPI / TypeSpec の不採用(現時点)

**決定**: API スキーマ定義ファイル(OpenAPI、TypeSpec)は現時点では導入しない。

**却下理由**:

- API がまだ流動的、スキーマ定義のメンテコストが高い
- AI によるコード生成で型合わせが可能
- 手書き OpenAPI の価値は激減

**将来採用する条件**:

- API が安定してきた
- 他言語クライアント(macOS、iOS、Web)を作る予定が出てきた
- エンタープライズ顧客から仕様書提出を求められる

---

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

## ADR-015: oplock ハンドル開閉戦略

**決定**: `SetInSyncState` / `UpdatePlaceholder` のたびに `OplockFileHandle` を開閉する。ハンドルを保持し続けない。

**背景(実機で詰まった経緯)**:

書き戻しフローで「open + state 変更 + read + アップロード + state 変更 + close」を試みたところ、以下の問題が連鎖的に発生:

1. `CfOpenFileWithOplock` の handle は overlapped で開かれている
2. `FileStream` で読もうとすると:
   - `isAsync: true` → "BindHandle for ThreadPool failed"(CfApi が内部で完了ポートに bind 済み、再 bind 不可)
   - `isAsync: false` → "Handle does not support synchronous operations"
3. ハンドル保持中は `File.OpenRead` もシェアバイオレーション

**解決**: state 変更のたびに開閉する戦略

```csharp
using (var handle = OplockFileHandle.Open(localPath, OplockOpenFlags.WriteAccess))
    handle.SetInSyncState(false);

await using var stream = File.OpenRead(localPath);
await UploadAsync(stream);

using (var handle = OplockFileHandle.Open(localPath, OplockOpenFlags.WriteAccess))
{
    handle.UpdatePlaceholder(...);
    handle.SetInSyncState(true);
}
```

**残るレース**: `SetInSyncState(false)` と `File.OpenRead` の隙間で OS が dehydrate する可能性は理論上ある。ただし `SetInSyncState(false)` で OS の自動 dehydrate は抑制されているので**実害なし**。

**関連 ADR**:

- ADR-005: コンフリクト解決(3層排他制御)

---

## ADR-016: ロック取得タイミング — open 時 + Liveness ベース管理

**決定**: ファイル open 時にサーバー側ロックを取得する。Samba 同等の UX を実現し、コンフリクトを構造的に発生させない。Liveness 管理は Device ID + WSS ハートビート方式(ADR-018)、ロック中ファイルへの編集ブロックは X-File-Attributes ヘッダ方式(ADR-019)で実現する。

**経緯**:

- ADR-005 で「open 時にロック取得」を決定
- Phase 5 実装中に「読み取り目的のオープンでもロック発生 → サーバー負荷」を懸念し、一時的に「close 時のみロック」(楽観的方式)に変更
- 100 人規模での負荷試算で、ロック取得は問題にならないと判明
- 設計原則「Samba 同等、コンフリクトを許容しない」に立ち返り、open 時ロックに戻す

**100 人規模の負荷試算**:

- ロック取得 1 回 ≈ 5ms(JWT 検証 + checkPermission + KV.get + KV.atomic)
- Deno KV スループット ≈ 数千 ops/秒
- ピーク 50 ops/秒(100 ユーザー × 5 ファイル × 10 秒集中)
- 利用率 ≈ 13%、余裕あり

サーバー負荷を理由に「読み取りロック」を避ける必要はない。**真の論点は UX**(短時間プレビューで誤警告、異常終了でゴーストロック残存)であり、これは ADR-018 の TTL 30 秒 + WSS ハートビートで解決する。

**Samba 同等の UX**:

- ファイル open 時にロック取得 → 他ユーザーには「編集中」と即座に伝わる(WSS broadcast)
- 他ユーザーが同じファイルを開く → サーバーが ReadOnly 属性付きで返す(ADR-019)→ 編集アプリが RO を尊重して編集ブロック
- A が close → ロック解放 → 他ユーザーは編集可能になる

これにより**コンフリクトが構造的に発生しない**。

**保険機構**:

- 異常事態(WSS 取りこぼし、race condition、バグ等)でロック未取得のまま編集が成立してしまった場合 → conflict file で救済(ADR-017)
- 通常運用では発火しない、設計の最終保証

**関連 ADR**:

- ADR-005: 旧仕様(本 ADR で更新)
- ADR-017: コンフリクトファイル(異常事態の最終手段)
- ADR-018: Device ID + WSS ハートビートによる Liveness 管理
- ADR-019: X-File-Attributes ヘッダによる属性伝達
- ADR-020: close 時の常時 dehydrate

---

## ADR-017: コンフリクトファイル戦略 — 異常事態の最終手段

**決定**: mikura の設計思想は「コンフリクトを許容しない」(ADR-016 の open ロック + ADR-019 の RO 反映で構造的に防ぐ)。コンフリクトファイル機構は **通常運用では発火しない最終保証** として残す。

**位置付けの明確化**:

- ✅ 通常運用: ロック取得失敗時はファイルが RO で開かれる → 編集自体が発生しない → コンフリクトしない
- ⚠️ 異常事態のみ: WSS 取りこぼし、race condition(B が先に開いてから A がロック取得)、バグ等で編集が成立してしまった場合
- 異常事態でも**ユーザーの作業を絶対に失わない**ためのセーフティネット

**実装**:

ロック取得失敗時、または upload 時の整合性検証(ETag 不一致等)で衝突を検知した場合、ローカル変更を `<stem>.conflict-<yyyyMMdd-HHmmss><ext>` として退避し、元ファイルは dehydrate してサーバー版に戻す。

```csharp
private static async Task<bool> SaveAsConflictFileAsync(string relativePath, string localPath)
{
    var dir = Path.GetDirectoryName(localPath);
    var stem = Path.GetFileNameWithoutExtension(localPath);
    var ext = Path.GetExtension(localPath);
    var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");
    var conflictPath = Path.Combine(dir, $"{stem}.conflict-{stamp}{ext}");

    await using var src = File.OpenRead(localPath);
    await using var dst = File.Create(conflictPath);
    await src.CopyToAsync(dst);

    return true;
}
```

**運用上の意味**:

- 通常運用で conflict file が発生する = 設計上の異常事態 または バグの可能性
- ログ記録 + 監視対象として扱う
- 頻発する場合は WSS 接続安定性、ロック機構の見直しを検討

**選択理由**:

- データロスゼロ原則(ユーザーの作業を絶対に失わない)
- Dropbox / OneDrive と同じ方式(エンドユーザーが慣れている)
- 後からマージ作業が可能
- 元ファイルがサーバー版に同期されるので整合性が保たれる

**関連 ADR**:

- ADR-016: open 時ロック(通常はここで防ぐ)
- ADR-018: Device ID ベース Liveness ロック
- ADR-019: X-File-Attributes ヘッダ(編集ブロックの主機構)

---

## ADR-018: Device ID ベース Liveness ロック管理

**決定**: クライアント端末ごとに永続的な Device ID(UID, UUID v4)を生成・保管し、JWT 認証時に含めて検証、ロックは `(userId, deviceId)` で識別する。WSS ハートビートで TTL を延長、異常時は Deno KV の `expireIn` で自動解除、グレースフル終了時は WSS terminate で即時解除する。

**モデル**:

- **Device ID(UID)**: 端末初回起動時にクライアントが生成、Local AppData に永続化、再起動・再インストールまで変わらない
- **JWT**: 認証時にサーバー発行、`device` クレームに deviceId 含む、1 時間有効
- **ロック**: `(userId, deviceId, path)` で識別、TTL 30 秒、Deno KV `expireIn` で自動削除
- **WSS 接続**: ハートビート(10 秒間隔、ペイロードは deviceId のみ)で TTL 延長、リアルタイム通知の通り道

**動作フロー**:

```
[初回起動]
1. クライアント: 実行ファイルと同ディレクトリの device.json を確認
   - なければ UUID v4 生成、保存
   - あれば読み込み

[ログイン]
2. POST /auth/login { username, password, deviceId }
3. サーバー: 認証 → device テーブル登録/更新 → JWT 発行(device クレーム含む)

[WSS 接続]
4. クライアント: ws://server/events?token=<JWT>
5. サーバー: JWT 検証(device クレームと送信元の整合性確認)

[ファイル open]
6. POST /locks/* (Bearer JWT, X-Device-Id ヘッダ)
7. サーバー: deviceId で識別してロック保存(expireIn: 30s)
8. サーバー: WSS で全クライアントに lock_acquired broadcast

[ハートビート]
9. クライアント: WSS で { type: "heartbeat", deviceId } を 10秒ごと送信
10. サーバー: deviceId に紐づく全ロックの TTL を 30秒延長

[ファイル close]
11. クライアント: アップロード(編集あり時)
12. クライアント: DELETE /locks/* (X-Device-Id ヘッダ)
13. サーバー: deviceId 一致確認 → ロック削除
14. サーバー: WSS で lock_released broadcast

[グレースフル終了]
15. クライアント: WSS で { type: "terminate", deviceId } 送信
16. サーバー: deviceId に紐づく全ロック削除 + broadcast

[異常終了]
17. WSS 切断検知 → サーバーは何もしない(任意)
18. 30秒経過 → KV expireIn で各ロック自動削除
19. 自前スイーパーが TTL 切れを検知 → lock_released broadcast
```

**スキーマ**:

```typescript
// Deno KV
["devices", deviceId] → {
    deviceId: string,
    userId: number,
    label: string,         // "OFFICE-PC-01" 等
    firstSeenAt: string,
    lastSeenAt: string,
    ipAddress?: string,
}

["devices-by-user", userId, deviceId] → true  // 逆引き

["locks", filePath] → {
    userId: number,
    deviceId: string,      // ロック保持端末
    acquiredAt: string,
    expiresAt: string,     // 参考情報、実際の TTL は KV expireIn
}
```

**JWT クレーム**:

```json
{
    "sub": 42,
    "device": "uuid-v4-here",
    "iat": 1745568000,
    "exp": 1745571600
}
```

**永続化**:

- 保存先: クライアント実行ファイルと同ディレクトリの `device.json`(`AppContext.BaseDirectory` 直下)
- ID の単位は **インストール単位**。同一 PC でユーザーを切り替えても同じ ID、フォルダごと別 PC にコピーすれば移行も可能(ローミングプロファイルでの意図しない ID 共有は構造上発生しない)
- 単一実行ファイル発行(`PublishSingleFile`)でも `AppContext.BaseDirectory` は実行ファイルの位置を返すので安定
- 配置上の注意: `Program Files` 配下のような書き込み不可ロケーションには配置しない。ポータブル配置(ユーザー書き込み可能なフォルダ)を前提にする

```json
{
    "deviceId": "7c3e8a92-4f2b-4d89-a1e3-9f8c7b6d5a4e",
    "createdAt": "2026-04-25T10:00:00Z"
}
```

**同一ユーザー別端末の扱い**:

`(userId, deviceId)` で識別するが、**同一 userId なら別 deviceId に取り戻し許可**:

```typescript
async function acquireLock(filePath, userId, deviceId): LockResult {
    const existing = await kv.get<LockData>(Keys.lock(filePath));
    
    if (existing.value) {
        if (existing.value.userId === userId) {
            // 同一ユーザー → renew(同 deviceId)or 取り戻し(別 deviceId)
            const updated = { 
                userId, 
                deviceId,  // 新 deviceId に上書き
                acquiredAt: existing.value.acquiredAt,
                expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
            };
            await kv.set(key, updated, { expireIn: LOCK_TTL_MS });
            return { success: true, lock: updated };
        }
        // 他ユーザー → 拒否
        return { success: false, reason: "locked_by_other_user" };
    }
    
    // 新規取得
    return createLock(filePath, userId, deviceId);
}
```

OneDrive と同じ方式(「PC で開いていたファイルをノートで取り戻す」が可能)。

**選択理由**:

- **ID 永続性**: 再接続・再起動で deviceId は変わらない → 「session_restore」のような複雑なロジック不要
- **JWT との統合**: deviceId は JWT クレームとして検証、偽造防止
- **監査追跡容易**: 「いつ、どの端末から、何をしたか」が device 単位で永続的に追跡可能
- **同一ユーザー別端末対応**: deviceId 比較で自然に判別
- **ハートビート軽量**: ペイロードは deviceId のみ、固定サイズ
- **管理 UI 構築可能(将来)**: 「ログイン中のデバイス」一覧、強制ログアウト等

**100 人規模の負荷試算**:

- ロック取得: 1 回 ≈ 5ms、ピーク 50 ops/秒、Deno KV キャパ内
- ハートビート: 100 ユーザー × 10秒間隔 = 10 ops/秒、無視できる
- broadcast: 100 ユーザーへの WSS 送信、軽量

**異常終了からの回復**:

- WSS 切断 → 30 秒で KV TTL 切れ → ロック自動失効
- Samba(TCP 切断で即失効)に近い UX、HTTPS 上で実現

**却下した選択肢**:

- **クライアント生成セッション ID(WSS 切断で変わる)**: 再接続時の引き継ぎが複雑
- **サーバー発行セッション ID**: 複雑な session_restore プロトコルが必要
- **持っているロック一覧をハートビート送信**: ペイロード過大、SSOT 原則に反する
- **純 TTL のみ**: 異常時の即時検知ができない

**関連 ADR**:

- ADR-005: コンフリクト解決(本 ADR で具体化)
- ADR-016: ロック取得タイミング(open 時)
- ADR-019: X-File-Attributes ヘッダ(ロック状態の伝達)
- ADR-020: 常時 dehydrate

---

## ADR-019: ファイル属性をレスポンスヘッダで伝達

**決定**: ファイル取得時(GET /content/*)のレスポンスヘッダにファイル属性(`X-File-Attributes`)を含める。クライアントはヘッダを読んで CfApi 経由でローカル NTFS の MFT に反映する。`/tree` エンドポイントも同様に各ノードの属性情報を含める。

**設計の核**:

- HTTP のボディ = ファイル中身(不可侵)
- HTTP のヘッダ = メタ情報(属性、ロック状態、所有者等)
- 1 リクエストで全情報を取得、原子的、ズレなし

**動作**:

```
[ハイドレート時]
クライアント: GET /content/report.docx (X-Device-Id: <自分>)
サーバー: 
  - 認可チェック
  - ロック状態確認: holder.deviceId !== requester.deviceId なら "他人のロック中"
  - レスポンス:
      Content-Type: application/octet-stream
      ETag: "abc-123"
      Last-Modified: ...
      X-File-Attributes: ReadOnly        ← ロック中なら
      X-File-Lock-Holder: alice          ← 任意、ユーザー通知用
      [body: ファイル中身]
クライアント:
  - transfer.Write でローカルに書き込み(ハイドレート)
  - X-File-Attributes を解釈
  - File.SetAttributes でローカル NTFS の MFT に RO 属性付与

[起動時 / ツリー取得]
クライアント: GET /tree (X-Device-Id: <自分>)
サーバー: 各ノードに { isReadOnly: 他人がロック中か } を含めて返す
クライアント: CreatePlaceholders で属性付き作成

[ロック状態変化(WSS broadcast)]
サーバー: lock_acquired/lock_released を全クライアントに broadcast
クライアント: 既存ハイドレート済みファイルの属性を更新
            File.SetAttributes(path, attrs | ReadOnly) または attrs & ~ReadOnly
```

**ヘッダ仕様**:

| ヘッダ | 説明 | 例 |
|---|---|---|
| `X-File-Attributes` | カンマ区切りの属性リスト | `ReadOnly`、`Hidden,System` |
| `X-File-Lock-Holder` | ロック保持者の表示名(任意) | `alice` |

将来の拡張:

| ヘッダ | 説明 |
|---|---|
| `X-File-Permissions` | 権限ベースの RO(ADR-008) |
| `X-File-Tags` | タグ |
| `X-File-Owner` | 所有者 |

**WSS との役割分担**:

- **GET /content のヘッダ**: ハイドレート時点の状態(ボディと同時取得、原子的)
- **GET /tree の isReadOnly**: 起動時の初期状態
- **WSS lock_acquired/released**: ハイドレート後のリアルタイム変化を伝達

**SSOT 原則**:

- ロック状態 = サーバー側 KV
- ファイル属性 = サーバーが生成して送る
- クライアントは反映するだけ、独自の状態管理を持たない

**race condition の扱い**:

- A がロック取得 → サーバー broadcast → B が WSS イベント受信して RO 化 → 通常はこれで防げる
- B が先にファイルを開いてから A がロック取得 → B 側で SetAttributes が共有違反で失敗する可能性
  → このケースは編集が成立してしまうが、close 時の整合性検証で検知 → conflict file 退避(ADR-017)
- WSS 切断中 → broadcast が届かない → 復旧時に /tree で再同期(ADR-013)

**選択理由**:

- HTTP の慣習(カスタムヘッダで メタ情報伝達)に沿った自然な設計
- ボディとメタの綺麗な分離
- 1 リクエストで原子的、状態のズレが起きない
- CfApi の Hydrate フローと相性抜群(`transfer.Write` と `SetAttributes` を 1 つの流れで)
- 既存 API への変更が最小(ヘッダ追加のみ)
- 将来の拡張(タグ、所有者、権限ベース RO 等)に同じパターンで対応可能

**却下した選択肢**:

- **別 API でメタ取得**: 2 リクエスト必要、間で状態が変わる可能性
- **/tree のみ**: ハイドレート時点と /tree 取得時点でズレる
- **ファイル中身に埋め込み**: 不可能(中身は不可侵)
- **ファイルシステムレベルでサーバー側 RO**: クライアントには中身しか届かない、無意味

**関連 ADR**:

- ADR-008: 権限モデル(同じヘッダ機構で権限起因の RO も将来伝達可能)
- ADR-013: ALWAYS_FULL + WSS(/tree でも同じパターン)
- ADR-016: open 時ロック
- ADR-017: 異常事態の最終手段
- ADR-018: Device ID ベース Liveness ロック

---

## ADR-020: close 時の常時 dehydrate — VPN 越し SMB 同等の動作モデル

**決定**: ファイル close 時に常に dehydrate を試行する。ローカルキャッシュは持たず、サーバーが常に唯一の真実とする。これは **VPN 越し SMB と同じ動作モデル**であり、mikura のターゲット要件(Samba 代替)と整合する。

**動作モデルの比較**:

| 観点 | VPN 越し SMB | mikura |
|---|---|---|
| ファイル実体 | サーバー上のみ | サーバー上のみ(プレースホルダーのみローカル) |
| クライアントキャッシュ | 揮発、最終的に手放す | dehydrate で手放す |
| 通信経路 | SMB プロトコル(TCP 445) | HTTPS(CfApi + GET /content) |
| 認証 | LDAP / Kerberos | OIDC + JWT + Device ID |
| 動作の本質 | 同じ | 同じ |

**動作**:

```
[close 時]
- 編集あり: アップロード → アンロック → dehydrate 試行
- 編集なし: アンロック → dehydrate 試行

[dehydrate の挙動]
- アプリが完全にハンドル解放: 即座に成功
- アプリが中間保存等で再取得: 共有違反で失敗 → リトライキューへ
- リトライキューが定期的に再試行 → アプリ完全終了後に成功

[次回必要になった時]
- ハンドル取得 → CfApi が FETCH_DATA → GET /content で再取得
- これは SMB の「サーバーから再読み取り」と同じ動作
```

**Word 中間保存等の挙動**:

```
Word: Ctrl+S → ハンドル一瞬解放
mikura: CLOSE_COMPLETION → アップロード → dehydrate 試行
Word: 即座にハンドル再取得
mikura: dehydrate 共有違反で失敗 → リトライキューへ

または(Word が完全にハンドルを離した場合):

Word: Ctrl+S → ハンドル完全解放
mikura: CLOSE_COMPLETION → アップロード → dehydrate 成功
Word: ハンドル再取得 → CfApi: FETCH_DATA → 再ハイドレート
```

どちらの動作も VPN 越し SMB と同じ。再ハイドレートのレイテンシは HTTP/2 + 並列処理で SMB より高速化される可能性がある。

**整合性保証メカニズム**:

| 機構 | 役割 |
|---|---|
| close 時 dehydrate | 99% のケースで即座にローカル中身削除を試行 |
| dehydrate リトライキュー | 共有違反等で失敗した場合の後追い処理 |
| WSS modified イベントで再 dehydrate | 他クライアント変更時の即時対応 |
| 起動時の /tree との ETag 比較 | 全体整合性の同期、WSS 取りこぼし救済 |

これらの組み合わせで、**実用上完璧な整合性**を実現。

**CfDehydratePlaceholder の特性**:

- **ローカル NTFS 操作のみ、サーバー通信なし**
- クラスタ解放のみ、プレースホルダー(MFT のメタ情報)は残る
- コスト ≒ 0(数ms)
- 失敗ケース: pinned、他プロセス使用中、`NOT_IN_SYNC` 状態

**選択理由**:

- **VPN 越し SMB と同じ動作モデル**: mikura のターゲット要件(Samba 代替)と整合、ユーザーは慣れた挙動を得る
- **CfApi のフローと素直に整合**: 楽観的キャッシュ(ETag 確認等)は CfApi のキャッシュ判定(キャッシュあれば FETCH_DATA 呼ばない)とミスマッチ
- **整合性問題が原理的に発生しない**: ローカルに古いキャッシュが残らない
- **「サーバーが真」を厳格に守る**: 設計原則 ADR-004 と整合
- **dehydrate が無料**: ローカル操作のみ、コスト無視できる
- **セキュリティ**: ローカルに不要なデータを残さない
- **シンプル**: キャッシュ管理ロジックが不要

**Storage Sense との関係**:

Windows の Storage Sense にも「使われていないクラウドファイルを dehydrate」する機能があるが、mikura では明示的に close 時 dehydrate するため、Storage Sense の挙動には依存しない。

**Pin 機能(将来検討)**:

CfApi の `CfSetPinState` でファイルを pinned にすれば dehydrate されない。「常にローカルに置きたいファイル」をユーザーが明示的に選ぶ機能として将来追加可能。Roadmap で検討。

**却下した選択肢**:

- **楽観的キャッシュ + ETag 確認**: SMB にはない概念、CfApi のフロー(キャッシュあれば FETCH_DATA 呼ばない)と相性が悪い、open 時に介入する手段がない
- **ローカルキャッシュ活用 + Storage Sense 任せ**: mikura としての一貫性なし、整合性保証が OS 依存
- **時間ベースの dehydrate(10分後等)**: 中途半端、整合性問題の根本解決にならない

**実装上の注意**:

- close 時の `OnFileCloseAsync` の戻り値で `safeToDehydrate` を返す(現状の設計を維持)
- アップロード失敗時は `safeToDehydrate = false`(ローカル変更保護、ADR-016)
- それ以外は `safeToDehydrate = true`(編集なしでも dehydrate)
- dehydrate 失敗 → リトライキューへ(共有違反は当然ありうる、後追いで処理)
- WSS の modified イベントハンドラで「既にハイドレート済みなら dehydrate 試行」

**関連 ADR**:

- ADR-004: オフライン時の挙動(サーバーが真の原則)
- ADR-013: ALWAYS_FULL(プレースホルダーは常時残る、中身だけ dehydrate)
- ADR-014: ハイブリッド修正検出
- ADR-016: open 時ロック
- ADR-019: X-File-Attributes ヘッダ

---

## ADR-021: ファイル投影レイヤーを CfApi から WinFsp へ移行

**決定**: ファイル投影レイヤーを Windows Cloud Files API(CfApi)から WinFsp(Windows File System Proxy)へ移行する。**ADR-013 / ADR-016 / ADR-019 / ADR-020 を本 ADR で supersede する**(関連箇所は WinFsp 前提で再設計)。

**背景 — CfApi の構造的限界**:

mikura の核となる設計原則は「**Samba/SMB と同等の UX を Zero Trust(HTTPS のみ)で実現する**」(ADR-001、ADR-016、ADR-020)。この原則の中でも特に重要なのが **オフライン時の即時切断** ─ ネットワークが切れた瞬間に、既に open されているファイルハンドルへの IO を即座に失敗させること。SMB は TCP セッション切断と同時にハンドルを無効化し、次の Read/Write は `STATUS_NETWORK_NAME_DELETED` 等で即時失敗する。これが「ファイルサーバーが落ちた = 即わかる」という業務上の前提を支えている。

CfApi はこの要件を **構造的に満たせない**:

| 要素 | CfApi の設計 | mikura の要件との不整合 |
|---|---|---|
| API の位置付け | sync engine API(OneDrive 風) | network filesystem API ではない |
| ハイドレート済みデータへのアクセス | OS のキャッシュから直接読まれ、API は介在しない | 新規 IO を止められない |
| `CfDisconnectSyncRoot` | 新規操作のみブロック、既存ハンドルは生存 | 切断時に既存ハンドルを殺せない |
| Read/Write IRP の経路 | カーネルキャッシュ → ディスクへ直接(API は FETCH_DATA でしか介在しない) | アプリレベルで IO を中断する手段なし |
| 設計思想 | 「オフラインでもキャッシュは見られる」UX | 「オフラインなら即エラー」UX |

ADR-019 の X-File-Attributes ヘッダ方式や ADR-020 の常時 dehydrate でローカルキャッシュを最小化しても、ハンドル open 中は CfApi はカーネルキャッシュから読み続ける。**Samba 同等の動作モデル**を CfApi の上に載せるのは原理的に不可能。

**WinFsp による達成**:

WinFsp は **user-mode file system framework** で、`Create` / `Open` / `Read` / `Write` / `Cleanup` などすべての IRP がユーザーモードのコールバックに渡される。ネットワーク喪失検知時:

- 新規 `Create` / `Open` を即座に `STATUS_NETWORK_UNREACHABLE` で失敗
- **既存ハンドルへの次の `Read` / `Write` も同様に失敗** ← CfApi ではできなかった部分
- 既存ハンドルへの `Cleanup` / `Close` だけは通す(リソースリーク防止)

**スパイク実機検証**(`client/spike/Mikura.WinFspSpike` で 2026-05-04 実施。本 ADR 採択後にディレクトリは削除済み、git 履歴上は `feature/winfsp-pivot` の `a19dfe4` を参照):

| シナリオ | 結果 |
|---|---|
| メモ帳で `Z:\hello.txt` を編集中に offline → 保存 | ✅ 即エラー、Save As フォールバック、ハング無し |
| `FileStream.Read` で進行中(144 KB 読了)に offline | ✅ 次の `Read()` で `IOException` 即時発生、メッセージ「ネットワークに到達できません」 |

**supersede される ADR と再設計の方向性**:

- **ADR-013(ALWAYS_FULL placeholder + WSS イベント駆動)** → WinFsp に placeholder 概念が無い。代わりに **「メタデータは常にローカル(`_nodes` 相当)、データは on-demand fetch」** モデルを WinFsp の `Read` コールバック内で自前実装する。WSS イベント駆動の同期は維持。
- **ADR-016(open 時サーバーロック)** → ロック取得タイミング(open 時)とライフサイクル(Device ID + heartbeat、ADR-018)は **そのまま維持**。実装が CfApi の `OnFileOpenAsync` から WinFsp の `Open` コールバックに移るだけ。
- **ADR-019(X-File-Attributes ヘッダで RO 反映)** → **不要になる**。WinFsp なら他デバイスがロック中のファイルへの open を `STATUS_ACCESS_DENIED` で直接弾ける。`X-File-Attributes` ヘッダは廃止。
- **ADR-020(close 時の常時 dehydrate)** → 「サーバーが単一真実、ローカルキャッシュを持たない」原則は維持。WinFsp ではキャッシュ層は完全自前なので、`Cleanup` 時にキャッシュを破棄する形で再実装。`CfDehydratePlaceholder` 相当のコストは「`byte[]` の参照解放」になり、引き続きほぼ無料。

維持される ADR(影響なし or 軽微):

- ADR-001(プロトコル選択 — HTTPS):変更なし。CfApi の文言だけ後日修正
- ADR-006 / 007 / 008(WSS / OIDC / 権限モデル):サーバ側、変更なし
- ADR-018(Device ID + heartbeat):変更なし
- ADR-009(zero alloc):WinFsp 統合層では `IntPtr` ベースの `Marshal.Copy` 経路が増えるので方針として継続

**新レイヤー構成**:

```
旧                                  新
─────────────────────────────────   ─────────────────────────────────
CfApi.Native (P/Invoke)             WinFsp.Interop (Fsp.* ラッパ)
CfApi.Interop (UnmanagedCallers)    WinFsp.Host (FileSystemBase 派生)
Mikura.Core.Sync.MikuraSyncCallbacks    Mikura.Core.Sync.MikuraFileSystem
Mikura.Core.Sync.SyncEngine           Mikura.Core.Sync.SyncEngine (再設計)
Mikura.Transport (HTTP/WSS)           Mikura.Transport (HTTP/WSS) — 変更なし
Mikura.App                            Mikura.App + WinFsp MSI redistributable
```

**トレードオフ**:

| 観点 | 失うもの | 得るもの |
|---|---|---|
| 配布 | OS 標準ドライバ(CfApi)で済む手軽さ | WinFsp MSI を Mikura.App インストーラに同梱する必要あり |
| placeholder / hydration セマンティクス | OS が提供する一連の概念 | 完全自前実装(自由度と引き換えに実装責務増) |
| ドライバ更新 | Windows Update 任せ | WinFsp のリリースを mikura 側で追従(年 1 回ペース) |
| バスファクター | MS 公式 | WinFsp 単独メンテナ(billziss-gh) |
| 機能の天井 | CfApi のセマンティクスに縛られる | 最低限の制約(Win32 IRP モデル)のみ |
| **オフライン即時切断** | **不可能** | **可能** ← 移行の決定打 |

**却下した代替案**:

- **CfApi のまま X-File-Attributes ハック拡張**:オフライン即時切断は原理的に不可能。コールアウト点が無い
- **WebDAV(IIS LOCK 拡張)**:LOCK 実装が脆弱(advisory・タイムアウト依存・クライアント間で挙動不一致)。mikura は元から WebDAV 非依存方針(README)
- **NFSv4(マンデートリーロック)**:Windows ネイティブ UX が弱い、Zero Trust / HTTPS と非整合
- **新リポジトリで一から書き直し**:server / Mikura.Transport / SyncEngine の上位ロジック / テスト基盤など 60〜70% は再利用可能。git 履歴に判断の根拠を残せるため、同一リポでの段階的 pivot を選択

**移行の進め方**:

`feature/winfsp-pivot` ブランチで以下の順に進める:

1. ✅ スパイク(`client/spike/Mikura.WinFspSpike`、後に削除。git 履歴 `a19dfe4` 参照)で「オフライン即時切断が WinFsp で達成可能」を実証
2. ✅ 本 ADR で意思決定を文書化
3. WinFsp.Interop / WinFsp.Host レイヤーを新設
4. `Mikura.Core.Sync` の callback / SyncEngine を WinFsp 前提に再設計
5. `CfApi.Native` / `CfApi.Interop` を削除
6. README / `Mikura.Client.sln` / Directory.Build.props 更新
7. WinFsp MSI を Mikura.App のインストーラに同梱(配布工程)
8. main へマージ

**関連 ADR**:

- supersede: ADR-013、ADR-016(実装層のみ)、ADR-019、ADR-020(実装層のみ)
- 維持: ADR-001、ADR-004、ADR-006、ADR-007、ADR-008、ADR-009、ADR-014、ADR-015、ADR-018

---

## ADR-022: WinFsp 上のロック取得スコープ — write-intent + プロセス内 refcount

**決定**: ADR-016 の「open 時ロック」を WinFsp の callback 数の現実に合わせて再定義する:

1. **write-intent open のみ**(read-only open はロック取得しない)
2. **同一プロセス内の同一パスへの複数 open は refcount で集約**(POST/DELETE は最初の open と最後の close でだけ発生)
3. **ロック衝突時は `STATUS_ACCESS_DENIED`**(404 ではなく)で即時応答

**背景 — CfApi 時代との差分**:

CfApi の `NOTIFY_OPEN_COMPLETION` は「実際にユーザが意図したファイル open」だけに反応するフックだったが、WinFsp は **kernel から来るすべての `CreateFile` IRP** を user-mode の `Open` callback に転送する。1 ユーザ操作 = 数十 CreateFile が普通:

- shell preview / icon overlay / プロパティダイアログ / Defender / 検索インデクサ /
  safe-save の rename(DELETE 権限要求)/ notepad の autosave サイクル

ナイーブに「すべての open でロック取得」を実装すると、1 編集で `POST /locks` が **20〜30 回連発**する状態が観測された。

**設計判断 1: write-intent のみロック**

read-intent open(content viewing, scanning, preview)は ADR-020 の「サーバが単一真実」原則からして並行可。Excel/Word/Notepad の **「他者編集中でも read-only で開ける」UX** を維持するため、read open ではロック取得しない。

read 専用ハンドルから誤って write が来る経路は kernel 側で原則拒否されるが、防衛として `MikuraServerBackend.WriteAsync` で `!h.HasLock && !h.FreshlyCreated` の場合 `UnauthorizedAccessException` を投げる二重チェックを入れる。

**設計判断 2: プロセス内 refcount による server lock 共有**

write-intent でも、上述の通り 1 編集で複数の write-intent open が連発する。これらをすべて独立に AcquireLock すると:

- サーバへの POST 連発
- 兄弟ハンドルの最初の Cleanup が server lock を release → 残りのハンドルが「ロック持ってる」と思ったまま upload する race condition

修正:`MikuraServerBackend` に `LockSlot` 構造を導入。同一プロセス・同一パスへの open は `_activeLocks` dictionary 経由で refcount を bump するだけ。`POST /locks` は最初の open でのみ HTTP 発火、`DELETE /locks` は最後の close でのみ発火。並行 open のための `TaskCompletionSource` で 2 番目以降の open は最初の HTTP 結果を待ってから inherit。

**設計判断 3: 衝突時の NTSTATUS マッピング**

ロック取得失敗時、`MikuraFileSystem.Open` の汎用 catch がすべての例外を `null` にして `STATUS_OBJECT_NAME_NOT_FOUND` を返すバグがあった。これだとユーザは「ファイルが見つかりません」と表示され、本当の理由(他者編集中)が伝わらない。

修正:`UnauthorizedAccessException` を専用 catch して `STATUS_ACCESS_DENIED` を返す。Excel が「他のユーザが使用中です。読み取り専用で開きますか?」のダイアログを正しく表示できるようになる。

**残課題:lost update**

read-only 期間中は server-side lock 不在のため、以下のシーケンスが lost update を起こす:

```
A: read open → 内容 "x" を fetch
B: read open → 内容 "x" を fetch
A: 編集して save (write open → AcquireLock → upload "y" → release)
B: 編集して save (write open → AcquireLock 成功(A 既に release)→ upload "B's x→x'")
   ← B は A の "y" を見ずに自分の "x'" でサーバ上書き = A の編集消失
```

これは ADR-026 の ETag/If-Match 楽観的並行制御で対応する想定(本 ADR では扱わない)。

**実装場所**:

- `client/src/Mikura.Core/Sync/MikuraServerBackend.cs` の `OpenAsync` / `AcquireSharedAsync` / `ReleaseSharedAsync` / `LockSlot`
- `client/src/WinFsp.Interop/MikuraFileSystem.cs` の `Open` callback と `HasWriteAccess` ヘルパ

**関連 ADR**:

- supersede: ADR-016 の "open 時ロック" 部分(タイミングは維持、スコープを write-intent に限定)
- 維持: ADR-018(Device ID + heartbeat の Liveness)
- 派生: ADR-026(ETag による lost update 防止、未着手)

---

## ADR-023: in-memory staging buffer の設計と上限

**決定**: 編集中ファイルのデータは **per-handle の `byte[]` バッファに in-memory で staging** する。バッファは `ArrayPool<byte>` から rent して capacity-doubling で拡張する。**1 ファイル ≤ 2GB の制約**を受け入れる(`int.MaxValue` 制限)。それ以上は ADR-024 で対応する想定。

**設計**:

```
ServerHandle
├─ byte[] _buffer       (ArrayPool レンタル、capacity)
├─ long _length         (論理コンテンツ長 ≤ buffer.Length)
├─ bool _bufferRented   (返却対象か)
├─ EnsureCapacity(N)    (doubling growth、Rent → BlockCopy → Return old)
├─ EnsureHydratedAsync  (server からの単一 alloc fetch)
└─ DropBuffer           (Cleanup 時に Return)

ArrayPool<byte>.Create(maxArrayLength: 32MB, maxArraysPerBucket: 8)
   ↑ 全 ServerHandle で共有、再利用で LOH garbage 蓄積を抑制
```

**メモリプロファイル**(10MB ファイル コピー時の実測推移):

| 段階 | resident memory |
|---|---|
| 初版(各 Write で `new byte[newLength]`、O(N²)alloc)| ~120 MB |
| capacity-doubling 導入 | ~96 MB |
| hydrate を MemoryStream+ToArray から単一 alloc に変更 | ~59 MB |
| ArrayPool レンタル化 | ~30 MB(8 ファイル並行コピーで ~84 MB に bound)|

**重要な実装ポイント**:

1. **SetFileSize(allocationHint=true) を活用してプリアロケート**
   shell の CopyFileEx は書き込み前に `SetEndOfFile(N)` を呼ぶ。これを `EnsureCapacity(N)` に直結すると、buffer の段階的 doubling resize に伴う中間 byte[] の garbage(~16MB ぶん)が発生せず、1 回で確定サイズを確保できる。

2. **WriteAsync の gap 埋めゼロ化**
   ArrayPool レンタル byte[] は **ゼロクリアされない**(prior renter のデータが残る)。kernel の non-sequential write で `[existingLen..writeOffset)` に gap ができた場合、そこを `Array.Clear` で明示的にゼロ化しないと、別ハンドルで扱った機密データがそのまま upload される(セキュリティ・整合性問題)。

3. **WinFsp callback 経路の per-IRP marshal buffer も `ArrayPool<byte>.Shared` で pool 化**
   `MikuraFileSystem.Read` / `Write` の `IntPtr ↔ byte[]` の中継バッファ(典型 4〜64 KB)を毎回 `new byte[length]` していたが、ArrayPool レンタルにして per-IRP allocation を排除。

**上限とトレードオフ**:

- **1 ファイルあたり 2GB**(`int.MaxValue` で `OverflowException`)
- **1 ファイルサイズ ≒ クライアントメモリ**(ハンドル open〜close の間)
- 同時並行操作数 × ファイルサイズ がメモリ占有のオーダ
- LAN 上のオフィス用途(数 MB 〜 数十 MB のファイル)では十分実用範囲
- 大容量ファイル(GB 級)は ADR-024 で別途対応

**Known limitations(運用前の周知事項)**:

- 2GB 超のファイルは現状アップロード不可
- 1GB ファイルを送るとプロセスメモリ ≒ 1GB が必要
- 1 ファイル = 1 PUT リクエストで送信、途中切断で先頭から再送
- 進捗表示・レジューム・並列チャンク送信はすべて未対応

**実装場所**:

- `client/src/Mikura.Core/Sync/MikuraServerBackend.cs` の `ServerHandle` クラス、`EnsureCapacity` / `EnsureHydratedAsync` / `WriteAsync` / `DropBuffer`
- `client/src/WinFsp.Interop/MikuraFileSystem.cs` の `Read` / `Write` callback の ArrayPool 化

**関連 ADR**:

- 前提: ADR-021(WinFsp 移行で kernel cache を持たず、user-mode buffer に staging する原則)
- 拡張: ADR-024(GB 級ファイル対応の chunked / resumable upload)

---

## ADR-024: フォルダ作成 + rename サポート(サーバ endpoint 拡張)

**決定**: サーバに **`POST /folders/*path`**(非再帰 mkdir)と **`PATCH /files/*path`**(rename / move)を追加する。クライアントは `IMikuraServer.CreateFolderAsync` / `RenameAsync` 経由でこれを呼び、`MikuraServerBackend.CreateAsync(isDirectory)` / `RenameAsync` で WinFsp の対応 callback と接続する。

**背景**:

WinFsp 移行直後の `MikuraServerBackend` は spike から派生していたため:

- `CreateAsync(isDirectory: true)` が常に `null` 返却 → エクスプローラ「新規 > フォルダー」が機能不全
- `RenameAsync` が `NotSupportedException` → エクスプローラの「新規ファイル作成 → 名前編集」が失敗

ユーザ目線では「新規ファイルが作れない」と見える(実態は Create は通っているが直後の Rename で失敗していた)。

**サーバ側 API**:

| Endpoint | 仕様 |
|---|---|
| `POST /folders/*path` | 非再帰 mkdir。親が無ければ 404、既に同名があれば 409。201 で `{ path }` 返却 |
| `PATCH /files/*path` body: `{ newPath }` | 旧→新へ移動。衝突時 409、対象不在時 404、源/先両方に write 権限要求 |
| `DELETE /files/*path` (既存) | ファイル/ディレクトリ削除。`MikuraServerBackend.CleanupAsync(Delete)` から呼ばれる |

サーバ実装は `Deno.mkdir({ recursive: false })` と `Deno.rename`。衝突検知は `Deno.stat` の前置き。

**クライアント実装**:

- `Mikura.Transport.HttpMikuraServer` に `CreateFolderAsync`(POST、409 は冪等扱い)と `RenameAsync`(PATCH JSON body)を追加
- `MikuraServerBackend.CreateAsync(isDirectory: true)` で `_server.CreateFolderAsync(path)` を呼んで `_tree` に登録、ハンドルを返す
- `MikuraServerBackend.RenameAsync` で `_server.RenameAsync(src, dst)` を呼び、`_tree` を `src` 削除 / `dst` 追加で更新。`replaceIfExists=true` の場合はクライアント側が先に `DeleteFileAsync(dst)` してから rename
- `MikuraServerBackend.CanDeleteAsync` をディレクトリにも許可するよう変更(以前はファイルのみ)

**Phase ロードマップ上の位置**:

ADR-021 の Phase B/C/D で WinFsp 統合が完了し、CfApi 時代の `feature/explorer-create-rename` ブランチに溜まっていたサーバ側作業を移植する形で本 ADR の機能を追加した。stash されていた `client/src/Mikura.Transport/HttpMikuraServer.cs` の API 拡張部分を WinFsp pivot 後の構造に取り込んだもの。

**未対応(Known limitation)**:

- ディレクトリ作成は **1 段だけ**(`recursive: false`)。Windows シェルが親→子の順に CreateFile を発行するため通常問題ないが、自動化スクリプトで深いツリーをまとめて作成するときは個別に POST する必要がある。
- 非空ディレクトリの削除挙動はサーバ `deleteFile` 実装依存。テストツリーで深いネストを削除する前に挙動確認が必要。

**実装場所**:

- `server/src/routes/files.ts`(POST `/folders/*` と PATCH `/files/*` のハンドラ)
- `server/src/services/file.service.ts`(`createFolder` / `renameEntry` 関数)
- `client/src/Mikura.Core/Abstractions/IMikuraServer.cs`(API 定義)
- `client/src/Mikura.Transport/HttpMikuraServer.cs`(HTTP 呼び出し)
- `client/src/Mikura.Core/Sync/MikuraServerBackend.cs`(WinFsp と接続)

**関連 ADR**:

- 前提: ADR-021(WinFsp 移行)
- 補完: ADR-022(rename 時のロックは write intent open に同等扱い)

---

## ADR-025: kernel write を直流する byte-range upload セッション

**決定**: WinFsp の `Write` callback で kernel から渡される `(offset, size, data)` を、**handle 単位の in-memory バッファに溜めず、サーバ側 upload session に逐次 PATCH で流す** pass-through 構造に切替える。Samba 代替として GB 級ファイルを扱う以上、ADR-023 の「ファイルサイズ ≒ クライアントメモリ」制約は実用上許容できないため、本 ADR で構造的に解消する。

**スタンス変更**: 当初 ADR は「将来検討」「実装しない」だったが、mikura のターゲット要件(Samba 代替、ファイルサーバ汎用用途)では大容量ファイルが第一級ユースケースであり、現行の in-memory staging 方式では成立しないと判断。**次フェーズで実装する** 位置付けに格上げ。

**動機(ADR-023 から引き継ぐ Known limitation)**:

- メモリ占有 ≒ ファイルサイズ(GB 級で破綻)
- 2GB 超で `OverflowException`
- 途中切断で先頭から再送
- 進捗表示不可
- HttpClient の 100 秒タイムアウトに低速回線で抵触

根本原因: 現行 `UploadFileAsync` が「ファイル全体を MemoryStream で渡す単一 PUT」のため、 **kernel の random write を sequential body に並べ直すために全 buffer を抱える必要がある**。byte-range PATCH 系のプロトコルなら、WinFsp `Write(offset, data)` をそのまま `PATCH /uploads/:id/:offset` に転送できる。

### コア設計判断 — pass-through 構造

WinFsp の `Write` callback が来たら、handle に紐付いた upload session に対して `PATCH` を発行して即返す。**handle 側に溜め込まない**。これにより:

- handle のメモリ占有はファイルサイズに比例しなくなる(in-flight chunk ぶんのみ)
- 2GB 制約が消える(int.MaxValue は in-memory buffer の制約だった)
- random write の順序保存は server temp file の `seek + write` が担当(自然)

ADR-023 の in-memory staging は **read 経路だけ残す**(Read 時の whole-file hydrate)。Write 経路は本 ADR で完全に書き換える。

### プロトコル

| Endpoint | 役割 |
|---|---|
| `POST /uploads` body: `{ path }` | upload session 作成、`{ uploadId }` 返却。`(deviceId, path)` で一意。lock holder と一致しなければ 403 |
| `PATCH /uploads/:uploadId` Header: `Content-Range: bytes <off>-<end>/<*>` body: bytes | 任意 offset への chunk 書き込み。サーバ側 temp file に `seek + write` |
| `POST /uploads/:uploadId/finalize` body: `{ size }` | `ftruncate(size)` → temp → 実 path に原子 rename → `/tree` 更新 → `UploadResult` 返却 |
| `DELETE /uploads/:uploadId` | 破棄(cancel / Cleanup without Modified)|
| `HEAD /uploads/:uploadId` | 再開用に現状の最大 written offset を返す(将来) |

KV スキーマ:

```typescript
["uploads", uploadId] → {
    uploadId: string,        // UUID v4
    deviceId: string,        // ADR-018: lock holder の deviceId
    userId: number,
    path: string,
    tempPath: string,        // <STAGING_ROOT>/<uploadId> (storage の外側、後述)
    createdAt: string,
    expiresAt: string,       // lock TTL と同期
}
```

### TBD 解決(本改訂で確定する)

**1. temp file の TTL 管理**

- upload session の TTL は **ADR-018 の Liveness lock TTL(30 秒)と一致** させ、WSS heartbeat で同期延長する
- lock が失効したら、その deviceId が持つ全 upload session を自動 abort(temp file 削除)
- 専用の TTL を持たないことで「lock 生存中はセッションも生存」「lock 失効=セッション失効」が SSOT になり、孤児 upload が原理的に発生しない

**2. finalize の原子性 と temp の配置**

- `temp → 実 path` は同一ファイルシステム内 `Deno.rename` で原子的(POSIX `rename(2)` 準拠)
- temp 領域は **`DATA_ROOT` の sibling** として `STAGING_ROOT`(デフォルト `cwd/staging`、`MIKURA_STAGING_ROOT` で override 可)に置く。**`DATA_ROOT` の中に置かない**:
  - 中に置くと `/tree` / `listDirectory` / `Deno.watchFs` の全 surface で「内部 path を毎回フィルタする」責務が漏れ出し、後から API を増やすたびに同じ filter を足す保守債務になる
  - Docker / k8s 化したとき、data(永続)と staging(再起動で消えていい、tmpfs にしてもいい)で**ボリューム永続化粒度を分けたい**。同一ディレクトリ配下だと選べない
  - 命名は「commit 前に積まれる場所」という DB / データパイプライン由来の語感を踏襲。`tmp` / `cache` は disposability(消していい)を誤って示唆するため避ける
- 同一 FS 制約: 両 root を `cwd` 直下に置く既定なら同 FS。env で別マウントに分離した場合は `Deno.rename` が `EXDEV` になり得るので、起動時 or finalize 時に検出して fallback(コピー+ unlink、原子性は失われるが finalize 1 回だけ)を入れる余地はある(現時点では未実装、要件が出た時に対応)
- クロスデバイス対応は将来要件として留保(Linux のクラスタ FS で運用する事案は現状想定しない)

**3. 権限チェック**

- **`POST /uploads`(start)で 1 回だけ** checkPermission + lock holder 一致確認
- session に紐付いた `(uploadId, deviceId)` を以後の PATCH/finalize で照合(認証はする、認可は再評価しない)
- 権限が mid-upload で剥奪された場合のレースは「次回 open / lock acquire 時に弾く」で割り切る(SMB も同様の挙動)

**4. client の async pipelining**

WinFsp の `Write` callback は IRP 単位で同期。各 callback で PATCH 完了まで待つと LAN でも RTT が積み上がる。

採用設計:

- handle ごとに **最大 N=8 in-flight chunk** の queue を持つ
- WinFsp `Write` 到着 → queue に enqueue + 即座に return(`Write` の戻り値 = 受領 byte 数)
- 背景タスクが queue から取り出して PATCH を順次発行(**同時 N 並列**)
- queue 満杯時のみ kernel `Write` をブロック(natural backpressure)
- `Cleanup(Modified)` で「queue drain 待ち → finalize」、`Cleanup(without Modified)` で「queue cancel → DELETE」
- いずれかの PATCH が失敗したら以降の Write は失敗を即返す(handle を壊れた状態にして上位に通知)
- 同一 offset への上書きはサーバ側 `seek+write` の単純後勝ちで OK(WinFsp が同 offset を並列に送ってくることは設計上ない)

**5. threshold の有無**

- **threshold を撤廃**、すべてのファイルを upload session 経由で送る
- 撤廃理由: 二経路保守のコストが「小ファイル 2 RTT 削減」のメリットに見合わない、かつ small write を coalesce すれば実用上の遅延差は小さい
- 0 byte ファイル(touch)は `POST /uploads` → `POST /uploads/:id/finalize { size: 0 }` の 2 回で完結
- ベンチマーク後に「単一 PUT fast path」を fallback として復活させる余地は残す

### 期待効果

| 観点 | 現状(単一 PUT)| 改訂(range PATCH 直流)|
|---|---|---|
| クライアントメモリ(1GB ファイル送信時)| ~1GB | **~N × chunk size**(数 MB〜数十 MB)|
| 上限ファイルサイズ | ~2GB | **無制限**(int64 offset)|
| 進捗表示 | 不可 | 可能(各 PATCH が progress)|
| 再開 | 不可 | 可能(`HEAD /uploads/:id` で確認 → 続きから)|
| WinFsp `Write` レイテンシ | 同上 | queue 受領時のみ実 IO 待ち |
| 業界類例 | — | tus.io / S3 multipart / Azure Block Blob |

### chunk size

WinFsp の `Write` callback の長さは典型 64 KB〜1 MB(IRP 由来、kernel が決める)。これをサーバ送信単位とそのまま一致させる(client 側で coalesce しない)。

サーバ /1 PATCH オーバーヘッドは ~10ms オーダなので、1 GB / 64 KB chunk = 16,384 req → in-flight 8 並列で 16,384 / 8 × 10ms ≒ 20 秒の累積。これは LAN の物理帯域(1 Gbps で 1GB ≒ 10 秒)に対して許容できる範囲。

将来チューニングする場合は client 側で「同 chunk 内連続 write は coalesce」を入れるが、初期実装ではしない。

### 実装メモ — `System.Buffers` / `System.IO.Pipelines` / `System.Threading.Channels`

write 側は「random offset の chunk を N 並列で送る producer-consumer」、read 側は「sequential ストリーム消費」と性質が違うので、それぞれに合った道具を使う。

**write 経路(本 ADR の本丸)**:

- in-flight queue は **`System.Threading.Channels.Channel<UploadChunk>`**(bounded capacity = N=8、`BoundedChannelFullMode.Wait` で natural backpressure)。Pipe は sequential なので random-offset の chunk 列を扱うのに向かない、Channel が自然。
- `UploadChunk` の payload は **`ArrayPool<byte>.Shared` から rent**(`System.Buffers`)。WinFsp `Write` 受領時に rent → コピー → enqueue、consumer が PATCH 送信完了後に `Return(buffer, clearArray: false)`。同一 ArrayPool を ADR-023 の hydrate 経路と共有しないため、chunked 専用の `ArrayPool<byte>.Create(maxArrayLength: 4 * 1024 * 1024, maxArraysPerBucket: 16)` を別途用意する。
- PATCH の HTTP body は **`ReadOnlyMemoryContent(rentedMemory)`** で投げる(`StreamContent(MemoryStream)` だと余計な wrap が増える)。

**read 経路の検討結果(PipeReader 化は不採用)**:

実装着手時に `EnsureHydratedAsync` を `PipeReader.Create(stream)` に置き換える方向で検討したが、**現行の実装の方が低オーバヘッド** と判断した(以下の理由により採用見送り):

- 現行は `_bufferPool.Rent(expectedSize)` で確定サイズの最終バッファを一度だけ取り、`HttpContent.ReadAsStreamAsync` の戻り値を `_buffer.AsMemory(off, len)` に**直接書き込む**(中間バッファゼロ)
- PipeReader を挟むと内部 segment(MemoryPool 由来)が新たな中間層になり、segment → 最終バッファへの追加コピーが発生する
- expectedSize は `_entry.Size` から既知なので Pipelines の「動的にバッファ拡張」の利点も効かない

PipeReader が本領を発揮するのは「サイズ不定の sequential ストリームを incremental に消化する」場合で、本機能(Read IRP は random offset、whole-file が必要)とは性質が合わない。

代わりに **server 側 PATCH 受信を ReadableStream → `Deno.FsFile.write` に直結** することで対称な改善を入れた(8MB chunk なら同等のメモリ削減効果)。

**handle にかかる buffer モデルの変化**:

現行(ADR-023): `byte[] _buffer` が論理ファイル全長を保持。
改訂後 write: `Channel<UploadChunk>` のみ(ファイル全長は持たない、in-flight ぶんだけ)。
改訂後 read: `Pipe` の内部 buffer が hydrate 進捗ぶんだけ持つ。read が完了した範囲は上位に渡し終えたら開放。

これにより handle ごとのメモリ占有が「ファイルサイズ依存」から「IRP の流量依存」に切り替わる。

### HTTP/2 との関係(切り離し)

ADR-010 の HTTP/2 化は本 ADR とは独立した経路最適化。HTTP/1.1 でも `MaxConnectionsPerServer = 8` で本 ADR の N=8 並列 PATCH は成立する。HTTP/2 移行時には 1 TCP/TLS 接続上の N stream 多重化に置き換わるが、本 ADR の設計に変更は不要。

### 関連 ADR

- 前提: ADR-021(WinFsp 移行)、ADR-023(in-memory staging — 本 ADR で write 経路だけ supersede)
- 連動: ADR-018(Liveness lock TTL を upload session TTL として流用)
- 関連: ADR-016(write lock holder = upload session 所有者)、ADR-026(ETag/If-Match による lost update 検出は finalize 段階に置く)

## ADR-027: WinFsp 非同期 response API(`SendReadResponse` 系)の温存

**決定**: 採用は当面**見送り**。ただし read-ahead を実装しても Q32 シナリオで並列度の頭打ちが残った場合の次手段として、調査結果を記録しておく。

### 背景

CDM Q32T1 などの「同一 handle に多数並列 IRP を投げる」ベンチマークで、観測された throughput が Q1T1 (160 MB/s) に対し Q32T1 (30 MB/s) と**逆転**する現象を踏んだ。perf-trace で `BackendFileSystem.Read` callback の thread 分布を取ると、`MountEx(ThreadCount=16, Synchronized=false)` を指定しても**実質 2 thread しか dispatch されない**ことが裏取れた。

切り分けの結果、ボトルネックは WinFsp 側ではなく **Windows kernel の Cache Manager が buffered I/O を per-handle 2 outstanding に直列化する設計上限**だと結論した。WinFsp `MaxRead` 系のチューニング knob は .NET binding (`Fsp.FileSystemHost`) に exposed されておらず、Mount/MountEx の `ThreadCount` を上げても効果無し、`Synchronized=false` も効果無し。

これらが空振りした上での「最後の余地」として、binding に存在する `GetOperationRequestHint` / `SendReadResponse` / `SendWriteResponse` / `SendReadDirectoryResponse` および `STATUS_PENDING` を使った**非同期 response パターン**を調査した。

### API の意味

WinFsp の callback は標準では同期で値を返すが、**callback 内で `STATUS_PENDING` を返すと操作が「未完了」のまま保留され、後で `Send*Response(hint, status, bytesTransferred)` を呼ぶことで完了通知できる**(ネイティブの `FspFileSystemSendResponse` を C# から叩く形)。

```csharp
public override int Read(...) {
    var hint = host.GetOperationRequestHint();   // 操作 ID
    Task.Run(async () => {
        try {
            var n = await _backend.ReadAsync(...);
            Marshal.Copy(...);   // IntPtr buffer は SendResponse まで生存保証
            host.SendReadResponse(hint, STATUS_SUCCESS, (uint)n);
        } catch (Exception ex) {
            host.SendReadResponse(hint, MapToNtStatus(ex), 0);
        }
    });
    pBytesTransferred = 0;
    return STATUS_PENDING;       // 即 return、worker thread 解放
}
```

### 期待効果

| 効果 | 確度 |
|---|---|
| WinFsp dispatcher worker thread が backend HTTP 完了を待たず即解放 | **確実**(API 仕様どおり) |
| backend I/O が ThreadPool で並列に進行 | **確実** |
| Cache Manager が「真の async FS」と認識し per-handle 並列上限を緩める可能性 | **未確認**(SMB/NFS 等 kernel-mode redirector が overlapped I/O 前提で動くため、kernel 側が「async なら待たない」と判定する経路が存在する可能性はあるが、WinFsp の user-mode 実装で同等の特権を得られるかは公式 doc に記載なし) |

### コストとリスク

- **buffer lifetime 管理が必須**: `IntPtr buffer` は WinFsp が保持する response 領域で、`SendResponse` を呼ぶまで生存保証される。**二重 response**(API 仕様違反)、**応答忘れ**(IRP リーク → 上位 app が hang)を絶対に出さない実装規律が要る
- **completion 順序が dispatch 順と異なる可能性**: 上位 app は overlapped I/O で発行しているはずなので問題ないが、ロジック上の前提として明記しておく必要あり
- **error path の網羅**: `STATUS_OBJECT_NAME_NOT_FOUND` / `STATUS_NETWORK_UNREACHABLE` / 汎用 IO error を全て `SendReadResponse(hint, ...)` 経由で返す必要あり、抜けると hang
- **`BackendFileSystem` に `FileSystemHost` 参照を保持する変更**(現状 `Init(host0)` で受けて捨てている)
- 実装規模: Read 単体で ~30 行追加、Write / ReadDirectory も同パターン化するなら ~100 行

### 判断

read-ahead(handle-local 先読みバッファ)の方が:

- **効果が予測可能**(kernel の挙動に依存せず、cache hit すれば 0 round-trip という確定論)
- **実装が backend 層で完結**(WinFsp 側の規約を変更しない)
- **失敗しても劣化が穏やか**(先読みが外れた場合は現状と同等の挙動)

なので**第一候補は read-ahead**。本 ADR の async response 化は「read-ahead を入れても Q32 シナリオで満足できる結果が出ない場合の次手段」として温存する。

### 関連 ADR

- 前提: ADR-021(WinFsp 移行で user-mode FS の制約を引き受けた点)、ADR-025(per-IRP HTTP 直流の write 経路)
- 競合候補: read-ahead 実装(別途 ADR 化予定)

---

## ADR-028: HTTP/2 採用見送り — Deno の HTTP/2 settings 非公開と PATCH 経路の不適合

**決定**: HTTP/2 への移行は当面**見送り**、**HTTP/1.1 cleartext のまま運用**する(TLS も導入しない)。Deno 側で HTTP/2 のチューニング項目が expose された時点で再検討する。

### 背景

ADR-025 の chunked upload と GET /content の Range read は、いずれも HTTP/1.1 の 8 conn cap で同時並列度が頭打ちになる。`MaxConnectionsPerServer = 8` を上げると connection ごとの内部 buffer が膨張してメモリを食う ([Mikura.App TrayAppContext.cs](../client/src/Mikura.App/Ui/TrayAppContext.cs))。

HTTP/2 multiplex を導入すれば 1 TCP 接続で多数 stream を同時に走らせられ、conn-per-server 上限が事実上消える。CDM RND 4K Q=32 T=16 Read のような **512 outstanding** ワークロードでは特に効くはず、という仮説で `feat/perf-instrumentation` ブランチで実機検証した。

### 検証で何が分かったか

1. **HTTP/2 multiplex は読み側で確かに効く**

   | Test | HTTP/1.1 (B2 ベース) | HTTP/2 (TLS, 16MB stream window) |
   |---|---|---|
   | **RND 4K Q=32 T=16 Read** | 2.06 MB/s | **2.90 MB/s** (+40%) |
   | SEQ 128K Q=32 Read | 91 | 79 (-14%) |
   | SEQ 1M Q=8 Read | 290-330 | 290 (横ばい) |

   512 outstanding が必要な RND Read で本来の効きどころが出た。低並列 SEQ Read は HTTP/2 framing オーバヘッドが乗って僅か劣化。

2. **書き側 (PATCH) は壊滅的に遅くなる**

   | Test | HTTP/1.1 | HTTP/2 |
   |---|---|---|
   | SEQ 1M Q=8 Write | 172-226 | **44** (-80%) |
   | SEQ 128K Q=32 Write | 152-169 | **54** (-65%) |

   原因は HTTP/2 の **per-stream initial window 64KB** (RFC 7540 default)。PATCH body 128KB なら 1 回、1MB なら **15 回** の `WINDOW_UPDATE` round-trip 待ちが per-chunk に発生する。LAN/loopback での 1 RTT (~0.5-1ms) が per-chunk に直接乗ってボディサイズに比例して悪化する。

3. **クライアント側 window 拡張は GET にしか効かない**

   .NET `SocketsHttpHandler.InitialHttp2StreamWindowSize = 16MB` を設定することで client 側の **受信** window は拡張できる。これは GET /content には効く (実測 SEQ 128K Read で改善)。ただし PATCH の **送信** window はサーバ側 (Deno) の receive window が支配するため、client 側の設定では救えない。

4. **Deno は HTTP/2 settings を expose していない**

   `Deno.serve({ cert, key })` の options は HTTP/2 周りのチューニング項目を一切受けない。内部実装の hyper crate には `http2_initial_stream_window_size` / `http2_adaptive_window` 等のオプションがあるが、Deno は 2026-06 時点で forwarding していない。`Deno.serve` 経由では window は default 64KB に強制固定される。

5. **GitHub 上の関連 issue/PR 調査結果** (2026-06 時点)

   - `denoland/deno#33332` (2026-04 merge): `node:http2` の settings validation (`initialWindowSize` 含む) を仕様準拠に修正
   - `denoland/deno#33640` (2026-04 merge): HTTP/2 stream window replenishment の挙動修正
   - `denoland/deno#26088` / `#29206` (closed): `http2.createSecureServer` 実装完了
   - `Deno.serve` 側に HTTP/2 settings を expose する PR は **存在せず**

### 却下した代替案

- **`node:http2` ベースのサーバラッパー (`createSecureServer` + `settings.initialWindowSize`)**: 技術的には可能、Hono の fetch handler を adapter ~100 行で繋げる。ただし mikura の `/events` (WebSocket upgrade) を Deno.upgradeWebSocket 経由で扱っている部分が node:http2 経路では使えず、WSS だけ別ポートで Deno.serve に逃がす二重構成になる。**実装コストに対して payoff が確証不足**(window 拡張が PATCH を救うか、結局 connection-level window や TCP backpressure で詰まるかは未検証)。一旦見送り、後述「再検討条件」で復活させる余地は残す。
- **Deno を fork して `http2_adaptive_window: true` を強制 ON**: 根本治療だが Rust 内部に手を入れる工数 + upstream 同期負債。
- **Cloudflare 等を front に置く**: edge が HTTP/2 / HTTP/3 を提供、origin は HTTP/1.1。LAN 想定で運用する mikura の用途とミスマッチ。将来インターネット公開する時には再評価。

### TLS も導入しない

HTTP/2 を採用しない以上、ALPN ネゴシエーション経路を保つ目的での TLS 導入も今回は **見送る**。HTTPS にすると dev cert の生成・配布・有効期限管理が運用負担になる一方、現状の mikura は LAN 内/単一信頼境界の用途想定で、平文 HTTP でも要件を満たす。

将来 HTTP/2 を再採用する判断になった際には:

1. TLS を有効化する(dev は self-signed、本番は正規 cert または Let's Encrypt)
2. ALPN で h2 を提示するようサーバ設定
3. client の `HttpVersion` を Version20 に切替

の順序でセットアップし直す。`deno task gen-cert` 相当の手順は再導入時に作り直す前提。

ADR-027 と同じく「採用は見送り、調査結果と将来の再開条件を記録」のスタンス。

### 再検討の条件

以下のいずれかが起きたら HTTP/2 採用を再評価する:

1. **Deno が `Deno.serve` で HTTP/2 settings を expose する** ── 特に `initialWindowSize` か `adaptiveWindow: true` 相当。これだけで PATCH 経路が解消される見込み(本 ADR が想定する最有力の再開トリガー)。
2. **hyper crate の `http2_adaptive_window` のデフォルトが true に変わる** ── Deno が forwarding しなくても恩恵を受ける可能性。upstream の挙動次第。
3. **mikura の運用がインターネット越し / Cloudflare 経由になる** ── edge が HTTP/2 / HTTP/3 を提供する世界では origin の選択肢が変わる。同時に TLS も外部要件で必須化される。
4. **クライアント並列度の上限 (`MaxConnectionsPerServer = 8`) が真のボトルネックになる** ── 現状の HTTP/1.1 + 8 conn でも RND 4K Q=32 T=16 Read の支配要因が他にあって HTTP/2 multiplex がブレイクスルーになる兆候が出た場合。

### 関連 ADR

- 前提: ADR-025(per-IRP HTTP 直流の write 経路、ChunkedUploader 構造)
- 関連調査: `feat/perf-instrumentation` ブランチの計測結果(diag instrumentation で server 側 phase timing + client 側 PATCH wall time を収集、ボトルネック箇所を特定)。本 ADR を採用した後、計測ブランチ自体は削除する(再調査の際は同じ instrumentation を書き直せばよい)

---

## ADR-029: クライアント側 write cache — range-coalesce + multipart/byteranges + path 単位 session 共有

**決定**: ADR-025 の per-IRP PATCH 直流方式を、3 層構造の write cache に置き換える:

1. **WriteCoalescer**: kernel `Write` IRP を 4MB バッファに range pack して 1 PATCH に集約
2. **multipart/byteranges PATCH**: 非連続な複数 range を 1 リクエストで送る独自拡張
3. **per-path SessionSlot**: 同一 path への複数 handle で upload session を共有 (refcount + TCS pattern)

### 背景

ADR-025 で「kernel `Write` IRP をその場で PATCH に直流」を採用したが、実運用負荷で 3 つの問題が顕在化した:

1. **per-IRP PATCH の HTTP round-trip オーバーヘッド**: WinFsp は典型 64KB-1MB の IRP を多数発行する。CDM SEQ 1M Q=8 Write でも数千 PATCH が直列に近い形で並ぶ
2. **小さい random write の集約不足**: Excel / SQLite / CDM RND 4K のような散発書き込みが 1 IRP = 1 PATCH = 1 round-trip を踏み、何百という小 PATCH を生む
3. **複数 handle 同 path の session 重複**: CDM RND 4K Q=32 T=**16** が 16 file handle を開くと、各 ServerHandle が独立に `StartUploadAsync(baseFromExisting=true)` を呼び、**16 × 1GB の base copy** で server disk が飽和 (実機 ~300 MB/s × 53 秒) して測定窓を食い尽くす

(3) が最も影響が大きく、CDM RND 4K Q=32 T=16 Write が **0.007 MB/s** という壊滅的な数字を出していた根本原因。

### 設計

#### Layer 1: WriteCoalescer (range-list buffer)

ServerHandle 単位ではなく **SessionSlot 単位 (= path 単位)** に 1 つ。kernel IRP が来ると:

```
buf: byte[4MB]                          // ArrayPool 共有
ranges: List<(FileOffset, BufOffset, Length)>
```

- IRP のペイロードを `buf` の末尾に `_bufFilled` 位置から copy
- 直前 range と file offset 上で連続 (`last.FileOffset + last.Length == fileOffset`) なら range を末尾延長 (merge)、非連続なら新規 range を append
- バッファ満杯 (4MB) / `MaxRanges` (4096) / idle timeout (50ms) で flush

flush 時:

- ranges 1 本だけ → single-range PATCH (`UploadChunkAsync`, multipart overhead を払わない)
- ranges N 本 → multipart/byteranges PATCH (`UploadChunksMultipartAsync`)

target サイズ超 (≥4MB) の 1 IRP は coalesce せず単 range PATCH に直送。

**1-deep pipeline**: flush が始まった瞬間、background `Task` に send を放して `_inFlightFlush` に保管。直後の append は新バッファに対して走れる (`_gate` は瞬時に解放される)。次の flush は前 send を await してから自分の send を kick することで、(a) **1 本だけ in-flight** に bound、(b) **PATCH 順序保証** を両立する。

#### Layer 2: multipart/byteranges を request body に流用

複数 range を 1 PATCH で送るために、RFC 7233 §A の `multipart/byteranges` (本来は response 用 media type) を request body として転用する。

**形式**:
```
PATCH /uploads/:uploadId
Content-Type: multipart/byteranges; boundary=mikura-<guid>

\r\n--BOUNDARY\r\n
Content-Type: application/octet-stream\r\n
Content-Range: bytes 0-499/*\r\n
\r\n
<500 bytes>\r\n--BOUNDARY\r\n
Content-Type: application/octet-stream\r\n
Content-Range: bytes 1000-1499/*\r\n
\r\n
<500 bytes>\r\n--BOUNDARY--\r\n
```

- **server side**: `server/src/util/multipartByteranges.ts` に streaming parser。各 part の `Content-Range` から `(offset, length)` を抜き、body 本体は逐次 sink (Deno.write per chunk) へ流して RAM 展開しない
- **client side**: `System.Net.Http.MultipartContent("byteranges", boundary)` がそのまま使える。`ReadOnlyMemoryContent` で coalescer の 4MB バッファをスライスして part を作るので zero-copy

**part 1 つあたりのオーバーヘッド**: ~110B (boundary + Content-Type + Content-Range + 2× CRLF)。実用ケースの比率:

| ワークロード | range 数 | payload | overhead |
|---|---|---|---|
| SEQ 1M (contig merge 後) | 1 | 4MB | 0% (single-range 経路) |
| CDM RND 4K Q=32 batched | 64 | 256KB | 2.7% |
| Excel sparse save batched | 16 | 200KB | 0.9% |

**仕様面の選択**: HTTP 標準は Content-Range 多 range を request 側で規定していないので、独自 Content-Range 多 range 値 (`bytes 0-30,45-50/*`) は L7 WAF が malformed と判断するリスクがある (Cloudflare backend 等で実例)。一方 `multipart/byteranges` は RFC 7233 で正式に定義された media type なので、Content-Type だけ見て pass する WAF を通る公算が高い。両端を mikura で制御するが、将来 reverse proxy 経由運用を想定して標準準拠側を選択。

#### Layer 3: per-path SessionSlot (refcount + TCS)

ADR-016/022 の `LockSlot` と同じパターン:

```csharp
class SessionSlot {
    int Refcount
    string UploadId         // 最初の caller が StartUpload して埋める
    WriteCoalescer Coalescer
    TaskCompletionSource<bool> StartResult   // 2 番目以降の Acquire はこれを await
    long MaxFinalSize        // 全 handle の h.Length の max
    bool AnyModified
}

Dictionary<string, SessionSlot> _activeSessions   // path keyed
```

- `AcquireSessionSlotAsync(path, baseFromExisting)`: 最初の caller のみ `StartUploadAsync` を実走。後続は `StartResult.Task` を await して同じ slot を共有
- `EnqueueChunkAsync`: `slot.Coalescer.AppendAsync` を呼ぶ (全 handle で共有された 1 つのバッファに append)
- `ReleaseSessionSlotForFinalizeAsync`: refcount-- → 0 になった (= 最後の handle) ケースだけ実 `Flush` + `FinalizeUploadAsync` を実走。それ以外は `null` を返し、caller (`CleanupAsync`) は `_tree` 更新をスキップ
- `ReleaseSessionSlotForAbortAsync`: 同様に refcount-- → 0 のときだけ実 abort

**Mixed baseFromExisting** (1 handle が `CreateAsync`、別 handle が `OpenAsync` で write) は **最初の caller の判定を採用**。実用上は 16 個同時 open がすべて同じ intent なので影響なし。万一 mixed の場合は最初の caller の `baseFromExisting=true` が採用されて 1GB copy が 1 回だけ走る。

### 計測 (CDM 9.0.2, 1 GiB×3, WSL2 LAN)

|  | ADR-025 baseline (HTTP/1.1) | ADR-029 (write cache) |
|---|---|---|
| SEQ 1M Q=8 Write | 80 MB/s | 81 MB/s |
| SEQ 128K Q=32 Write | 54 MB/s | 76 MB/s (+40%) |
| **RND 4K Q=32 T=16 Write** | **0.007 MB/s** | **22.6 MB/s** (**~3000×**) |
| RND 4K Q=1 T=1 Write | 16.7 MB/s | 21.8 MB/s (+30%) |
| SEQ 1M Q=8 Read | 326 MB/s | 342 MB/s |
| RND 4K Q=32 T=16 Read | 2.33 MB/s | 2.57 MB/s |

クライアントプロセス常駐メモリ (RND Q=32 Write 中): **~300 MB → ~50 MB** (16 個の per-handle coalescer + 1-deep pipeline buf が 1 個に集約された結果)。

3000× の支配的要因は **per-path session sharing**。Layer 1/2 (coalesce + multipart) は単体では SEQ 128K Q=32 で +40% 程度の効きで、Layer 3 が無いとそもそも測定窓が base copy で埋まって観測できなかった。

### 残存する天井

SEQ 1M Write 80 MB/s 頭打ちは依然 transport-bound (HTTP/1.1 single connection + multipart serialize + WSL2)。server 側 disk は ~300 MB/s 出ているので、さらなる write スループット改善は:

- **並列 PATCH を許可** (1-deep pipeline → N-deep): 順序保証のために in-flight 中の PATCH 間で server 側 atomic 化が必要
- **HTTP/2 stream multiplex 復活**: ADR-028 のブロッカー (Deno.serve の HTTP/2 settings 非公開) が解消すれば候補

のいずれか。優先度は ADR-028 の再開条件に従う。

### 却下した代替案

- **独自 Content-Range 多 range 値** (`Content-Range: bytes 0-30,45-50/*`): wire 形式は最小だが HTTP 仕様外で WAF/proxy 通過性が不透明。multipart/byteranges を選択
- **per-thread / global キャッシュ**: SessionSlot を path 単位ではなく thread / process global に持つ案。session lifecycle (start/finalize/abort) の同期が複雑化し、Cleanup 順と finalize 順がずれるケースで _tree 整合が取れなくなる。per-path で十分
- **N-deep pipeline (in-flight PATCH 並列度を 2 以上)**: 1-deep でも RND Q=32 Write が 22.6 MB/s 出るので必要性が低い。順序保証の追加コストに見合わない

### 関連 ADR

- 前提: ADR-025 (chunked upload session の wire protocol そのものは流用)
- 前提: ADR-016/022 (LockSlot pattern を SessionSlot で再利用)
- 関連: ADR-028 (HTTP/2 が解禁されれば SEQ Write 天井を上げられる可能性)
