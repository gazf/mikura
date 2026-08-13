/**
 * ADR-035 の保管層の責務:
 *   - 保存は 検証 → 割り当て層の拒否権 → admin 不在検査 の順に落ちる
 *   - 版は単調に増え、原文が残る (diff / rollback の土台)
 *   - 割り当ての変更が判定へ即座に反映される (メモリキャッシュを落とし損ねない)
 *   - 解釈できない版が保存されていれば読み込みで throw する (= 起動を止める)
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Keys } from "../src/kv/keys.ts";
import {
  assignRole,
  getActivePolicy,
  getActivePolicyWithVersion,
  getUserRoles,
  installBootstrapPolicy,
  listPolicyVersions,
  PolicyLoadError,
  type PolicyVersion,
  savePolicy,
  unassignRole,
} from "../src/services/policy.service.ts";
import { effectiveLevel } from "../src/policy/evaluate.ts";
import { withTestKv } from "./_helpers.ts";

const BASE = `role admins {
  allow admin /
}

test admins {
  admin /
}
`;

async function bootstrap(): Promise<void> {
  await installBootstrapPolicy(BASE, 1);
  const res = await assignRole(1, "admins");
  assert(res.ok, res.error);
}

Deno.test("未 seed のポリシーは空 = 誰も何もできない (既定 deny)", async () => {
  await withTestKv(async () => {
    const { version, policy } = await getActivePolicyWithVersion();
    assertEquals(version, 0);
    assertEquals(effectiveLevel(policy, ["admins"], "/"), null);
  });
});

Deno.test("savePolicy: 版が単調に増え、原文が残る", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const first = (await getActivePolicyWithVersion()).version;

    const res = await savePolicy({
      text: BASE + "\nrole viewers {\n  allow read /shared\n}\n",
      createdBy: 1,
    });
    assert(res.ok);
    assertEquals(res.version, first + 1);

    const versions = await listPolicyVersions();
    assertEquals(versions.map((v: PolicyVersion) => v.version), [
      first + 1,
      first,
    ]);
    assert(versions[1].text === BASE);
  });
});

Deno.test("savePolicy: admin が 1 人もいなくなる版は却下し、現行版を守る", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await savePolicy({
      text: "role admins {\n  allow read /\n}\n",
      createdBy: 1,
    });
    assertEquals(res.ok, false);
    assert(res.rejection);
    // 現行版は無傷
    assertEquals(
      effectiveLevel(await getActivePolicy(), ["admins"], "/"),
      "admin",
    );
  });
});

Deno.test("savePolicy: 保存できなかった版は KV に残らない", async () => {
  await withTestKv(async (kv) => {
    await bootstrap();
    const before = (await getActivePolicyWithVersion()).version;
    await savePolicy({ text: "role broken {", createdBy: 1 });
    assertEquals((await kv.get<number>(Keys.policyCurrent())).value, before);
    assertEquals((await listPolicyVersions()).length, 1);
  });
});

Deno.test("savePolicy: expectedVersion がずれていれば拒否する", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await savePolicy({
      text: BASE,
      createdBy: 1,
      expectedVersion: 99,
    });
    assertEquals(res.ok, false);
    assert(res.rejection?.includes("読み直して"));
  });
});

Deno.test("assignRole / unassignRole: 判定へ即座に反映される", async () => {
  await withTestKv(async () => {
    await bootstrap();
    await savePolicy({
      text: BASE + "\nrole viewers {\n  allow read /shared\n}\n",
      createdBy: 1,
    });

    assertEquals(await getUserRoles(2), []);
    assert((await assignRole(2, "viewers")).ok);
    assertEquals([...await getUserRoles(2)], ["viewers"]);
    assertEquals(
      effectiveLevel(await getActivePolicy(), await getUserRoles(2), "/shared"),
      "read",
    );

    assert((await unassignRole(2, "viewers")).ok);
    assertEquals([...await getUserRoles(2)], []);
  });
});

Deno.test("assignRole: 未定義のロールは割り当てられない", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await assignRole(2, "ghost");
    assertEquals(res.ok, false);
    assert(res.error?.includes("定義されていません"));
  });
});

Deno.test("assignRole: 文書側の綴りに正規化して保存する", async () => {
  await withTestKv(async () => {
    await bootstrap();
    assert((await assignRole(2, "ADMINS")).ok);
    assertEquals([...await getUserRoles(2)], ["admins"]);
  });
});

Deno.test("unassignRole: 最後の admin は外せない", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await unassignRole(1, "admins");
    assertEquals(res.ok, false);
    assertEquals([...await getUserRoles(1)], ["admins"]);
  });
});

Deno.test("解釈できない版が保存されていたら読み込みで throw する", async () => {
  await withTestKv(async (kv) => {
    await bootstrap();
    // 保存経路は検証するので、壊れた状態は KV 直書きでしか作れない
    // (= 形式変更か KV 破損の再現)。
    const version = (await getActivePolicyWithVersion()).version;
    await kv.set(Keys.policyVersion(version), {
      version,
      text: "role broken {\n  allow sideways /\n}\n",
      createdAt: new Date().toISOString(),
      createdBy: 1,
    });
    const { _resetPolicyCachesForTesting } = await import(
      "../src/services/policy.service.ts"
    );
    _resetPolicyCachesForTesting();

    await assertRejects(
      () => getActivePolicy(),
      PolicyLoadError,
      "解釈できません",
    );
  });
});

Deno.test("適用中の版が消えていたら読み込みで throw する", async () => {
  await withTestKv(async (kv) => {
    await bootstrap();
    const version = (await getActivePolicyWithVersion()).version;
    await kv.delete(Keys.policyVersion(version));
    const { _resetPolicyCachesForTesting } = await import(
      "../src/services/policy.service.ts"
    );
    _resetPolicyCachesForTesting();

    await assertRejects(() => getActivePolicy(), PolicyLoadError);
  });
});
