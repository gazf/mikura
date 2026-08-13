/**
 * ADR-036 の保管層の責務:
 *   - 保存は 検証 → 割り当て層の拒否権 → admin 不在検査 の順に落ちる
 *   - 保存のたびにそのロールの世代が 1 つ積まれ、古い世代は上限で落ちる
 *   - 世代の切り替えと有効・無効の切り替えは世代を増やさない
 *   - 割り当ての変更が判定へ即座に反映される (メモリキャッシュを落とし損ねない)
 *   - 定義が読めなければ throw する (= 起動を止める)
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Keys } from "../src/kv/keys.ts";
import {
  activateGeneration,
  assignRole,
  deleteRole,
  findAdminRoleNames,
  getActivePolicy,
  getUserRoles,
  importPolicyText,
  listRoleGenerations,
  listRoles,
  loadActivePolicy,
  PolicyLoadError,
  putRoleUnchecked,
  saveRole,
  setRoleEnabled,
  unassignRole,
} from "../src/services/policy.service.ts";
import { effectiveLevel } from "../src/policy/evaluate.ts";
import { withTestKv } from "./_helpers.ts";

/** admin ロールを 1 つ用意して userId=1 に割り当てる。 */
async function bootstrap(): Promise<void> {
  await putRoleUnchecked("admins", true, {
    rules: [{ path: "/", level: "admin" }],
    tests: [{ expect: "admin", path: "/" }],
  }, 1);
  const res = await assignRole(1, "admins");
  assert(res.ok, res.error);
}

Deno.test("ロールが 1 つも無ければ誰も何もできない (既定 deny)", async () => {
  await withTestKv(async () => {
    const state = await loadActivePolicy();
    assertEquals(state.roleCount, 0);
    assertEquals(state.hasAdmin, false);
  });
});

Deno.test("saveRole: 保存のたびにそのロールの世代が 1 つ積まれる", async () => {
  await withTestKv(async () => {
    await bootstrap();

    const first = await saveRole({
      name: "viewers",
      enabled: true,
      definition: { rules: [{ path: "/shared", level: "read" }], tests: [] },
      updatedBy: 1,
    });
    assert(first.ok);
    assertEquals(first.generation, 1);

    const second = await saveRole({
      name: "viewers",
      enabled: true,
      definition: {
        rules: [
          { path: "/shared", level: "read" },
          { path: "/docs", level: "read" },
        ],
        tests: [],
      },
      updatedBy: 1,
    });
    assertEquals(second.generation, 2);

    const generations = await listRoleGenerations("viewers");
    assertEquals(generations.map((g) => g.generation), [2, 1]);
    // 他のロールの世代は増えていない
    assertEquals((await listRoleGenerations("admins")).length, 1);
  });
});

Deno.test("saveRole: 古い世代は上限を超えたら落ちる", async () => {
  await withTestKv(async () => {
    await bootstrap();
    for (let i = 0; i < 13; i++) {
      const res = await saveRole({
        name: "viewers",
        enabled: true,
        definition: {
          rules: [{ path: `/shared${i}`, level: "read" }],
          tests: [],
        },
        updatedBy: 1,
      });
      assert(res.ok, JSON.stringify(res));
    }
    const generations = await listRoleGenerations("viewers");
    assertEquals(generations.length, 10);
    // 残るのは新しい方
    assertEquals(generations[0].generation, 13);
    assertEquals(generations[9].generation, 4);
  });
});

Deno.test("activateGeneration: 世代を戻しても世代は増えない", async () => {
  await withTestKv(async () => {
    await bootstrap();
    await saveRole({
      name: "viewers",
      enabled: true,
      definition: { rules: [{ path: "/shared", level: "read" }], tests: [] },
      updatedBy: 1,
    });
    await saveRole({
      name: "viewers",
      enabled: true,
      definition: { rules: [{ path: "/shared", level: "write" }], tests: [] },
      updatedBy: 1,
    });
    await assignRole(2, "viewers");
    assertEquals(
      effectiveLevel(await getActivePolicy(), ["viewers"], "/shared"),
      "write",
    );

    const res = await activateGeneration("viewers", 1, 1);
    assert(res.ok, JSON.stringify(res));
    assertEquals(
      effectiveLevel(await getActivePolicy(), ["viewers"], "/shared"),
      "read",
    );
    assertEquals((await listRoleGenerations("viewers")).length, 2);
  });
});

Deno.test("activateGeneration: 残っていない世代は拒否", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await activateGeneration("admins", 99, 1);
    assertEquals(res.ok, false);
    assert(res.errors[0].message.includes("残っていません"));
  });
});

Deno.test("setRoleEnabled: 無効にすると権限を与えなくなるが定義と割り当ては残る", async () => {
  await withTestKv(async () => {
    await bootstrap();
    await saveRole({
      name: "viewers",
      enabled: true,
      definition: { rules: [{ path: "/shared", level: "read" }], tests: [] },
      updatedBy: 1,
    });
    await assignRole(2, "viewers");

    const off = await setRoleEnabled("viewers", false, 1);
    assert(off.ok, JSON.stringify(off));
    assertEquals(
      effectiveLevel(await getActivePolicy(), await getUserRoles(2), "/shared"),
      null,
    );
    // 定義も割り当ても残っている
    assertEquals([...await getUserRoles(2)], ["viewers"]);
    const view = (await listRoles()).find((r) => r.name === "viewers");
    assertEquals(view?.rules.length, 1);
    // 世代は増えていない (無効化は定義の変更ではない)
    assertEquals((await listRoleGenerations("viewers")).length, 1);

    const on = await setRoleEnabled("viewers", true, 1);
    assert(on.ok);
    assertEquals(
      effectiveLevel(await getActivePolicy(), await getUserRoles(2), "/shared"),
      "read",
    );
  });
});

Deno.test("setRoleEnabled: 最後の admin ロールは無効にできない", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await setRoleEnabled("admins", false, 1);
    assertEquals(res.ok, false);
    assert(res.rejection);
    assertEquals(
      effectiveLevel(await getActivePolicy(), ["admins"], "/"),
      "admin",
    );
  });
});

Deno.test("無効なロールでもロール単体テストは走る", async () => {
  await withTestKv(async () => {
    await bootstrap();
    // 無効でも、テストが通らない定義は保存できない
    const bad = await saveRole({
      name: "viewers",
      enabled: false,
      definition: {
        rules: [{ path: "/shared", level: "read" }],
        tests: [{ expect: "writable", path: "/shared" }],
      },
      updatedBy: 1,
    });
    assertEquals(bad.ok, false);
    assertEquals(bad.testFailures.length, 1);

    const good = await saveRole({
      name: "viewers",
      enabled: false,
      definition: {
        rules: [{ path: "/shared", level: "read" }],
        tests: [{ expect: "readable", path: "/shared" }],
      },
      updatedBy: 1,
    });
    assert(good.ok, JSON.stringify(good));
  });
});

Deno.test("saveRole: admin が 1 人もいなくなる変更は却下し、現状を守る", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await saveRole({
      name: "admins",
      enabled: true,
      definition: { rules: [{ path: "/", level: "read" }], tests: [] },
      updatedBy: 1,
    });
    assertEquals(res.ok, false);
    assert(res.rejection);
    assertEquals(
      effectiveLevel(await getActivePolicy(), ["admins"], "/"),
      "admin",
    );
    assertEquals((await listRoleGenerations("admins")).length, 1);
  });
});

Deno.test("saveRole: dryRun は KV を変えない", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await saveRole({
      name: "viewers",
      enabled: true,
      definition: { rules: [{ path: "/shared", level: "read" }], tests: [] },
      updatedBy: 1,
    }, { dryRun: true });
    assert(res.ok);
    assertEquals((await listRoles()).map((r) => r.name), ["admins"]);
  });
});

Deno.test("deleteRole: 宙に浮いた割り当てを残さない", async () => {
  await withTestKv(async (kv) => {
    await bootstrap();
    await saveRole({
      name: "viewers",
      enabled: true,
      definition: { rules: [{ path: "/shared", level: "read" }], tests: [] },
      updatedBy: 1,
    });
    await assignRole(2, "viewers");

    const res = await deleteRole("viewers");
    assert(res.ok, JSON.stringify(res));
    assertEquals(res.removedAssignments, 1);
    assertEquals([...await getUserRoles(2)], []);
    assertEquals((await kv.get(Keys.roleUser("viewers", 2))).value, null);
    assertEquals((await listRoleGenerations("viewers")).length, 0);
  });
});

Deno.test("deleteRole: 最後の admin ロールは消せない", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await deleteRole("admins");
    assertEquals(res.ok, false);
    assert(res.rejection);
    assertEquals((await listRoles()).length, 1);
  });
});

Deno.test("assignRole / unassignRole: 判定へ即座に反映される", async () => {
  await withTestKv(async () => {
    await bootstrap();
    await saveRole({
      name: "viewers",
      enabled: true,
      definition: { rules: [{ path: "/shared", level: "read" }], tests: [] },
      updatedBy: 1,
    });

    assertEquals(await getUserRoles(2), []);
    assert((await assignRole(2, "viewers")).ok);
    assertEquals([...await getUserRoles(2)], ["viewers"]);
    assert((await unassignRole(2, "viewers")).ok);
    assertEquals([...await getUserRoles(2)], []);
  });
});

Deno.test("assignRole: 未定義のロールは割り当てられない / 綴りは定義側に正規化", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const ng = await assignRole(2, "ghost");
    assertEquals(ng.ok, false);
    assert(ng.error?.includes("定義されていません"));

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

Deno.test("findAdminRoleNames: 有効で admin / を与えるロールだけを返す", async () => {
  await withTestKv(async () => {
    await bootstrap();
    await putRoleUnchecked("viewers", true, {
      rules: [{ path: "/shared", level: "read" }],
      tests: [],
    }, 1);
    assertEquals(await findAdminRoleNames(), ["admins"]);

    await setRoleEnabled("admins", false, 1).catch(() => {});
    // 最後の admin は無効にできないので、有効なまま
    assertEquals(await findAdminRoleNames(), ["admins"]);
  });
});

Deno.test("importPolicyText: 取り込みも admin 不在検査を通る (ブートストラップ以外)", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await importPolicyText(
      "role viewers {\n  allow read /a\n}\n",
      1,
    );
    assertEquals(res.ok, false);
    assert(res.rejection);
    // 現状は無傷
    assertEquals((await listRoles()).map((r) => r.name), ["admins"]);

    // ブートストラップ経路だけが飛ばせる
    const boot = await importPolicyText(
      "role viewers {\n  allow read /a\n}\n",
      1,
      { skipGuards: true },
    );
    assert(boot.ok);
  });
});

Deno.test("importPolicyText: 併合ではなく置き換え", async () => {
  await withTestKv(async () => {
    await bootstrap();
    await putRoleUnchecked("gone", true, {
      rules: [{ path: "/gone", level: "read" }],
      tests: [],
    }, 1);

    const res = await importPolicyText(
      "role admins {\n  allow admin /\n}\n\ntest admins {\n  admin /\n}\n",
      1,
    );
    assert(res.ok);
    assertEquals(res.roles, 1);
    assertEquals((await listRoles()).map((r) => r.name), ["admins"]);
  });
});

Deno.test("importPolicyText: disabled role を読み書きできる", async () => {
  await withTestKv(async () => {
    await bootstrap();
    const res = await importPolicyText(
      "role admins {\n  allow admin /\n}\n\n" +
        "disabled role viewers {\n  allow read /shared\n}\n",
      1,
    );
    assert(res.ok, JSON.stringify(res));
    const viewers = (await listRoles()).find((r) => r.name === "viewers");
    assertEquals(viewers?.enabled, false);
    assertEquals(
      effectiveLevel(await getActivePolicy(), ["viewers"], "/shared"),
      null,
    );
  });
});

Deno.test("適用中の世代が消えていたら読み込みで throw する", async () => {
  await withTestKv(async (kv) => {
    await bootstrap();
    await kv.delete(Keys.roleGeneration("admins", 1));
    const { _resetPolicyCachesForTesting } = await import(
      "../src/services/policy.service.ts"
    );
    _resetPolicyCachesForTesting();
    await assertRejects(() => getActivePolicy(), PolicyLoadError);
  });
});
