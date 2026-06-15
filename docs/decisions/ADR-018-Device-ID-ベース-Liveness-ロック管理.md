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
