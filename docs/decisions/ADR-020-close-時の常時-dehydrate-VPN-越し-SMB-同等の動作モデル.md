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
