## ADR-034: Enrollment handoff via a `mikura://` URI instead of an `init.json` file

**Decision**: Replace the `init.json` file as the primary enrollment artifact with a **single `mikura://enroll?...` URI** that carries both the server URL and the enrollment secret. The console displays it as copyable text and as a QR code; the client accepts it by paste in a one-field dialog, and — once the URI scheme is registered — by clicking the link directly. The file-drop path (`inits/*.init.json`) is retained for headless and bulk provisioning. The enrollment secret itself is **not** shortened.

### Background

ADR-033 removes the need for shell access to administer the server, but it does not change what the administrator has to hand to the user. Today that is a file:

```json
{ "ServerUrl": "https://server.example.com:8700", "EnrollmentSecret": "...", "ExpiresAt": "...", "UserName": "alice" }
```

The administrator produces it with `issue-init --out`, transfers it out of band, and the user selects it through an `OpenFileDialog` in the tray menu. Three problems compound:

- A file is the most awkward possible carrier for a short-lived credential — it gets saved to disk on both ends, forwarded, and left behind.
- "Select the JSON file your administrator sent you" does not survive contact with a non-technical user.
- The file picker is the last step of a flow that is otherwise fully automatable, so it caps how good the setup experience can get.

### Wire format

```
mikura://enroll?u=https%3A%2F%2Fserver.example.com%3A8700&s=<secret>
```

- `u` — percent-encoded server base URL, taken from the API server's `MIKURA_PUBLIC_URL`. It has to be configured rather than inferred: a server cannot reliably derive its own externally reachable address from an inbound request, and the console only knows the *internal* address it dials (loopback or a container network), which is exactly the wrong value to hand a client.
- `s` — the enrollment secret, unchanged in format from what `POST /admin/enrollments` returns today.

Everything else that `init.json` carried is dropped or derived:

- `ExpiresAt` was advisory only; the server is authoritative and answers `410 Gone` on an expired secret. Carrying it invites the client to make its own judgement about validity.
- `UserName` is returned by `POST /enroll` in the response body, so it does not need to travel in the invitation. This also means the invitation reveals nothing about who it is for if intercepted.
- `MountLetter` was already deliberately excluded — the drive letter is the user's choice, not the administrator's, and a fixed letter collides on shared machines.

`POST /admin/enrollments` is extended to return `enrollUrl` alongside the existing `secret`. The raw secret stays in the response so `cli/admin.ts` and the `init.json` path keep working unchanged.

When `MIKURA_PUBLIC_URL` is not configured, `enrollUrl` is `null` rather than a guess. A wrong URL in an invitation fails at the user's machine, long after the administrator has stopped watching; a `null` fails in the console, where it can be explained. Making it a hard startup requirement was rejected because it would break existing deployments that only use the CLI, which does not need the field at all.

### The secret is not shortened

A shorter, hand-typeable code (roughly 12 base32 characters) was considered so that the invitation could be dictated verbally. It is rejected for now:

- Paste and click are the primary paths. Hand-typing is a fallback that, in practice, nobody would use once a QR code exists.
- `POST /enroll` currently has **no rate limiting**. Reducing the secret from a UUID's entropy to ~60 bits is only defensible with a throttle in front of it, and that throttle is real work — it needs to be per-IP and per-secret-prefix, and it must not become a denial-of-service lever against legitimate enrollment.

Keeping `crypto.randomUUID()` costs nothing given the transport, and leaves the rate-limiting work optional rather than blocking. If a typeable code is wanted later, the rate limiter is the prerequisite and should be its own decision.

### Client intake

The tray's Add Profile dialog becomes a single text field instead of a file picker:

1. On open, inspect the clipboard. If it holds something that parses as an enrollment invitation, prefill the field.
2. Accept either a `mikura://enroll?...` URI or the raw contents of an `init.json` pasted as text. Both normalise to `(serverUrl, secret)` through one parser, so the legacy shape stays supported without a second code path.
3. Offer a drive letter chosen from the **currently free** letters rather than defaulting to a fixed `Z:`, which collides as soon as a second profile is added.
4. Surface enrollment failures in the dialog. The existing scanner moves failed `init.json` files to `inits/failed/` and logs via `Trace`, which is invisible to the user at the moment they need the information.

Registering `mikura://` as a protocol handler (`HKCU\Software\Classes\mikura`, no installer or elevation required) makes a link sent over chat launch the client with the dialog prefilled, reducing the user's part of the flow to a single confirmation.

### Security notes

- The invitation is a live single-use credential, exactly as `init.json` was. A URI is not inherently more or less sensitive than a file — but it is more likely to end up in chat history, so the existing short TTL and single-use consumption matter more, not less. Neither is changed here.
- The secret appears in the URI's query string. Because the URI is never dereferenced over HTTP — the client parses it locally and sends the secret in a `POST /enroll` request body — it does not reach any server access log.
- Consumption remains atomic in `enrollment.service.ts`, so a leaked invitation that has already been used is inert, and the device binding established at `POST /enroll` still confines the resulting token to one machine.

### Consequences

- The administrator's flow becomes: open the console, create the user, set permissions, issue an invitation, copy a link. No shell, no file, no attachment.
- `EnrollmentScanner` and the `inits/` directory survive unchanged, so scripted provisioning of many machines is unaffected.
- `MIKURA_PUBLIC_URL` becomes a setting an administrator has to know about. It is optional, but without it the console can only show a raw secret and a note explaining what to configure.
- The `mikura://` scheme is now part of the client's public interface. Changing the parameter names later breaks invitations already in flight, so the parser should ignore unknown parameters from the outset.
