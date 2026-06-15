# Architecture Decision Records

実装に大きな影響を与える設計判断を、決定事項・選択肢・選択理由を残す形で記録する。
各 ADR は個別ファイルに分かれている。

| # | タイトル |
|---|---|
| ADR-001 | [プロトコル選択 — CfApi + HTTPS](ADR-001-プロトコル選択-CfApi-+-HTTPS.md) |
| ADR-002 | [Vanara.PInvoke.CldApi の不採用](ADR-002-Vanara.PInvoke.CldApi-の不採用.md) |
| ADR-003 | [レイヤー構造 — 5 層](ADR-003-レイヤー構造-5-層.md) |
| ADR-004 | [オフライン時の挙動 — 読み取り専用または使用不可](ADR-004-オフライン時の挙動-読み取り専用または使用不可.md) |
| ADR-005 | [コンフリクト解決 — サーバー側ロック(初版)](ADR-005-コンフリクト解決-サーバー側ロック初版.md) |
| ADR-006 | [イベント通知 — WebSocket(WSS)採用](ADR-006-イベント通知-WebSocketWSS採用.md) |
| ADR-007 | [認証 — OIDC + JWT](ADR-007-認証-OIDC-+-JWT.md) |
| ADR-008 | [権限モデル — パス + プリンシパル × アクション](ADR-008-権限モデル-パス-+-プリンシパル-×-アクション.md) |
| ADR-009 | [Zero Alloc の適用範囲](ADR-009-Zero-Alloc-の適用範囲.md) |
| ADR-010 | [HTTP/2 の採用(将来)](ADR-010-HTTP-2-の採用将来.md) |
| ADR-011 | [テスト戦略](ADR-011-テスト戦略.md) |
| ADR-012 | [OpenAPI / TypeSpec の不採用(現時点)](ADR-012-OpenAPI-TypeSpec-の不採用現時点.md) |
| ADR-013 | [プレースホルダー戦略 — ALWAYS_FULL + WSS イベント駆動](ADR-013-プレースホルダー戦略-ALWAYS_FULL-+-WSS-イベント駆動.md) |
| ADR-014 | [ハイブリッド修正検出 — open/close ウィンドウ + 同期時刻ベース](ADR-014-ハイブリッド修正検出-open-close-ウィンドウ-+-同期時刻ベース.md) |
| ADR-015 | [oplock ハンドル開閉戦略](ADR-015-oplock-ハンドル開閉戦略.md) |
| ADR-016 | [ロック取得タイミング — open 時 + Liveness ベース管理](ADR-016-ロック取得タイミング-open-時-+-Liveness-ベース管理.md) |
| ADR-017 | [コンフリクトファイル戦略 — 異常事態の最終手段](ADR-017-コンフリクトファイル戦略-異常事態の最終手段.md) |
| ADR-018 | [Device ID ベース Liveness ロック管理](ADR-018-Device-ID-ベース-Liveness-ロック管理.md) |
| ADR-019 | [ファイル属性をレスポンスヘッダで伝達](ADR-019-ファイル属性をレスポンスヘッダで伝達.md) |
| ADR-020 | [close 時の常時 dehydrate — VPN 越し SMB 同等の動作モデル](ADR-020-close-時の常時-dehydrate-VPN-越し-SMB-同等の動作モデル.md) |
| ADR-021 | [ファイル投影レイヤーを CfApi から WinFsp へ移行](ADR-021-ファイル投影レイヤーを-CfApi-から-WinFsp-へ移行.md) |
| ADR-022 | [WinFsp 上のロック取得スコープ — write-intent + プロセス内 refcount](ADR-022-WinFsp-上のロック取得スコープ-write-intent-+-プロセス内.md) |
| ADR-023 | [in-memory staging buffer の設計と上限](ADR-023-in-memory-staging-buffer-の設計と上限.md) |
| ADR-024 | [フォルダ作成 + rename サポート(サーバ endpoint 拡張)](ADR-024-フォルダ作成-+-rename-サポートサーバ-endpoint-拡張.md) |
| ADR-025 | [kernel write を直流する byte-range upload セッション](ADR-025-kernel-write-を直流する-byte-range-upload-セッシ.md) |
| ADR-027 | [WinFsp 非同期 response API(`SendReadResponse` 系)の温存](ADR-027-WinFsp-非同期-response-API`SendReadResponse.md) |
| ADR-028 | [HTTP/2 採用見送り — Deno の HTTP/2 settings 非公開と PATCH 経路の不適合](ADR-028-HTTP-2-採用見送り-Deno-の-HTTP-2-settings-非公開と.md) |
| ADR-029 | [クライアント側 write cache — range-coalesce + multipart/byteranges + path 単位 session 共有](ADR-029-クライアント側-write-cache-range-coalesce-+-mul.md) |
| ADR-030 | [WriteCoalescer の ArrayPool 選定 — bounded `maxArraysPerBucket=16` を採用](ADR-030-WriteCoalescer-の-ArrayPool-選定-bounded-`m.md) |
| ADR-031 | [Read 経路の per-handle read-ahead prefetch cache (Samba 流 next-sequential)](ADR-031-Read-経路の-per-handle-read-ahead-prefetch.md) |
| ADR-032 | [WinFsp .NET binding を自前 modern P/Invoke に置き換え](ADR-032-WinFsp-.NET-binding-を自前-modern-P-Invoke.md) |
