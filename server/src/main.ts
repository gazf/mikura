import app from "./app.ts";
import { initFileLogger } from "./util/fileLogger.ts";
import { ensureDataRoot, getDataRoot } from "./services/file.service.ts";
import { initializeStagingRoot } from "./services/upload.service.ts";
import { loadActivePolicy } from "./services/policy.service.ts";

initFileLogger();

const port = parseInt(Deno.env.get("MIKURA_PORT") ?? "8700", 10);

// data / staging dir は recursive mkdir で起動時に必ず実体化させる。
// data が無い状態だと /tree が 404、/volume が 500 で client の
// InitializeAsync が落ちる。staging は最初の upload で auto-create だが
// 揃えておく方が診断時に状態が読み取りやすい。
await ensureDataRoot();
await initializeStagingRoot();

// ADR-035: 保存済みポリシーをここで 1 度パースする。壊れていたら **起動を止める**。
// 全拒否のまま起動すると「誰も何も見えない」だけが観測され、権限設定のバグに
// 見えて誤診される。保存時に検証しているので、ここに来るのは形式変更か KV 破損。
try {
  const state = await loadActivePolicy();
  if (!state.hasAdmin) {
    // 起動は止めない (seed 前は正当にこの状態を通る) が、黙って通すと
    // 「全部見えない・管理画面に入れない」だけが観測され、権限設定の
    // バグに見えて誤診される。復旧コマンドをそのまま出す。
    console.warn(
      "[WARN] admin 権限を持つユーザーが 1 人もいません。" +
        (state.version === 0
          ? " アクセス制御ポリシーがまだ投入されていません。"
          : ` (ポリシー版 ${state.version})`) +
        "\n       すべてのアクセスが拒否され、管理コンソールにもログインできません。" +
        "\n       復旧: server を止めて `deno task seed --grant-admin` を実行してください。",
    );
  }
} catch (e) {
  console.error(
    `[FATAL] アクセス制御ポリシーを読み込めません。起動を中止します。\n${
      e instanceof Error ? e.message : e
    }`,
  );
  Deno.exit(1);
}

console.log(`mikura server starting on port ${port} (data=${getDataRoot()})`);

// hostname に "::" を指定して IPv6 で listen する。Linux/Windows いずれも
// IPV6_V6ONLY=0 が既定なので、IPv4-mapped IPv6 経由で IPv4 も受け付ける。
// 既定 (= "0.0.0.0") のままだと IPv4 のみ bind し、client 側で `localhost`
// を解決して `::1` を先に試した場合に TCP SYN リトライで ~21 秒の接続遅延
// になる (Happy Eyeballs fallback)。dev/local の体感を悪化させる主犯だった。
Deno.serve({ port, hostname: "::" }, app.fetch);
