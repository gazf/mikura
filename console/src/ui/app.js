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
    groups: renderGroups,
    permissions: renderPermissions,
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
  const [users, groups] = await Promise.all([
    api.get("/console/api/users"),
    api.get("/console/api/groups"),
  ]);
  const memberships = await Promise.all(
    users.map((u) => api.get(`/console/api/users/${u.id}/groups`)),
  );

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

  const rows = users.map((u, i) => {
    const mine = memberships[i];
    const select = el(
      "select",
      null,
      el("option", { value: "", text: "グループを選択…" }),
      groups
        .filter((g) => !mine.some((m) => m.groupId === g.id))
        .map((g) => el("option", { value: String(g.id), text: g.name })),
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
          ? el("span", { class: "muted", text: "所属なし" })
          : mine.map((m) =>
            el(
              "span",
              { class: "row", style: "display:inline-flex;margin-right:8px" },
              el("span", {
                class: "pill",
                text: m.groupName ?? `(削除済み #${m.groupId})`,
              }),
              el("button", {
                text: "×",
                title: "この所属を外す",
                onclick: () =>
                  guard(async () => {
                    await api.del(
                      `/console/api/user-groups/${u.id}/${m.groupId}`,
                    );
                    toast("所属を解除しました");
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
                await api.post("/console/api/user-groups", {
                  userId: u.id,
                  groupId: Number(select.value),
                });
                toast("グループに追加しました");
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
    ...heading("ユーザー", "アカウントの作成と、グループ所属の割り当て。"),
    createCard,
    el(
      "div",
      { class: "card" },
      table(
        ["ユーザー", "所属グループ", "グループに追加", "作成日時", ""],
        rows,
      ),
    ),
  );
}

// -- groups --

async function renderGroups(target) {
  const groups = await api.get("/console/api/groups");
  const nameInput = el("input", {
    type: "text",
    placeholder: "新しいグループ名",
  });

  const rows = groups.map((g) =>
    el(
      "tr",
      null,
      el(
        "td",
        null,
        el("strong", { text: g.name }),
        " ",
        el("span", { class: "muted", text: `#${g.id}` }),
      ),
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
                  `${g.name} を削除します。このグループに紐づく権限も消えます。`,
                )
              ) return;
              await api.del(`/console/api/groups/${g.id}`);
              toast(`${g.name} を削除しました`);
              render();
            }),
        }),
      ),
    )
  );

  target.replaceChildren(
    ...heading(
      "グループ",
      "権限はグループ単位で付与します。ユーザーに直接は付きません。",
    ),
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row" },
        nameInput,
        el("button", {
          class: "primary",
          text: "グループを追加",
          onclick: () =>
            guard(async () => {
              const name = nameInput.value.trim();
              if (!name) return toast("グループ名を入力してください", true);
              await api.post("/console/api/groups", { name });
              toast(`${name} を作成しました`);
              render();
            }),
        }),
      ),
    ),
    el("div", { class: "card" }, table(["グループ", ""], rows)),
  );
}

// -- permissions --

async function renderPermissions(target) {
  const [perms, groups, tree] = await Promise.all([
    api.get("/console/api/permissions"),
    api.get("/console/api/groups"),
    api.get("/console/api/tree"),
  ]);

  const dirs = [
    "/",
    ...tree.filter((n) => n.type === "directory").map((n) => n.path),
  ];
  const paths = [...new Set([...dirs, ...perms.map((p) => p.path)])].sort();

  const pathSelect = el(
    "select",
    null,
    paths.map((p) => el("option", { value: p, text: p })),
  );
  const groupSelect = el(
    "select",
    null,
    groups.map((g) => el("option", { value: String(g.id), text: g.name })),
  );
  const levelSelect = el(
    "select",
    null,
    ["read", "write", "admin"].map((lv) =>
      el("option", { value: lv, text: lv })
    ),
  );

  const groupName = (id) =>
    groups.find((g) => g.id === id)?.name ?? `(削除済み #${id})`;

  const rows = perms
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path) || a.groupId - b.groupId)
    .map((p) =>
      el(
        "tr",
        null,
        el("td", null, el("code", { text: p.path })),
        el("td", { text: groupName(p.groupId) }),
        el("td", null, el("span", { class: "pill", text: p.accessLevel })),
        el(
          "td",
          { class: "actions" },
          el("button", {
            class: "danger",
            text: "解除",
            onclick: () =>
              guard(async () => {
                const q = `path=${
                  encodeURIComponent(p.path)
                }&groupId=${p.groupId}`;
                await api.del(`/console/api/permissions?${q}`);
                toast("権限を解除しました");
                render();
              }),
          }),
        ),
      )
    );

  target.replaceChildren(
    ...heading(
      "権限",
      "パス × グループ × アクセスレベル。下位パスは上位の設定を継承します。",
    ),
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row" },
        pathSelect,
        groupSelect,
        levelSelect,
        el("button", {
          class: "primary",
          text: "権限を設定",
          onclick: () =>
            guard(async () => {
              await api.put("/console/api/permissions", {
                path: pathSelect.value,
                groupId: Number(groupSelect.value),
                accessLevel: levelSelect.value,
              });
              toast("権限を設定しました");
              render();
            }),
        }),
      ),
      el("p", {
        class: "sub",
        style: "margin:10px 0 0",
        text: "パス候補はサーバ上のディレクトリ構造から取得しています。",
      }),
    ),
    el(
      "div",
      { class: "card" },
      table(["パス", "グループ", "レベル", ""], rows),
    ),
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
