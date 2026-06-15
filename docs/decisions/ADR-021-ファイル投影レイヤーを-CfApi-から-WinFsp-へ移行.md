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
