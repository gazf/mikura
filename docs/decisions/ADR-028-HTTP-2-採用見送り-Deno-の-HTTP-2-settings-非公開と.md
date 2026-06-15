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
