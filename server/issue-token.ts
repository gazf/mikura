import { createAppToken } from "./src/services/auth.service.ts";
import { closeKv, getKv } from "./src/kv/store.ts";
import { Keys } from "./src/kv/keys.ts";

const kv = await getKv();
const adminIdEntry = await kv.get<number>(Keys.userByName("admin"));
if (!adminIdEntry.value) {
  console.error("admin user not found. Run: deno task seed");
  closeKv();
  Deno.exit(1);
}

const { raw } = await createAppToken(adminIdEntry.value, "reissued-token");
console.log(`Bearer token: ${raw}`);
closeKv();
