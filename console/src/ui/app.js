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
  const [users, policy, assignments] = await Promise.all([
    api.get("/console/api/users"),
    api.get("/console/api/policy"),
    api.get("/console/api/assignments"),
  ]);
  const rolesOf = (id) => assignments.find((a) => a.userId === id)?.roles ?? [];
  const allRoles = policy.roles.map((r) => r.name);

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
      allRoles
        .filter((r) => !mine.includes(r))
        .map((r) => el("option", { value: r, text: r })),
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
                class: allRoles.includes(role) ? "pill" : "pill deny",
                text: allRoles.includes(role) ? role : `${role} (未定義)`,
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

// -- roles (policy document) --

/**
 * 編集の単位はロール。左の一覧で選び、右でそのロールのルールとテストを編集する。
 * ただし保存は必ず **文書まるごとの PUT** に戻る。
 *
 * ADR-035 が禁じているのは「ルール行ごとの API」であって、フォームの結果を
 * 原文に差し戻して丸ごと保存するのは何も壊さない。検証・ロール単体テスト・
 * アサーションの拒否権・版管理・監査は全部そのまま効く。
 *
 * 差し替えは **そのロールの行範囲だけ**を置き換える (全体を再生成しない)。
 * 手書きのコメントとロールの並び順が保たれるため。
 */

const LEVELS = ["read", "write", "admin"];
const EXPECTATIONS = ["invisible", "visible", "readable", "writable", "admin"];

/** 選択中のロール名。再描画をまたいで保つ。 */
let selectedRole = null;
/** 新規作成中か。true の間は右ペインが空のロールになる。 */
let creatingRole = false;

/** ロール 1 つ分のテキストを組み立てる。列幅を揃えて読めるようにする。 */
function renderRoleBlock(role) {
  const lines = [`role ${role.name} {`];
  for (const rule of role.rules) {
    if (rule.level === null) {
      lines.push(`  deny           ${rule.path}`);
    } else {
      lines.push(`  allow  ${rule.level.padEnd(6)} ${rule.path}`);
    }
  }
  lines.push("}");

  if (role.cases.length > 0) {
    lines.push("");
    lines.push(`test ${role.name} {`);
    const w = Math.max(...role.cases.map((c) => c.expect.length));
    for (const c of role.cases) {
      lines.push(`  ${c.expect.padEnd(w)}  ${c.path}`);
    }
    lines.push("}");
  }
  return lines.join("\n");
}

/**
 * 原文から [from, to] 行 (1 始まり・両端含む) を取り除き、replacement を挿す。
 * ranges は複数渡せる (role ブロックと test ブロックは離れていることがある)。
 */
function spliceBlocks(text, ranges, replacement) {
  const lines = text.split("\n");
  const sorted = [...ranges].sort((a, b) => b.from - a.from);
  let insertAt = null;
  for (const r of sorted) {
    lines.splice(r.from - 1, r.to - r.from + 1);
    insertAt = r.from - 1;
  }
  if (replacement !== null) {
    lines.splice(insertAt, 0, ...replacement.split("\n"));
  }
  // 削除で生まれた 3 行以上の空行を 1 つに畳む。
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** サーバから来たロールを、編集用の平坦な形に落とす。 */
function toEditable(role) {
  return {
    name: role.name,
    rules: role.rules.map((r) => ({ ...r })),
    cases: role.tests.flatMap((t) => t.cases.map((c) => ({ ...c }))),
    ranges: [
      { from: role.line, to: role.endLine },
      ...role.tests.map((t) => ({ from: t.line, to: t.endLine })),
    ],
  };
}

/** ルールを一覧で 1 行に畳んだ表示 (左ペイン用)。 */
function summarize(role) {
  if (role.rules.length === 0) return "ルールなし";
  return role.rules
    .map((r) => (r.level === null ? `遮断 ${r.path}` : `${r.level} ${r.path}`))
    .join(" / ");
}

async function renderRoles(target) {
  const [policy, versions] = await Promise.all([
    api.get("/console/api/policy"),
    api.get("/console/api/policy/versions"),
  ]);

  // 選択の解決: 消えたロールを掴んだままにしない。
  if (!creatingRole && !policy.roles.some((r) => r.name === selectedRole)) {
    selectedRole = policy.roles[0]?.name ?? null;
  }

  const report = el("div", { class: "report" });

  function showResult(result, okMessage) {
    const blocks = [];
    const group = (title, items, cls) => {
      if (!items || items.length === 0) return;
      blocks.push(
        el(
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
        ),
      );
    };
    group("構文エラー", result.errors, "bad");
    group("テスト失敗", result.testFailures, "bad");
    group(
      "アサーション違反 (割り当て層が拒否)",
      result.assertionFailures,
      "bad",
    );
    if (result.rejection) {
      group("却下", [{ line: 0, message: result.rejection }], "bad");
    }
    group("警告", result.warnings, "warn");
    if (result.ok && okMessage) {
      blocks.unshift(el("p", { class: "ok", text: okMessage }));
    }
    report.replaceChildren(...blocks);
  }

  /** 文書を丸ごと保存する。却下されたら理由を出して画面は保つ。 */
  async function saveDocument(text, okMessage) {
    const result = await api.put("/console/api/policy", {
      text,
      expectedVersion: policy.version,
    }).catch((e) => e.body ?? Promise.reject(e));
    if (result.ok) {
      toast(okMessage);
      render();
      return true;
    }
    showResult(result);
    toast("保存できませんでした", true);
    return false;
  }

  // ---- 左ペイン: ロール一覧 ----

  const list = el(
    "div",
    { class: "card rolelist" },
    el(
      "div",
      { class: "rolelist-items" },
      policy.roles.length === 0
        ? el("p", { class: "muted", text: "まだロールがありません" })
        : policy.roles.map((r) =>
          el(
            "button",
            {
              type: "button",
              class: !creatingRole && r.name === selectedRole
                ? "roleitem active"
                : "roleitem",
              onclick: () => {
                selectedRole = r.name;
                creatingRole = false;
                render();
              },
            },
            el("span", { class: "roleitem-name", text: r.name }),
            el("span", {
              class: r.memberCount === 0
                ? "roleitem-count muted"
                : "roleitem-count",
              text: r.memberCount === 0 ? "未割当" : `${r.memberCount} 人`,
            }),
            el("span", { class: "roleitem-rules", text: summarize(r) }),
          )
        ),
    ),
    el("button", {
      class: "primary block",
      text: "＋ ロールを追加",
      onclick: () => {
        creatingRole = true;
        render();
      },
    }),
  );

  // ---- 右ペイン: 選択したロールの詳細 ----

  function roleDetail(role, isNew) {
    const draft = isNew
      ? { name: "", rules: [], cases: [], ranges: [] }
      : toEditable(role);

    const rulesBody = el("tbody");
    const casesBody = el("tbody");

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

    function drawCases() {
      casesBody.replaceChildren(
        ...draft.cases.map((c, i) => {
          const expect = el(
            "select",
            { onchange: () => (c.expect = expect.value) },
            EXPECTATIONS.map((x) => el("option", { value: x, text: x })),
          );
          expect.value = c.expect;
          const path = el("input", {
            type: "text",
            value: c.path,
            placeholder: "/projects/spec.md",
            oninput: () => (c.path = path.value),
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
                  draft.cases.splice(i, 1);
                  drawCases();
                },
              }),
            ),
          );
        }),
      );
    }

    drawRules();
    drawCases();

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

    /** フォームの内容を原文に差し戻した結果を返す。不正なら null。 */
    function apply() {
      if (!draft.name) {
        toast("ロール名を入力してください", true);
        return null;
      }
      if (draft.rules.some((r) => !r.path.trim())) {
        toast("パスが空のルールがあります", true);
        return null;
      }
      const block = renderRoleBlock(draft);
      if (isNew) {
        return `${policy.text.replace(/\s*$/, "")}\n\n${block}\n`;
      }
      return spliceBlocks(policy.text, draft.ranges, block);
    }

    return el(
      "div",
      { class: "card roledetail" },
      el(
        "div",
        { class: "row role-head" },
        el("label", { text: "ロール名" }),
        nameInput,
        isNew ? null : el("span", {
          class: "muted",
          text: role.memberCount === 0
            ? "誰にも割り当てられていません"
            : `${role.memberCount} 人に割り当て済み`,
        }),
      ),
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
      el("div", { class: "scroll" }, el("table", { class: "form" }, casesBody)),
      el(
        "div",
        { class: "row" },
        el("button", {
          text: "＋ テストを追加",
          onclick: () => {
            draft.cases.push({ expect: "readable", path: "" });
            drawCases();
          },
        }),
      ),
      el(
        "div",
        { class: "row role-actions" },
        el("button", {
          class: "primary",
          text: isNew ? "このロールを作成" : "保存",
          onclick: () =>
            guard(async () => {
              const text = apply();
              if (text === null) return;
              const name = draft.name;
              if (
                await saveDocument(
                  text,
                  isNew ? `${name} を作成しました` : `${name} を保存しました`,
                )
              ) {
                selectedRole = name;
                creatingRole = false;
              }
            }),
        }),
        el("button", {
          text: "検証だけする",
          onclick: () =>
            guard(async () => {
              const text = apply();
              if (text === null) return;
              const result = await api.put("/console/api/policy", {
                text,
                dryRun: true,
              }).catch((e) => e.body ?? Promise.reject(e));
              showResult(result, "この内容なら保存できます");
            }),
        }),
        isNew
          ? el("button", {
            text: "取消",
            onclick: () => {
              creatingRole = false;
              render();
            },
          })
          : el("button", {
            class: "danger",
            text: "このロールを削除",
            onclick: () =>
              guard(async () => {
                const warn = role.memberCount > 0
                  ? `${role.name} は ${role.memberCount} 人に割り当てられています。削除すると全員がこのロール由来の権限を失います。`
                  : `${role.name} を削除します。`;
                if (!confirm(warn)) return;
                selectedRole = null;
                await saveDocument(
                  spliceBlocks(policy.text, draft.ranges, null),
                  `${role.name} を削除しました`,
                );
              }),
          }),
      ),
    );
  }

  const selected = policy.roles.find((r) => r.name === selectedRole);
  const detail = creatingRole
    ? roleDetail(null, true)
    : selected
    ? roleDetail(selected, false)
    : el(
      "div",
      { class: "card roledetail" },
      el("p", {
        class: "muted",
        text:
          "左の一覧からロールを選ぶか、「＋ ロールを追加」で作成してください。",
      }),
    );

  // ---- 原文の直接編集 (取り込み・全体レビュー用) ----

  const rawEditor = el("textarea", {
    class: "policy",
    spellcheck: "false",
    rows: "20",
  });
  rawEditor.value = policy.text;

  const rawCard = el(
    "div",
    { class: "card", hidden: "" },
    el("p", {
      class: "hint",
      text:
        "文書そのものを編集します。他所からの取り込みや、コメントを含めた全体の書き換え向け。",
    }),
    rawEditor,
    el(
      "div",
      { class: "row" },
      el("button", {
        class: "primary",
        text: "保存",
        onclick: () =>
          guard(() => saveDocument(rawEditor.value, "保存しました")),
      }),
      el("button", {
        text: "検証だけする",
        onclick: () =>
          guard(async () => {
            const result = await api.put("/console/api/policy", {
              text: rawEditor.value,
              dryRun: true,
            }).catch((e) => e.body ?? Promise.reject(e));
            showResult(result, "この内容なら保存できます");
          }),
      }),
    ),
  );

  const toolbar = el(
    "div",
    { class: "row toolbar" },
    el("span", {
      class: "muted",
      text: `適用中: 版 ${policy.version}` +
        (policy.createdAt ? ` (${fmtTime(policy.createdAt)})` : ""),
    }),
    el("button", {
      text: "文書を直接編集",
      onclick: () => {
        rawCard.hidden = !rawCard.hidden;
      },
    }),
  );

  const issueCard = (title, items) =>
    items.length === 0 ? null : el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "issues warn" },
        el("h4", { text: title }),
        el("ul", null, items.map((t) => el("li", { text: t }))),
      ),
    );

  const versionRows = versions.map((v) =>
    el(
      "tr",
      null,
      el("td", { text: `版 ${v.version}${v.current ? " (適用中)" : ""}` }),
      el("td", { class: "muted", text: fmtTime(v.createdAt) }),
      el("td", { class: "muted", text: `${v.bytes} bytes` }),
      el(
        "td",
        { class: "actions" },
        v.current ? null : el("button", {
          text: "この版に戻す",
          onclick: () =>
            guard(async () => {
              const record = await api.get(
                `/console/api/policy/versions/${v.version}`,
              );
              if (!confirm(`版 ${v.version} の内容で保存し直します。`)) return;
              await saveDocument(record.text, `版 ${v.version} に戻しました`);
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
    toolbar,
    report,
    el("div", { class: "split" }, list, detail),
    issueCard(
      "⚠ 実在しないパスを指しているルール",
      policy.dangling.map((d) =>
        `${d.role}: ${d.path} — タイポ / 大小文字違い / 削除 / API 外の mv`
      ),
    ),
    issueCard("警告", policy.warnings.map((w) => w.message)),
    rawCard,
    el(
      "div",
      { class: "card" },
      el("h3", { text: "版の履歴" }),
      table(["版", "保存日時", "サイズ", ""], versionRows),
    ),
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
  if (!issued.enrollUrl) {
    return el(
      "div",
      { class: "invite" },
      el("strong", {
        text: "招待を発行しましたが、リンクを組み立てられませんでした",
      }),
      el("p", {
        class: "hint",
        text:
          "サーバ側に MIKURA_PUBLIC_URL が設定されていません。設定すると、そのまま配れる招待リンクを表示できます。",
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
  const link = el("code", { text: issued.enrollUrl });
  return el(
    "div",
    { class: "invite" },
    el("strong", {
      text: "招待リンク (この画面を離れると二度と表示できません)",
    }),
    link,
    el(
      "div",
      { class: "row" },
      el("button", {
        class: "primary",
        text: "コピー",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(issued.enrollUrl);
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
