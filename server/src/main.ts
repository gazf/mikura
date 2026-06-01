import app from "./app.ts";
import { initFileLogger } from "./util/fileLogger.ts";
import { ensureDataRoot, getDataRoot } from "./services/file.service.ts";
import { initializeStagingRoot } from "./services/upload.service.ts";
import { warmupEphemeralFromPersistent } from "./kv/store.ts";

initFileLogger();

const port = parseInt(Deno.env.get("MIKURA_PORT") ?? "8700", 10);

// data / staging dir は recursive mkdir で起動時に必ず実体化させる。
// data が無い状態だと /tree が 404、/volume が 500 で client の
// InitializeAsync が落ちる。staging は最初の upload で auto-create だが
// 揃えておく方が診断時に状態が読み取りやすい。
await ensureDataRoot();
await initializeStagingRoot();

// users / groups / permissions の hot path read を :memory: KV に乗せる。
// mikura はこれらを runtime に書き換える API を持たないので、startup の
// 1 回 mirror で persistent と同一スナップショットを取れる。
const warmed = await warmupEphemeralFromPersistent();
console.log(`mikura ephemeral KV warmed: ${warmed} entries`);

console.log(`mikura server starting on port ${port} (data=${getDataRoot()})`);

// hostname に "::" を指定して IPv6 で listen する。Linux/Windows いずれも
// IPV6_V6ONLY=0 が既定なので、IPv4-mapped IPv6 経由で IPv4 も受け付ける。
// 既定 (= "0.0.0.0") のままだと IPv4 のみ bind し、client 側で `localhost`
// を解決して `::1` を先に試した場合に TCP SYN リトライで ~21 秒の接続遅延
// になる (Happy Eyeballs fallback)。dev/local の体感を悪化させる主犯だった。
Deno.serve({ port, hostname: "::" }, app.fetch);
