## ADR-024: Folder creation + rename support (server endpoint extensions)

**Decision**: Add **`POST /folders/*path`** (non-recursive mkdir) and **`PATCH /files/*path`** (rename / move) to the server. The client calls these via `IMikuraServer.CreateFolderAsync` / `RenameAsync`, and wires them to WinFsp's corresponding callbacks via `MikuraServerBackend.CreateAsync(isDirectory)` / `RenameAsync`.

**Background**:

Immediately after the WinFsp migration, `MikuraServerBackend` was derived from the spike, so:

- `CreateAsync(isDirectory: true)` always returned `null` -> Explorer's "New > Folder" was non-functional
- `RenameAsync` threw `NotSupportedException` -> Explorer's "Create new file -> edit name" failed

From the user's perspective this looked like "cannot create new files" (in reality Create succeeded but the immediate Rename failed).

**Server-side API**:

| Endpoint | Spec |
|---|---|
| `POST /folders/*path` | Non-recursive mkdir. 404 if parent missing, 409 if same name already exists. 201 with `{ path }` |
| `PATCH /files/*path` body: `{ newPath }` | Move from old to new. 409 on conflict, 404 if target missing, requires write permission on both source and destination |
| `DELETE /files/*path` (existing) | Delete file/directory. Called from `MikuraServerBackend.CleanupAsync(Delete)` |

Server implementation: `Deno.mkdir({ recursive: false })` and `Deno.rename`. Conflict detection is a `Deno.stat` precheck.

**Client implementation**:

- Add `CreateFolderAsync` (POST, treats 409 as idempotent) and `RenameAsync` (PATCH JSON body) to `Mikura.Transport.HttpMikuraServer`
- In `MikuraServerBackend.CreateAsync(isDirectory: true)`, call `_server.CreateFolderAsync(path)`, register into `_tree`, and return a handle
- In `MikuraServerBackend.RenameAsync`, call `_server.RenameAsync(src, dst)` and update `_tree` by removing `src` / adding `dst`. When `replaceIfExists=true`, the client first calls `DeleteFileAsync(dst)` before renaming
- Change `MikuraServerBackend.CanDeleteAsync` to allow directories too (previously files only)

**Position on the phase roadmap**:

After WinFsp integration completed in ADR-021's Phase B/C/D, the server-side work that had accumulated on the CfApi-era `feature/explorer-create-rename` branch was ported as this ADR's feature addition. The API extension portion of `client/src/Mikura.Transport/HttpMikuraServer.cs` that had been stashed is brought into the post-WinFsp pivot structure.

**Not supported (Known limitation)**:

- Directory creation is **one level only** (`recursive: false`). The Windows shell issues CreateFile from parent to child so this is normally fine, but automation scripts creating a deep tree at once must POST each level individually.
- Behavior of deleting non-empty directories depends on the server's `deleteFile` implementation. Verify behavior before deleting deep nests in test trees.

**Implementation location**:

- `server/src/routes/files.ts` (handlers for POST `/folders/*` and PATCH `/files/*`)
- `server/src/services/file.service.ts` (`createFolder` / `renameEntry` functions)
- `client/src/Mikura.Core/Abstractions/IMikuraServer.cs` (API definition)
- `client/src/Mikura.Transport/HttpMikuraServer.cs` (HTTP call)
- `client/src/Mikura.Core/Sync/MikuraServerBackend.cs` (wiring to WinFsp)

**Related ADRs**:

- Premise: ADR-021 (WinFsp migration)
- Complement: ADR-022 (locking on rename is treated equivalently to write-intent open)

---
