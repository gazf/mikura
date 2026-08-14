"use strict";

/**
 * mikura console の UI。ビルドステップなしの vanilla JS。
 *
 * 方針:
 *   - DOM は textContent / createElement で組む。innerHTML への文字列連結は
 *     使わない (サーバ由来の値をそのまま流し込む箇所が多いため)。
 *   - 管理トークンは扱わない。console 側の session cookie しか持たないので、
 *     この JS が漏れても admin 権限そのものは漏れない (ADR-033)。
 */

const CSRF = { "X-Mikura-Console": "1" };

// ---- API ----

async function call(method, path, body) {
  const init = {
    method,
    headers: { ...CSRF },
    credentials: "same-origin",
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const message = (parsed && parsed.message) || `エラー (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    // 422 (= ポリシー保存の却下) は構造化された理由を本文に持つ。呼び出し側が
    // それを画面に出せるよう、message だけでなく本文ごと運ぶ。
    err.body = parsed;
    throw err;
  }
  return parsed;
}

const api = {
  get: (p) => call("GET", p),
  post: (p, b) => call("POST", p, b),
  put: (p, b) => call("PUT", p, b),
  del: (p) => call("DELETE", p),
};

// ---- DOM helpers ----

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return node;
}

function table(headers, rows) {
  const thead = el(
    "thead",
    null,
    el("tr", null, headers.map((h) => el("th", { text: h }))),
  );
  const tbody = el("tbody", null, rows);
  return el("div", { class: "scroll" }, el("table", null, thead, tbody));
}

let toastTimer = null;
function toast(message, bad) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.className = bad ? "toast bad" : "toast";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3800);
}

/** 失敗時に toast を出し、画面全体は壊さない。 */
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.status === 401) return showLogin();
    toast(e.message, true);
    return null;
  }
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function shorten(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ---- login ----

function showLogin() {
  document.getElementById("app").hidden = true;
  document.getElementById("login").hidden = false;
  document.getElementById("login-token").focus();
}

function showApp(who) {
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  document.getElementById("who-name").textContent = who.userName;
}

document.getElementById("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errorNode = document.getElementById("login-error");
  errorNode.hidden = true;
  const input = document.getElementById("login-token");
  try {
    const who = await api.post("/auth/session", { token: input.value });
    input.value = "";
    showApp(who);
    render();
  } catch (e) {
    errorNode.textContent = e.message;
    errorNode.hidden = false;
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await guard(() => api.del("/auth/session"));
  showLogin();
});

// ---- views ----

let current = "users";
const view = () => document.getElementById("view");

document.querySelectorAll(".sidenav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    current = btn.dataset.view;
    editingRole = null;
    document.querySelectorAll(".sidenav button").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    render();
  });
});

function render() {
  const target = view();
  target.replaceChildren(el("p", { class: "muted", text: "読み込み中…" }));
  const views = {
    users: renderUsers,
    roles: renderRoles,
    diagnostics: renderDiagnostics,
    invitations: renderInvitations,
    devices: renderDevices,
    audit: renderAudit,
  };
  guard(() => views[current](target));
}

function heading(title, sub) {
  return [el("h2", { text: title }), el("p", { class: "sub", text: sub })];
}

// -- users --

async function renderUsers(target) {
  const [users, roleList, assignments] = await Promise.all([
    api.get("/console/api/users"),
    api.get("/console/api/roles"),
    api.get("/console/api/assignments"),
  ]);
  const rolesOf = (id) => assignments.find((a) => a.userId === id)?.roles ?? [];
  // 無効なロールも割り当て自体はできる (権限を与えないだけ)。ただし黙って
  // 効かないと事故になるので、選択肢でも割り当て済みの表示でも状態を出す。
  const roleByName = new Map(roleList.roles.map((r) => [r.name, r]));

  const nameInput = el("input", {
    type: "text",
    placeholder: "新しいユーザー名",
  });
  const createCard = el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "row" },
      nameInput,
      el("button", {
        class: "primary",
        text: "ユーザーを追加",
        onclick: () =>
          guard(async () => {
            const name = nameInput.value.trim();
            if (!name) return toast("ユーザー名を入力してください", true);
            await api.post("/console/api/users", { name });
            toast(`${name} を作成しました`);
            render();
          }),
      }),
    ),
  );

  const rows = users.map((u) => {
    const mine = rolesOf(u.id);
    const select = el(
      "select",
      null,
      el("option", { value: "", text: "ロールを選択…" }),
      roleList.roles
        .filter((r) => !mine.includes(r.name))
        .map((r) =>
          el("option", {
            value: r.name,
            text: r.enabled ? r.name : `${r.name} (無効)`,
          })
        ),
    );
    return el(
      "tr",
      null,
      el(
        "td",
        null,
        el("strong", { text: u.name }),
        " ",
        el("span", { class: "muted", text: `#${u.id}` }),
      ),
      el(
        "td",
        null,
        mine.length === 0
          ? el("span", { class: "muted", text: "割り当てなし" })
          : mine.map((role) =>
            el(
              "span",
              { class: "row", style: "display:inline-flex;margin-right:8px" },
              el("span", {
                class: roleByName.get(role)?.enabled ? "pill" : "pill deny",
                text: !roleByName.has(role)
                  ? `${role} (未定義)`
                  : roleByName.get(role).enabled
                  ? role
                  : `${role} (無効)`,
              }),
              el("button", {
                text: "×",
                title: "この割り当てを外す",
                onclick: () =>
                  guard(async () => {
                    await api.del(
                      `/console/api/assignments/${u.id}/${
                        encodeURIComponent(role)
                      }`,
                    );
                    toast("割り当てを解除しました");
                    render();
                  }),
              }),
            )
          ),
      ),
      el(
        "td",
        null,
        el(
          "div",
          { class: "row" },
          select,
          el("button", {
            text: "追加",
            onclick: () =>
              guard(async () => {
                if (!select.value) return;
                await api.post("/console/api/assignments", {
                  userId: u.id,
                  role: select.value,
                });
                toast("ロールを割り当てました");
                render();
              }),
          }),
        ),
      ),
      el("td", { class: "muted", text: fmtTime(u.createdAt) }),
      el(
        "td",
        { class: "actions" },
        el("button", {
          class: "danger",
          text: "削除",
          onclick: () =>
            guard(async () => {
              if (
                !confirm(
                  `${u.name} を削除します。トークン・端末・招待も一緒に消えます。`,
                )
              ) return;
              await api.del(`/console/api/users/${u.id}`);
              toast(`${u.name} を削除しました`);
              render();
            }),
        }),
      ),
    );
  });

  target.replaceChildren(
    ...heading("ユーザー", "アカウントの作成と、ロールの割り当て。"),
    createCard,
    el(
      "div",
      { class: "card" },
      table([
        "ユーザー",
        "割り当て済みロール",
        "ロールを割り当て",
        "作成日時",
        "",
      ], rows),
    ),
  );
}

// -- roles (ADR-036) --

/**
 * 画面は 2 枚。
 *   一覧: 上に「ロールを追加」、下に 1 行 = 1 ロールのテーブル (編集 / 有効無効)
 *   編集: 選んだロールのルール・テスト・世代
 *
 * 保存は「そのロールだけ」を PUT する。検証はサーバ側で必ず全ロールに対して
 * 走る (ロールをまたぐ警告も admin 不在検査もアサーションも、全体を見ないと
 * 判定できない)。
 */

const LEVELS = ["read", "write", "admin"];
const EXPECTATIONS = ["invisible", "visible", "readable", "writable", "admin"];

/** null なら一覧、文字列ならそのロールの編集画面、"" なら新規作成。 */
let editingRole = null;

function issueList(title, items, cls) {
  if (!items || items.length === 0) return null;
  return el(
    "div",
    { class: `issues ${cls}` },
    el("h4", { text: title }),
    el(
      "ul",
      null,
      items.map((i) =>
        el("li", {
          text: i.line ? `${i.line} 行目: ${i.message}` : i.message,
        })
      ),
    ),
  );
}

/**
 * 却下理由を 1 行にまとめる (toast 用)。
 *
 * 却下の理由は 5 つの入れ物に分かれて返る。どれが埋まるかは却下の種類で
 * 変わるので、拾い漏れると「失敗しました」しか出ない画面になる。
 * 一覧のトグルのように詳細を描く場所が無いところでは、ここで先頭 1 件を出す。
 */
function rejectReason(result, fallback) {
  if (result.rejection) return result.rejection;
  if (result.errors?.length) return result.errors[0].message;
  if (result.testFailures?.length) return result.testFailures[0].message;
  if (result.assertionFailures?.length) {
    return result.assertionFailures[0].message;
  }
  if (result.message) return result.message;
  return fallback;
}

/**
 * 保存結果の却下理由をまとめて描く。
 *
 * 却下は 2 系統ある: 構造化された 422 (検証・テスト・アサーション・admin 不在) と、
 * 素の `{message}` を返す 400 (入力の形が違う)。後者を落とすと画面が空のまま
 * 「保存できませんでした」だけになり、原因が一切分からない。
 */
function saveReport(result) {
  if (result.ok === undefined) {
    return [
      issueList("エラー", [{
        line: 0,
        message: result.message ?? "原因不明のエラーです",
      }], "bad"),
    ].filter(Boolean);
  }
  return [
    issueList("入力エラー", result.errors, "bad"),
    issueList("テスト失敗", result.testFailures, "bad"),
    issueList(
      "アサーション違反 (割り当て層が拒否)",
      result.assertionFailures,
      "bad",
    ),
    result.rejection
      ? issueList("却下", [{ line: 0, message: result.rejection }], "bad")
      : null,
    issueList("警告", result.warnings, "warn"),
  ].filter(Boolean);
}

async function renderRoles(target) {
  if (editingRole !== null) return renderRoleEditor(target, editingRole);

  const list = await api.get("/console/api/roles");

  const rows = list.roles.map((r) =>
    el(
      "tr",
      { class: r.enabled ? "" : "row-off" },
      el(
        "td",
        null,
        el("strong", { text: r.name }),
        r.danglingPaths.length > 0
          ? el("span", {
            class: "pill deny",
            title: `実在しないパス: ${r.danglingPaths.join(", ")}`,
            text: "⚠ 宙に浮いたルール",
          })
          : null,
      ),
      el("td", {
        text: r.enabled ? "有効" : "無効",
        class: r.enabled ? "" : "muted",
      }),
      el("td", { class: "muted", text: `${r.rules.length} 件` }),
      el("td", {
        class: r.memberCount === 0 ? "muted" : "",
        text: r.memberCount === 0 ? "未割当" : `${r.memberCount} 人`,
      }),
      el("td", { class: "muted", text: `第 ${r.generation} 世代` }),
      el(
        "td",
        { class: "actions" },
        el("button", {
          text: "編集",
          onclick: () => {
            editingRole = r.name;
            render();
          },
        }),
        el("button", {
          text: r.enabled ? "無効にする" : "有効にする",
          onclick: () =>
            guard(async () => {
              const result = await api.post(
                `/console/api/roles/${encodeURIComponent(r.name)}/enabled`,
                { enabled: !r.enabled },
              ).catch((e) => e.body ?? Promise.reject(e));
              if (!result.ok) {
                toast(rejectReason(result, "切り替えられませんでした"), true);
                return;
              }
              toast(`${r.name} を${r.enabled ? "無効" : "有効"}にしました`);
              render();
            }),
        }),
      ),
    )
  );

  target.replaceChildren(
    ...heading(
      "ロール",
      "ロールは「何を与えるか」で名付けます (projects-editor は良い名前、sales-department は悪い名前)。1 人だけの例外も専用ロールを 1 人に割り当てる形で表します。",
    ),
    el(
      "div",
      { class: "row toolbar" },
      el("button", {
        class: "primary",
        text: "＋ ロールを追加",
        onclick: () => {
          editingRole = "";
          render();
        },
      }),
    ),
    el(
      "div",
      { class: "card" },
      list.roles.length === 0
        ? el("p", { class: "muted", text: "まだロールがありません" })
        : table(
          ["ロール", "状態", "ルール", "割り当て", "世代", ""],
          rows,
        ),
    ),
    list.warnings.length === 0 ? null : el(
      "div",
      { class: "card" },
      issueList("警告", list.warnings, "warn"),
    ),
  );
}

async function renderRoleEditor(target, name) {
  const isNew = name === "";
  const detail = isNew ? null : await api.get(
    `/console/api/roles/${encodeURIComponent(name)}`,
  );

  const draft = {
    name: isNew ? "" : detail.name,
    enabled: isNew ? true : detail.enabled,
    rules: isNew ? [] : detail.rules.map((r) => ({ ...r })),
    tests: isNew ? [] : detail.tests.map((t) => ({ ...t })),
  };

  const report = el("div", { class: "report" });
  const rulesBody = el("tbody");
  const testsBody = el("tbody");

  function drawRules() {
    rulesBody.replaceChildren(
      ...draft.rules.map((rule, i) => {
        const kind = el(
          "select",
          {
            onchange: () => {
              rule.level = kind.value === "deny" ? null : "read";
              drawRules();
            },
          },
          el("option", { value: "allow", text: "許可" }),
          el("option", { value: "deny", text: "遮断" }),
        );
        kind.value = rule.level === null ? "deny" : "allow";

        const level = el(
          "select",
          { onchange: () => (rule.level = level.value) },
          LEVELS.map((l) => el("option", { value: l, text: l })),
        );
        if (rule.level !== null) level.value = rule.level;
        level.disabled = rule.level === null;

        const path = el("input", {
          type: "text",
          value: rule.path,
          placeholder: "/projects",
          oninput: () => (rule.path = path.value),
        });

        return el(
          "tr",
          null,
          el("td", null, kind),
          el("td", null, level),
          el("td", { class: "grow" }, path),
          el(
            "td",
            { class: "actions" },
            el("button", {
              text: "×",
              title: "このルールを削除",
              onclick: () => {
                draft.rules.splice(i, 1);
                drawRules();
              },
            }),
          ),
        );
      }),
    );
  }

  function drawTests() {
    testsBody.replaceChildren(
      ...draft.tests.map((t, i) => {
        const expect = el(
          "select",
          { onchange: () => (t.expect = expect.value) },
          EXPECTATIONS.map((x) => el("option", { value: x, text: x })),
        );
        expect.value = t.expect;
        const path = el("input", {
          type: "text",
          value: t.path,
          placeholder: "/projects/spec.md",
          oninput: () => (t.path = path.value),
        });
        return el(
          "tr",
          null,
          el("td", null, expect),
          el("td", { class: "grow" }, path),
          el(
            "td",
            { class: "actions" },
            el("button", {
              text: "×",
              onclick: () => {
                draft.tests.splice(i, 1);
                drawTests();
              },
            }),
          ),
        );
      }),
    );
  }

  drawRules();
  drawTests();

  const nameInput = el("input", {
    type: "text",
    value: draft.name,
    placeholder: "projects-editor",
    oninput: () => (draft.name = nameInput.value.trim()),
  });
  if (!isNew) {
    // 改名は割り当て (user_roles) を宙に浮かせるので、ここでは許さない。
    nameInput.disabled = true;
    nameInput.title = "ロール名は変更できません (割り当てが外れるため)";
  }

  function payload(extra) {
    return {
      rules: draft.rules.map((r) => ({ path: r.path.trim(), level: r.level })),
      tests: draft.tests.map((t) => ({
        path: t.path.trim(),
        expect: t.expect,
      })),
      enabled: draft.enabled,
      ...extra,
    };
  }

  function validateLocally() {
    if (!draft.name) {
      toast("ロール名を入力してください", true);
      return false;
    }
    if (draft.rules.some((r) => !r.path.trim())) {
      toast("パスが空のルールがあります", true);
      return false;
    }
    if (draft.tests.some((t) => !t.path.trim())) {
      toast("パスが空のテストがあります", true);
      return false;
    }
    return true;
  }

  async function submit(extra, okMessage) {
    const result = await api.put(
      `/console/api/roles/${encodeURIComponent(draft.name)}`,
      payload(extra),
    ).catch((e) => e.body ?? Promise.reject(e));
    if (result.ok && !extra.dryRun) {
      toast(okMessage);
      editingRole = null;
      render();
      return;
    }
    report.replaceChildren(
      ...(result.ok
        ? [el("p", { class: "ok", text: "この内容なら保存できます" })]
        : []),
      ...saveReport(result),
    );
    if (!result.ok) {
      toast(rejectReason(result, "保存できませんでした"), true);
      report.scrollIntoView({ block: "nearest" });
    }
  }

  const generations = isNew ? null : el(
    "div",
    { class: "card" },
    el("h3", { text: "世代" }),
    el("p", {
      class: "hint",
      text:
        "保存するたびに 1 世代積まれます (直近 10 世代を保持)。切り替えても世代は増えません。",
    }),
    table(
      ["世代", "保存日時", "内容", ""],
      detail.generations.map((g) =>
        el(
          "tr",
          null,
          el("td", {
            text: `第 ${g.generation} 世代${g.current ? " (適用中)" : ""}`,
          }),
          el("td", { class: "muted", text: fmtTime(g.createdAt) }),
          el("td", {
            class: "muted",
            text: `ルール ${g.ruleCount} / テスト ${g.testCount}`,
          }),
          el(
            "td",
            { class: "actions" },
            g.current ? null : el("button", {
              text: "この世代に切り替える",
              onclick: () =>
                guard(async () => {
                  const result = await api.post(
                    `/console/api/roles/${
                      encodeURIComponent(draft.name)
                    }/generation`,
                    { generation: g.generation },
                  ).catch((e) => e.body ?? Promise.reject(e));
                  if (!result.ok) {
                    report.replaceChildren(...saveReport(result));
                    toast(
                      rejectReason(result, "切り替えられませんでした"),
                      true,
                    );
                    return;
                  }
                  toast(`第 ${g.generation} 世代に切り替えました`);
                  render();
                }),
            }),
          ),
        )
      ),
    ),
  );

  target.replaceChildren(
    ...heading(
      isNew ? "ロールを追加" : `ロール: ${detail.name}`,
      isNew
        ? "何を与えるかで名付けてください。"
        : `${
          detail.enabled ? "有効" : "無効"
        } / 第 ${detail.generation} 世代 / ${
          detail.memberCount === 0
            ? "未割当"
            : `${detail.memberCount} 人に割り当て済み`
        }`,
    ),
    el(
      "div",
      { class: "row toolbar" },
      el("button", {
        text: "← 一覧に戻る",
        onclick: () => {
          editingRole = null;
          render();
        },
      }),
    ),
    report,
    el(
      "div",
      { class: "card" },
      el("div", { class: "row" }, el("label", { text: "ロール名" }), nameInput),
      el("h4", { text: "ルール" }),
      el("div", { class: "scroll" }, el("table", { class: "form" }, rulesBody)),
      el(
        "div",
        { class: "row" },
        el("button", {
          text: "＋ ルールを追加",
          onclick: () => {
            draft.rules.push({ level: "read", path: "" });
            drawRules();
          },
        }),
      ),
      el("h4", { text: "確かめたいこと (テスト)" }),
      el("p", {
        class: "hint",
        text:
          "このロール単体での期待値です。1 つでも外れると保存できません。遮断を書いたロールには必ず 1 つ以上置いてください。",
      }),
      el("div", { class: "scroll" }, el("table", { class: "form" }, testsBody)),
      el(
        "div",
        { class: "row" },
        el("button", {
          text: "＋ テストを追加",
          onclick: () => {
            draft.tests.push({ expect: "readable", path: "" });
            drawTests();
          },
        }),
      ),
      el(
        "div",
        { class: "row role-actions" },
        el("button", {
          class: "primary",
          text: isNew ? "作成" : "保存",
          onclick: () =>
            guard(async () => {
              if (!validateLocally()) return;
              await submit(
                {},
                isNew
                  ? `${draft.name} を作成しました`
                  : `${draft.name} を保存しました`,
              );
            }),
        }),
        el("button", {
          text: "検証だけする",
          onclick: () =>
            guard(async () => {
              if (!validateLocally()) return;
              await submit({ dryRun: true }, "");
            }),
        }),
        isNew ? null : el("button", {
          class: "danger",
          text: "このロールを削除",
          onclick: () =>
            guard(async () => {
              const warn = detail.memberCount > 0
                ? `${detail.name} は ${detail.memberCount} 人に割り当てられています。削除すると割り当ても一緒に外れます。`
                : `${detail.name} を削除します。`;
              if (!confirm(warn)) return;
              const result = await api.del(
                `/console/api/roles/${encodeURIComponent(detail.name)}`,
              ).catch((e) => e.body ?? Promise.reject(e));
              if (!result.ok) {
                report.replaceChildren(...saveReport(result));
                toast(rejectReason(result, "削除できませんでした"), true);
                return;
              }
              toast(`${detail.name} を削除しました`);
              editingRole = null;
              render();
            }),
        }),
      ),
    ),
    generations,
  );
}

// -- diagnostics --

/**
 * 監査で実際に問われるのは逆方向 (「/hr を読めるのは誰か」) で、AD の無い
 * Samba では答えられない問い。deny が減算ではなく継承の切断だからこそ、
 * 対象パスとその祖先だけを見れば有限で答えられる。
 */
async function renderDiagnostics(target) {
  const [users, assertions] = await Promise.all([
    api.get("/console/api/users"),
    api.get("/console/api/assertions"),
  ]);
  const nameOf = (id) => users.find((u) => u.id === id)?.name ?? `#${id}`;

  // -- 前方診断 --
  const fwdUser = el(
    "select",
    null,
    users.map((u) => el("option", { value: String(u.id), text: u.name })),
  );
  const fwdPath = el("input", { type: "text", placeholder: "/projects/a.txt" });
  const fwdOut = el("div", { class: "report" });

  const forward = el(
    "div",
    { class: "card" },
    el("h3", { text: "このユーザーは何ができるか" }),
    el(
      "div",
      { class: "row" },
      fwdUser,
      fwdPath,
      el("button", {
        class: "primary",
        text: "判定",
        onclick: () =>
          guard(async () => {
            if (!fwdPath.value.trim()) {
              return toast("パスを入力してください", true);
            }
            const q = `userId=${fwdUser.value}&path=${
              encodeURIComponent(fwdPath.value.trim())
            }`;
            const r = await api.get(
              `/console/api/diagnostics/effective?${q}`,
            );
            fwdOut.replaceChildren(
              el("p", {
                class: "ok",
                text: `実効水準: ${r.effective}`,
              }),
              r.perRole.length === 0
                ? el("p", {
                  class: "muted",
                  text: "ロールが割り当てられていません",
                })
                : table(
                  ["ロール", "決め手になったルール", "そのロールの水準"],
                  r.perRole.map((p) =>
                    el(
                      "tr",
                      null,
                      el("td", { text: p.role }),
                      el("td", {
                        text: p.decidedBy ??
                          (p.derivedVisible
                            ? "(配下の grant により名前だけ)"
                            : "ルール無し"),
                      }),
                      el("td", {
                        text: p.level ??
                          (p.derivedVisible ? "visible" : "invisible"),
                      }),
                    )
                  ),
                ),
            );
          }),
      }),
    ),
    fwdOut,
  );

  // -- 逆方向診断 --
  const revPath = el("input", { type: "text", placeholder: "/hr" });
  const revLevel = el(
    "select",
    null,
    ["visible", "read", "write", "admin"].map((l) =>
      el("option", { value: l, text: l })
    ),
  );
  revLevel.value = "read";
  const revOut = el("div", { class: "report" });

  const reverse = el(
    "div",
    { class: "card" },
    el("h3", { text: "このパスに届くのは誰か" }),
    el(
      "div",
      { class: "row" },
      revPath,
      revLevel,
      el("button", {
        class: "primary",
        text: "調べる",
        onclick: () =>
          guard(async () => {
            if (!revPath.value.trim()) {
              return toast("パスを入力してください", true);
            }
            const q = `path=${
              encodeURIComponent(revPath.value.trim())
            }&level=${revLevel.value}`;
            const r = await api.get(`/console/api/diagnostics/who?${q}`);
            revOut.replaceChildren(
              r.users.length === 0
                ? el("p", { class: "muted", text: "該当なし" })
                : table(
                  ["ユーザー", "実効水準", "根拠のロール"],
                  r.users.map((u) =>
                    el(
                      "tr",
                      null,
                      el("td", { text: u.name ?? `#${u.userId}` }),
                      el("td", { text: u.effective }),
                      el(
                        "td",
                        null,
                        u.roles.map((role) =>
                          el("span", { class: "pill", text: role })
                        ),
                      ),
                    )
                  ),
                ),
            );
          }),
      }),
    ),
    revOut,
  );

  // -- アサーション --
  const asUser = el(
    "select",
    null,
    users.map((u) => el("option", { value: String(u.id), text: u.name })),
  );
  const asPath = el("input", { type: "text", placeholder: "/hr/payroll.xlsx" });
  const asExpect = el(
    "select",
    null,
    ["invisible", "visible", "readable", "writable", "admin"].map((x) =>
      el("option", { value: x, text: x })
    ),
  );
  const asNote = el("input", { type: "text", placeholder: "メモ (任意)" });

  const assertionRows = assertions.map((a) =>
    el(
      "tr",
      null,
      el("td", { text: nameOf(a.userId) }),
      el("td", { text: a.path }),
      el("td", null, el("span", { class: "pill", text: a.expect })),
      el("td", { class: "muted", text: a.note ?? "" }),
      el(
        "td",
        { class: "actions" },
        el("button", {
          class: "danger",
          text: "削除",
          onclick: () =>
            guard(async () => {
              await api.del(`/console/api/assertions/${a.id}`);
              toast("アサーションを削除しました");
              render();
            }),
        }),
      ),
    )
  );

  const assertionCard = el(
    "div",
    { class: "card" },
    el("h3", { text: "アサーション" }),
    el("p", {
      class: "hint",
      text:
        "「このユーザーのこのパスは少なくともこの水準」を固定します。ポリシーの新版が" +
        "これを壊す場合、その保存は拒否されます。ロール定義はユーザーを知らないままで、" +
        "利用側だけが破壊的変更を止められます。",
    }),
    el(
      "div",
      { class: "row" },
      asUser,
      asPath,
      asExpect,
      asNote,
      el("button", {
        class: "primary",
        text: "追加",
        onclick: () =>
          guard(async () => {
            if (!asPath.value.trim()) {
              return toast("パスを入力してください", true);
            }
            await api.post("/console/api/assertions", {
              userId: Number(asUser.value),
              path: asPath.value.trim(),
              expect: asExpect.value,
              note: asNote.value.trim() || undefined,
            });
            toast("アサーションを追加しました");
            render();
          }),
      }),
    ),
    assertions.length === 0
      ? el("p", { class: "muted", text: "まだありません" })
      : table(["ユーザー", "パス", "期待", "メモ", ""], assertionRows),
  );

  target.replaceChildren(
    ...heading("診断", "誰が何にアクセスできるかを、両方向から確かめる。"),
    forward,
    reverse,
    assertionCard,
  );
}

// -- invitations --

async function renderInvitations(target) {
  const [users, enrollments] = await Promise.all([
    api.get("/console/api/users"),
    api.get("/console/api/enrollments"),
  ]);

  const userSelect = el(
    "select",
    null,
    users.map((u) => el("option", { value: String(u.id), text: u.name })),
  );
  const ttlInput = el("input", {
    type: "number",
    value: "7",
    min: "1",
    max: "90",
    style: "width:80px",
  });
  const result = el("div");

  const issue = () =>
    guard(async () => {
      const issued = await api.post("/console/api/enrollments", {
        userId: Number(userSelect.value),
        ttlDays: Number(ttlInput.value),
      });
      result.replaceChildren(renderIssued(issued));
      toast("招待を発行しました");
    });

  const userName = (id) => users.find((u) => u.id === id)?.name ?? `#${id}`;

  const rows = enrollments
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((e) => {
      const consumed = Boolean(e.consumedAt);
      const expired = !consumed && Date.parse(e.expiresAt) < Date.now();
      return el(
        "tr",
        null,
        el("td", { text: userName(e.userId) }),
        el(
          "td",
          null,
          consumed
            ? el("span", { class: "pill ok", text: "使用済み" })
            : expired
            ? el("span", { class: "pill warn", text: "期限切れ" })
            : el("span", { class: "pill", text: "未使用" }),
        ),
        el("td", { class: "muted", text: fmtTime(e.createdAt) }),
        el("td", { class: "muted", text: fmtTime(e.expiresAt) }),
        el("td", null, el("code", { text: shorten(e.secretHash, 12) })),
      );
    });

  target.replaceChildren(
    ...heading(
      "招待",
      "ユーザーに配る招待リンクを発行します。1 回だけ使え、使った端末に固定されます。",
    ),
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row" },
        el("span", { class: "muted", text: "対象" }),
        userSelect,
        el("span", { class: "muted", text: "有効期間 (日)" }),
        ttlInput,
        el("button", { class: "primary", text: "招待を発行", onclick: issue }),
      ),
      result,
    ),
    el(
      "div",
      { class: "card" },
      table(["ユーザー", "状態", "発行", "期限", "ハッシュ"], rows),
    ),
  );
}

function renderIssued(issued) {
  // 配れるリンクと、手直しが要る雛形。サーバは両方を同時には返さない。
  const isTemplate = !issued.enrollUrl;
  const url = issued.enrollUrl ?? issued.enrollUrlTemplate;

  if (!url) {
    // 雛形すら組めないのは想定外 (サーバが古い等)。シークレットだけ出す。
    return el(
      "div",
      { class: "invite" },
      el("strong", {
        text: "招待を発行しましたが、リンクを組み立てられませんでした",
      }),
      el(
        "div",
        null,
        el("span", { class: "muted", text: "シークレット: " }),
        el("code", { text: issued.secret }),
      ),
      el("p", {
        class: "hint",
        text: `有効期限: ${fmtTime(issued.expiresAt)}`,
      }),
    );
  }

  const link = el("code", { class: isTemplate ? "template" : "", text: url });
  return el(
    "div",
    { class: "invite" },
    el("strong", {
      text: isTemplate
        ? "招待リンクの雛形 (この画面を離れると二度と表示できません)"
        : "招待リンク (この画面を離れると二度と表示できません)",
    }),
    isTemplate
      ? el("p", {
        class: "hint",
        text:
          "サーバ側に MIKURA_PUBLIC_URL が設定されていないため、ホスト名を組み立てられませんでした。" +
          "上の HOST を、クライアントから到達できるホスト名か IP に置き換えてから渡してください " +
          "(置き換え忘れたリンクはクライアント側で弾かれます)。",
      })
      : null,
    link,
    el(
      "div",
      { class: "row" },
      el("button", {
        class: "primary",
        text: "コピー",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast("コピーしました");
          } catch {
            toast("コピーできませんでした。手動で選択してください", true);
          }
        },
      }),
      el("span", {
        class: "hint",
        text: `有効期限: ${fmtTime(issued.expiresAt)}`,
      }),
    ),
    el("p", {
      class: "hint",
      text:
        "このリンクをそのままユーザーに送ってください。クライアントの「プロファイルを追加」に貼り付けると設定が完了します。",
    }),
  );
}

// -- devices & tokens --

async function renderDevices(target) {
  const [devices, tokens, users] = await Promise.all([
    api.get("/console/api/devices"),
    api.get("/console/api/tokens"),
    api.get("/console/api/users"),
  ]);
  const userName = (id) => users.find((u) => u.id === id)?.name ?? `#${id}`;

  const deviceRows = devices
    .slice()
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .map((d) =>
      el(
        "tr",
        null,
        el("td", null, el("code", { text: shorten(d.deviceId, 20) })),
        el("td", { text: userName(d.userId) }),
        el("td", { class: "muted", text: fmtTime(d.lastSeenAt) }),
        el("td", { class: "muted", text: d.ipAddress ?? "—" }),
      )
    );

  const tokenRows = tokens
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) =>
      el(
        "tr",
        null,
        el("td", { text: t.name }),
        el("td", { text: userName(t.userId) }),
        el(
          "td",
          null,
          t.boundDeviceId
            ? el("span", { class: "pill ok", text: "端末に固定" })
            : el("span", { class: "pill warn", text: "固定なし" }),
        ),
        el("td", { class: "muted", text: fmtTime(t.lastUsedAt) }),
        el("td", { class: "muted", text: fmtTime(t.expiresAt) }),
        el(
          "td",
          { class: "actions" },
          el("button", {
            class: "danger",
            text: "失効",
            onclick: () =>
              guard(async () => {
                if (
                  !confirm(
                    `${t.name} を失効させます。この端末はすぐに接続できなくなります。`,
                  )
                ) return;
                await api.del(`/console/api/tokens/${t.tokenHash}`);
                toast("トークンを失効させました");
                render();
              }),
          }),
        ),
      )
    );

  target.replaceChildren(
    ...heading(
      "端末とトークン",
      "接続してきた端末の記録と、発行済みトークンの失効。",
    ),
    el(
      "div",
      { class: "card" },
      el("h2", { text: "端末" }),
      table(["端末 ID", "ユーザー", "最終接続", "IP"], deviceRows),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", { text: "トークン" }),
      table(
        ["名前", "ユーザー", "端末固定", "最終使用", "期限", ""],
        tokenRows,
      ),
    ),
  );
}

// -- audit --

async function renderAudit(target) {
  const [entries, users] = await Promise.all([
    api.get("/console/api/audit?limit=200"),
    api.get("/console/api/users"),
  ]);
  const userName = (id) => users.find((u) => u.id === id)?.name ?? `#${id}`;

  const rows = entries.map((e) =>
    el(
      "tr",
      null,
      el("td", { class: "muted", text: fmtTime(e.timestamp) }),
      el("td", { text: userName(e.userId) }),
      el("td", null, el("code", { text: e.action })),
      el("td", { class: "muted", text: e.ip }),
    )
  );

  target.replaceChildren(
    ...heading("監査ログ", "更新系リクエストの記録。新しい順に最大 200 件。"),
    el(
      "div",
      { class: "card" },
      table(["日時", "ユーザー", "操作", "IP"], rows),
    ),
  );
}

// ---- boot ----

(async function boot() {
  try {
    const who = await api.get("/auth/session");
    showApp(who);
    render();
  } catch {
    showLogin();
  }
})();
