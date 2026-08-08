## ADR-033: Admin console as a separate BFF process (`console/`)

**Decision**: Ship the administrative web console as a **separate Deno process in its own top-level `console/` directory**, not as routes mounted on the API server. The console never opens Deno KV and never touches the data root; it holds an admin bearer token and calls the API server's existing `/admin/*` REST surface over HTTP, exactly like `cli/adminClient.ts` already does. It listens on a **loopback-bound port that is disabled by default** and is started only when administration is actually being performed.

### Background

Every administrative operation currently requires shell access to the server host:

| # | Step | Friction |
|---|---|---|
| 1 | `deno task admin add-user` | Shell on the server host, per operation |
| 2 | `deno task admin set-permission` | Path + level typed on the command line |
| 3 | `deno task admin issue-init --out x.init.json` | The artifact is a **file** |
| 4 | Transfer `init.json` to the user's machine | Out-of-band transfer of a live single-use credential |
| 5 | Client: tray → Add Profile → file picker for a JSON file | "Pick a JSON file" is not a usable instruction for an end user |

Steps 1–2 are solved by a console. Steps 3–5 are a separate concern (see ADR-034). This ADR covers only the console.

The `/admin/*` REST surface introduced with the multi-account work is already complete for users, groups, group membership, permissions, enrollments, and tokens. What is missing is a front-end and a credential path a browser can use — **not** new business logic.

### Why not mount the console on the API server

The obvious implementation is `app.get("/console/*", ...)` plus a session cookie branch in `authMiddleware`. It was rejected on three grounds.

**Permanent attack surface.** The API server is the component exposed to every client on the network. Adding an HTML console to it means the console is reachable whenever the file system is reachable, whether or not anyone is administering anything. A path-level guard does not help much: it lives on the same listener, so a single reverse-proxy misconfiguration exposes it. Separating the listener moves the boundary down to the network layer, where a misconfiguration cannot silently defeat it.

**It forces a second credential model into `authMiddleware`.** A browser can present neither `Authorization: Bearer` nor `X-Device-Id`. Mounting the console in-process would require:

1. extending the skip list beyond `/health` and `/enroll`,
2. accepting a session cookie as an alternative credential,
3. exempting cookie-authenticated requests from `boundDeviceId` verification and from `upsertDevice` (a browser is not a mount device and must not appear in the device registry),
4. adding CSRF defenses, which only exist because of (2).

All four disappear under the separated design, because the console authenticates to the API server as an ordinary bearer-token client. **`authMiddleware` needs no changes at all.**

**It would foreclose containerised separation.** The eventual goal is a console that is started and stopped independently (`docker compose up console` / `stop console`). If the console reads Deno KV directly, that split later requires either multi-process access to the same SQLite-backed KV — an unverified property we would rather not depend on — or a rewrite. Routing the console through HTTP from the start makes the split a deployment change rather than a redesign, and removes the KV-sharing question entirely.

### Topology

```
browser ──session cookie──▶ console (loopback:8701) ──Bearer + X-Device-Id──▶ API (:8700) ──▶ Deno KV
          trust boundary       holds the admin token                 unchanged surface
                               never reaches the browser
```

- The console binds loopback by default. Remote administration goes through an SSH tunnel or an overlay network, not through a published port.
- `MIKURA_CONSOLE` defaults to off. When off, the console listener is not started at all — there is no route to probe and no session code path in memory.
- Browser sessions live in the console process's memory. Restarting the console invalidates them, which is the desired behaviour for an occasionally-run administrative tool.
- The admin bearer token is supplied to the console via environment variable and is never sent to the browser.

### Permission boundary

The console must **not** be a transparent proxy. A blanket `/console/api/*` → API pass-through would let anyone holding a console session reach `/content/*` and `/files/*` with admin credentials — that is, read every file on the server through the administration UI.

Instead, `console/src/routes/admin.ts` declares one thin handler per endpoint the console actually needs. The set of declared handlers *is* the console's permission boundary, and it is auditable by reading a single file.

| Console screen | browser → console | console → API server | API server |
|---|---|---|---|
| Login | `POST /auth/session` | `GET /admin/users` (token reachability + admin check) | existing |
| whoami / logout | `GET` / `DELETE /auth/session` | — (console-local) | — |
| User list | `GET /console/api/users` | `GET /admin/users` | existing |
| User create | `POST /console/api/users` | `POST /admin/users` | existing |
| User delete | `DELETE /console/api/users/:id` | `DELETE /admin/users/:id` | existing |
| User detail | `GET /console/api/users/:id` | `GET /admin/users/:id` | existing |
| — its groups | ″ | `GET /admin/user-groups/:userId` | **new** |
| Group list / create / delete | `GET`/`POST /console/api/groups`, `DELETE /console/api/groups/:id` | same names under `/admin` | existing |
| Membership add / remove | `POST /console/api/user-groups`, `DELETE /console/api/user-groups/:userId/:groupId` | same names under `/admin` | existing |
| Permission matrix read | `GET /console/api/permissions?path=` | `GET /admin/permissions?path=` | **new** |
| Permission set / clear | `PUT`/`DELETE /console/api/permissions` | same names under `/admin` | existing |
| Path picker | `GET /console/api/tree` | `GET /tree` | existing (see below) |
| Issue invitation | `POST /console/api/enrollments` | `POST /admin/enrollments` | existing (response extended, ADR-034) |
| Invitation list | `GET /console/api/enrollments` | `GET /admin/enrollments` | **new** (`userId` becomes optional) |
| Token list | `GET /console/api/tokens` | `GET /admin/tokens` | **new** (`userId` becomes optional) |
| Token revoke | `DELETE /console/api/tokens/:hash` | `DELETE /admin/tokens/:tokenHash` | existing |
| Device list | `GET /console/api/devices` | `GET /admin/devices` | **new** |
| Audit log | `GET /console/api/audit` | `GET /admin/audit` | **new** |

`GET /tree` is the single endpoint outside `/admin/*` that the console is permitted to call. The permission editor needs to browse the path namespace, and `/tree` returns structure only. The rule to hold to is: **the console may call `/admin/*` and `GET /tree`, nothing else.** In particular `/content/*` is never proxied, so the console cannot be used to exfiltrate file contents.

### Deno permissions as the enforcement mechanism

The separation is not merely a convention; it is enforced by the runtime permission set the console is launched with:

```
deno run --allow-net=<api-host> --allow-read=./src/ui --allow-env src/main.ts
```

No `--unstable-kv`, no write access to the data root, and outbound network restricted to the API host. An implementation mistake that calls `getKv()` fails at startup rather than silently widening the console's reach. This is why the console gets its own `deno.json` with its own task definitions rather than sharing the server's.

### Types are not shared with the server

The console declares its own DTOs for `/admin/*` responses instead of importing `server/src/types.ts`. The wire shapes and the server's internal types genuinely differ — `User` carries `passwordHash`, while `GET /admin/users` projects to `{ id, name, createdAt }`. Importing the internal type would present fields to console code that never cross the wire. Redeclaring is both more accurate and keeps the container build context confined to `console/`. A shared package is premature at this size.

### Consequences

- `authMiddleware` and every existing `/admin/*` handler are untouched. The API server gains no new unauthenticated endpoint; `/health` and `/enroll` remain the only two.
- The seven new `/admin/*` endpoints sit behind `authMiddleware` + `requireAdmin`, so they are visible only to holders of an admin token. No new trust boundary is created.
- `cli/admin.ts` is retained. It remains the bootstrap path (the console needs an admin token to exist before it can be used) and the headless path.
- The console is a second process to operate. Given that it is off by default and only started for administration, this is accepted.
- Session storage is in-memory and therefore single-instance. Horizontally scaling the console is not supported and is not a goal.

### Rejected alternatives

**Console routes on the API server with cookie auth.** Rejected above: permanent exposure, four changes to `authMiddleware`, and no path to containerised separation.

**Console container reading Deno KV directly.** Removes the HTTP hop but depends on multi-process access to the same SQLite-backed KV, duplicates the permission logic that `checkPermission` already implements, and gives the console write access to authoritative state. The HTTP hop costs a local round trip on an interactive admin UI, which is not a meaningful cost.

**Browser calling `/admin/*` directly with a token entered in the UI.** Would eliminate the console backend entirely, but places an admin bearer token in browser-accessible storage, where any XSS in the console UI yields full administrative control. The BFF exists precisely so the token never leaves the server side.

**Replacing enrollment with username/password login.** Would remove out-of-band credential distribution altogether, but discards the single-use, device-bound enrollment model and introduces password reset and lockout handling. Deferred; the console plus ADR-034 removes most of the friction without touching the authentication model.
