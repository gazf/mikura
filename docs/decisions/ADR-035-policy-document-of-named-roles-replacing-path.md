## ADR-035: Policy document of named roles, replacing path × group permission rows

**Decision**: Replace the per-row `["permissions", path, groupId]` model with a **versioned policy document of named roles**. **This ADR supersedes ADR-008** (the permission model is redesigned; the path hierarchy and the read/write/admin levels are retained). A role is a set of path rules; users are assigned roles directly and **groups are removed**. Evaluation is **order-independent**: the maximum across the user's roles, where each role independently resolves to its nearest-ancestor rule. The default is deny, and a path with no effective level is **invisible** rather than visible-but-refused. Rules remain keyed by **path**, not by object identity. The document holds definitions and their unit tests only; everything that knows about users lives in the assignment layer.

### Background

The current model has three defects, one of which caused a real incident while building the admin console (ADR-033).

**Group ordering is implicit and hostile.** `checkPermission` walks the path from most specific to least, and at each level iterates the user's groups in `kv.list` order — ascending group ID — returning on the *first* group that has an entry. A low-ID group with a weaker entry therefore **shadows** a stronger entry in a higher-ID group, so adding a user to a group can *reduce* their access. ADR-008 specified "OK if any of them grants permission"; the implementation drifted to first-match-wins.

That drift is what let an administrator lock themselves out by setting `/` × admins to `read`. The single deciding entry became `read`, every `/admin/*` route returned 403, and recovery required editing Deno KV directly.

**Authorization is not readable as a whole.** There is no artifact an operator can read to answer "who can access what". Rows are edited one at a time, with no diff, no history, and no review unit. This is the failure mode of AD-less Samba, where authorization is spread across Unix accounts, the Samba passdb, `smb.conf` share stanzas, and POSIX ACLs — four unsynchronized stores with no single view. mikura has exactly one store and squanders that advantage by exposing it as an unreadable pile of rows.

**Groups conflate two jobs.** A group is both "a named set of people" and "the thing permissions hang off". A one-person exception therefore requires inventing a one-person group, and the group list degenerates into a mix of roles and individual carve-outs.

### Grammar

```
role sales-project {
  allow  write  /projects
  allow  read   /shared
  deny          /projects/secret
}

test sales-project {
  writable   /projects/spec.md
  readable   /shared/notes.md
  invisible  /projects/secret/inner.txt
}
```

Top level has exactly two constructs, both `<keyword> <name> { lines }`.

Rule lines begin with a **verb** (`allow` / `deny`); test lines begin with an **adjective**. The parts of speech differ, so a line is identifiable without its enclosing block — which matters when reviewing a diff hunk. Fixed-width columns come first and the variable-width path last, so columns align regardless of path length.

`deny` takes no level. A partial denial ("deny read but allow write") describes a state nobody can reason about, so the language cannot express it.

Test levels mean **at least**, not exactly. The assertions that matter in practice sit at the ends of the ladder — `invisible` for secrecy, `admin /` for administrator survival, `invisible` on a deep path for deny propagation — where "at least" and "exactly" coincide. Only a middle-of-ladder over-grant (read that became write) escapes, which is the least valuable case to catch and not worth making the syntax harder to read.

`admin` has no adjective form and stays a noun. It is the one irregularity, and it is confined to `/`.

### Model

#### Roles, not groups

A role is a named set of rules. Users are assigned roles directly; there is no group layer.

Role **definitions** live in the policy document. Role **assignments** live in KV and are edited from the console. The split is deliberate: joiners and leavers are frequent and operational, while "what `sales-project` means" is structural and deserves review. Putting assignments in the document would make every new hire produce a diff in the security policy and turn review into noise.

Merging "set of people" into "set of permissions" is safe here only because roles are named after **what they grant**, never after **who holds them**. `projects-editor` is a good name; `sales-department` is not. A one-person exception becomes `alice-docs-readonly` assigned to one user — self-describing by construction, which is the opposite of the `tanaka-only` group it replaces. The console must nudge toward this naming.

Assignment edges become users × roles with no group layer. That is appropriate to a few dozen users and no more. Groups can be reintroduced later purely as named user sets: the assignment target widens to "user or group" and the evaluator does not change.

#### Evaluation

```
effective(user, path) = max over ( roles assigned to user ) of roleLevel(role, path)

roleLevel(role, path) =
    the single nearest ancestor-or-self rule for `path` within that role
    allow → its level;  deny → none;  no rule → none
```

Two properties follow, and both are load-bearing:

- **Order-independent.** Path specificity decides within a role; `max` decides across roles. Line order never affects the result, so the console never exposes rule ordering and no rule is silently shadowed.
- **Monotonic across roles.** Assigning a role can only grant more. The lockout class of bug becomes structurally impossible rather than merely guarded.

Two rules for the same path within one role are a **parse error**, not a tie to break.

#### Levels

`read < write < admin`, identical to the current implementation, so migration changes structure only and never reinterprets an existing grant.

| Level | Grants |
|---|---|
| *(none)* | Invisible |
| *visible* | Name only. **Derived, never written** |
| read | visible + enumerate + read content |
| write | read + create + update + **delete** + rename |
| admin | write + edit policy at or below this path (v1: `/` only; deeper is a parse error) |

`delete` is deliberately not a separate level. The need it addresses — recovering from accidental deletion — is better served by a recycle bin or versioning, which also covers the accidental overwrite and truncation that a delete permission cannot prevent anyway. Adding `delete` later is **not transparent**: it would silently strip deletion from everyone holding `write`, so it requires a mechanical `write` → `delete` rewrite of existing policies at migration time. This must be planned, not discovered.

#### Default deny means invisible

A path with no effective level does not appear in listings, rather than appearing and refusing access. Windows share defaults are the opposite, but Access-Based Enumeration exists precisely because operators want this, and Drive, Dropbox and SharePoint made it the default. A name like `/hr/termination-candidates` is itself information.

Three costs are accepted:

- Creating a name that collides with an invisible entry must fail with a generic "name unavailable" error. Existence leaks; nothing else does. Every ABE system has this.
- A user cannot request access to something they cannot see. The console needs a separate path for that.
- "Structure visible, contents hidden" is not expressible. If it becomes necessary the fix is a **non-recursive grant modifier**, not a new level.

#### Derived visibility

> When any role assigned to a user grants a level on path P, every **proper ancestor** of P becomes *visible* (non-recursive) to that user. Directory listings return only children that are themselves visible.

This is what makes invisibility workable: without it a grant on `/alice/docs` would be unreachable, because `/alice` would be invisible. It is the only non-recursive permission in the system and it is derived, never written — writing it would reintroduce exactly the busywork this design exists to remove.

It differs materially from a hypothetical explicit grant. Rules cover subtrees, so an explicit `visible` on `/alice` would expose every descendant name including `/alice/private`. The derived form marks the single node and nothing else.

It leaks only ancestor directory names, which are already implied by the grant that produced them.

Where a `deny` in one role and a deeper grant in another role disagree, **the grant wins for reachability**. Denying the ancestor would silently kill the deeper grant, and "written but does nothing" is the failure this design most wants to avoid. The condition is surfaced as a warning at save time.

#### deny is an override, not a subtraction

`deny` selects "none" at a more specific path *within one role*. It is not a subtractive overlay across the policy and it does not beat grants in other roles. This is the SharePoint/Drive "break inheritance and re-grant" model, not the NTFS/S3 "explicit deny wins globally" model.

The distinction decides auditability. With subtractive deny, answering "who can read `/hr`" requires proving no deny anywhere applies — an unbounded search. With override deny, only rules on `/hr` and its ancestors can affect the answer, so the reverse query stays a bounded lookup.

Because the surface syntax still reads as `deny`, documentation must describe it as **cutting inheritance**, not as removing access. Anyone who reads it as subtraction will write policies that do not mean what they think.

One composition hazard survives and is accepted: a `deny` in role A does not protect against an `allow` in role B, so a user holding both sees the path. Closing it would require deny to win globally, which would destroy monotonicity. It is covered by a static warning (below) and by assignment-layer assertions.

#### Paths

A rule covers its path and everything beneath it. There is no `**` and no wildcards in v1.

Matching is **case-insensitive**, folding ASCII `A-Z`/`a-z` only. Unicode case folding is excluded deliberately: its tables change between Unicode versions, and a changing table silently changes which rules match — that is, silently removes protection. NTFS freezes an uppercase table into the volume at format time and ext4 records a Unicode version in its superblock for the same reason. The folding rules therefore carry a **version**, and widening them is an explicit migration rather than a runtime upgrade.

A pre-existing defect is recorded but **not fixed here**: the client declares the volume case-insensitive (`CaseSensitiveSearch = false`) while the server resolves paths case-sensitively against a Linux filesystem. Unicode normalization (NFC vs NFD) has the same shape. Both belong to the file service, not to authorization.

### Rule-bearing paths are pinned

> A path appearing literally in any rule cannot be **renamed, moved, or deleted**. Its *contents* are unaffected and follow normal permissions.

Pinning propagates **upward, not downward**. A rule on `/shared/sales` pins `/shared/sales` and `/shared`, and pins nothing beneath it. Only paths written in rules are pinned, never the subtree they govern — otherwise a single `allow read /` would freeze the whole tree. In a realistic policy the pinned set is the handful of structural folders an administrator deliberately configured.

Rename and delete must both be blocked; blocking only rename leaves delete-and-recreate as a trivial bypass.

This is a structural constraint, not a permission, and it is the **only** one in the system. It can contradict the granted level: `allow write /shared` includes deletion, yet `/shared` cannot be deleted while a rule names it. Keeping the count of such constraints at exactly one is what prevents the "it just doesn't work and nobody knows why" experience that this project exists to avoid.

Holders of `admin /` may proceed, but the console requires them to state the intent rather than guessing it:

> `/shared/secret` has 2 rules. **[Re-anchor rules and rename] [Delete rules and rename] [Cancel]**

Because the default is deny, a renamed folder that escaped its rules would fall to *no rules at all* and therefore to invisible — the safe direction. Pinning exists for the narrower case where an ancestor grant would cover the new location, which is exactly the pattern where a rule is more restrictive than what it inherits.

### Object identity is rejected

Anchoring rules to a per-object ID assigned at creation would make rules follow renames and make case matching irrelevant. It is rejected.

| Event | Path-keyed | ID-keyed |
|---|---|---|
| Rename | Rule dangles | Follows |
| Delete and recreate under the same name | Rule reapplies — **fail-safe** | ID is dead — **fail-open** |
| Rule for a path that does not exist yet | Expressible | Not expressible |
| Policy moved to another server | Works | Every rule dangles |

The trade is symmetric, not a strict improvement, and the two cases path-keying wins are the two this project needs: authoring before the data exists, and moving a policy between deployments. Restore-from-backup and re-sync — which produce delete-and-recreate — are also more common in practice than renaming a governed folder, and ID-keying fails open on exactly those.

Storing *both* and reporting divergence was considered. It resolves nothing on its own, because after a rename the system still cannot tell "the same folder, renamed" from "this location's rules should apply" — the ambiguity is in the operator's intent, not in the mechanism. Pinning asks the operator directly instead, which is the same information at a fraction of the machinery.

An out-of-band `mv` on the server's `data/` directory remains undetectable and can expose content by moving it under a broader grant. This is accepted; `data/` is documented as not to be modified outside the API.

### Dangling rules

Every rule path is checked against the tree on policy load and periodically. A rule whose path does not exist is marked ⚠ in the console. One mechanism covers four causes: a typo, a case mismatch, a deletion, and an out-of-band `mv`. "This rule protects nothing" is the single signal worth surfacing.

Test paths are **not** checked. A test evaluates the policy function, not the filesystem, so asserting about a path that does not yet exist is legitimate.

### Two layers of testing

The policy document must not know about users. Assignment depends on roles; roles must never depend on assignment. Two kinds of assertion follow, and they live in different places.

**Role unit tests — in the document.** `test <role> { <level> <path> }` evaluates one role's own rules and mentions no users. It is not a restatement of the rules: the result for a given path is produced by nearest-ancestor resolution, so asserting `invisible` on a path several levels below a `deny` verifies that override propagates. Roles containing `deny` are where this earns its keep, and a `deny`-bearing role with no test produces a warning.

**User and composition assertions — in the assignment layer.** "tanaka's effective level on `/hr/payroll.xlsx` is invisible" depends on which roles tanaka holds, which is assignment state. So does the composition hazard where role A's `deny` is defeated by role B's `allow`. These assertions are stored and edited alongside assignments, never in the policy document.

They are still enforced against policy changes, without inverting the dependency: when a policy version is proposed, the **assignment layer evaluates its own assertions against it and vetoes the save** if any fail. This is the consumer-driven contract pattern — the provider does not know its consumers, but a consumer can refuse a breaking change.

The invariant "at least one user holds a role granting `admin /`" lives in the same layer, checked on assignment change, user deletion, and policy save. Together with `test admins { admin / }` in the document, this replaces `retainsRootAdmin` and its four call sites: the document guards the rule, the assignment layer guards the membership.

The console should offer to generate an assertion from a real user's current effective permissions, so that "freeze what tanaka can do today" is one action rather than an authoring exercise.

Splitting tests across two artifacts costs something: weakening an assertion and breaking the policy are now separate diffs, each innocuous alone. Keeping them together would have prevented that, at the price of inverting the layering. The mitigation is the audit log, which records both, and eventually a delegated-administration model in which the two edits require different authority.

### Storage, compilation, and validation

The policy is a **versioned document in Deno KV**, not a file on disk. A file would be editable in place, bypassing validation, tests, and audit — the specific reason `smb.conf` is unpleasant to operate. Text remains the representation for import, export, review and diff; it is not the storage location. Console writes use optimistic concurrency, and retained versions give diff and rollback for free.

The document is parsed and compiled **once per version** and held in memory. Permission checks become pure computation, removing the per-level, per-role KV lookups that `PermissionContext` currently caches only within a single request. `GET /tree` benefits most.

Validation on save:

- **Errors** — syntax; unknown role name in a `test`; duplicate path within a role; `admin` at a path other than `/`; a path containing `..`
- **Warnings** — what a broad rule actually covers; a role with no members; a `deny` with no broader `allow` in the same role, which removes nothing; a `deny` defeated by another role's `allow` on the same path; a `deny`-bearing role with no test
- **Rejection** — any role unit test that fails, or any assignment-layer assertion that the proposed version would break

### Diagnostics

Two queries, both first-class:

- **Forward** — "can tanaka write `/projects/a.txt`?", answered with the deciding rule per role.
- **Reverse** — "who can read `/hr`?", tractable only because `deny` is an override; it requires reading rules on `/hr` and its ancestors and nothing else.

The reverse query is what an operator actually asks during an audit, and it is what no AD-less Samba deployment can answer.

### Consequences

- `["groups", id]`, `["user_groups", userId, groupId]` and `["permissions", path, groupId]` are removed, along with the cascade in `DELETE /admin/groups/:id` and `retainsRootAdmin` with its four call sites.
- The console's Groups and Permissions tabs become Roles, Assignments, and Diagnostics.
- The 13 `checkPermission` call sites are unchanged; only the evaluator behind them changes. `GET /tree` changes behaviour, because ancestors of granted paths now appear as names where previously they were filtered out entirely.
- Level semantics are identical to today, so no existing grant is reinterpreted during migration.
- WinFsp can return only an NTSTATUS, so a pinned-path refusal reaches Explorer as a generic "access denied" with no explanation. Mitigations are a 📌 marker in the console and a tray notification carrying the server's message; the latter needs a channel from `Mikura.Transport` to `TrayAppContext` that does not exist yet and is out of scope here.

### Rejected alternatives

**Keeping groups as the permission anchor.** Preserves the conflation of "set of people" with "set of permissions", which is what forces one-person groups into existence.

**Union across all ancestor levels (most permissive wins everywhere).** Removes the ability to narrow a subtree at all, and with it any use for `deny`.

**Explicit deny that wins globally (NTFS/S3).** Reintroduces non-monotonicity across roles, prevents "sales cannot see it but the team lead can", and makes the reverse query unbounded.

**Ordered rules with first-match-wins (Gitolite, NTFS canonical order).** The implicit version of this caused the lockout. Making the order explicit and editable does not make it comprehensible as the policy grows.

**A rule file on the server filesystem.** Reproduces `smb.conf`: edits bypass validation, tests, and audit.

**Direct per-user permissions, as ADR-008 specified.** Unnecessary once a role can be assigned to one user, and it would create a second place to look when answering "why can X do Y".

**A separate `delete` level.** Solves roughly half of accidental data loss — it cannot prevent overwrite or truncation — while permanently enlarging the model. A recycle bin solves all of it and leaves the ladder at three rungs.

**chmod-style symbolic modes (`r+`, `w-`).** `r`/`w`/`x` denote independent bits, and borrowing the notation invites the combinable mental model that the linear ladder deliberately rejects. `+` also means "add this bit" in chmod, not "or better", so the notation would be familiar and wrong at once.

### Resolved at implementation time

The five questions this ADR left open were answered when it was built. They are recorded here rather than removed, because each one is a decision someone will want the reasoning for.

1. **No built-in `everyone`.** A second kind of subject would have to be understood everywhere a role is, to save one assignment per user. The console offers "assign to all users" instead, which produces ordinary assignment rows that the reverse query and the assertion layer already understand.
2. **`seed` writes a bootstrap policy** of `role admins { allow admin / }` plus `test admins { admin / }`, and assigns it to the admin user. `installBootstrapPolicy` skips the "at least one admin" check, which necessarily fails when nobody is assigned yet, but still validates the document.
3. **A stored version that fails to parse stops startup.** Failing closed and serving would present as "nobody can see anything", which reads as a permissions bug and gets misdiagnosed; refusing to start prints the parse error with line numbers. Since the save path validates, this can only be reached by a format change or KV corruption. Recovery is `deno task seed --policy <file>`, writing KV directly with the server down — the same break-glass shape as `seed --renew` for a lost admin token, and deliberately not reachable over HTTP, since HTTP requires the admin authority that the broken policy is withholding.
4. **"Role" is kept.** The alternatives considered (`grant`, `profile`, `ruleset`) each read worse in at least one of the three places the word appears — the grammar, the console, and the assignment table.
5. **The compiled policy is a plain in-memory structure**, not ephemeral KV. `Deno.openKv(":memory:")` is process-local, so it has exactly the same cross-process visibility as a `Map` while adding serialization and an async API to a per-IRP path. Multi-process deployment would poll a version counter in *persistent* KV on an interval — bounding staleness explicitly — not read the version per request.

Two additions were made during implementation and are part of the design:

- **`visible` is a fifth test adjective.** Derived visibility is the subtlest rule in the model, and without an adjective for it a role unit test cannot assert it at all. The ladder is `invisible < visible < readable < writable < admin`.
- **The console edits per role, but saves the whole document.** "One document" is a statement about storage, review and validation, not about the editing surface — and a raw textarea makes the common case (add a role, add a rule) harder than the row editor it replaced. Each role's form composes that role's block and splices it over the block's line range, which the parser now reports; splicing rather than regenerating the document preserves hand-written comments and role ordering. What stays forbidden is a **per-rule endpoint**, because that is what would let the document stop being the unit of validation and audit. Role renaming is not offered: assignments key on the name, so a rename would silently orphan them.
- **A `deny` defeated only by a role granting `admin /` produces no warning.** Administrators reach everything by definition, so the warning would fire on every `deny` ever written and bury the cross-role collisions that actually matter.

### Open questions

None outstanding. Two known follow-ups live outside this ADR: the case-sensitivity mismatch in the file service (recorded above, belongs to that layer), and the tray-notification channel that would let a pinned-path refusal reach the user with its reason instead of a bare NTSTATUS.

### Relationship to other ADRs

- **Revised by ADR-036** on storage and editing: roles are stored one per record with per-role generations and an enabled flag, and the text document becomes a derived import/export format. Everything in this ADR about the *model* — evaluation, levels, invisibility, derived visibility, pinned paths, the two testing layers — is unchanged.
- **Supersedes ADR-008.** The "user / group × path × action" model is replaced. Retained from it: walking the path hierarchy, and the `read` / `write` / `admin` levels. Discarded: per-user permission entries, groups as the permission anchor, and "OK if any of them grants" as an unordered union across the whole ancestor chain.
- **Depends on ADR-033.** The console is the only editor for the policy document and the assignment layer, and it reaches them through `/admin/*` as a BFF.

### Note

Two independent defects — rename orphaning a rule, and case mismatch orphaning a rule — arise from one root: **a rule keyed by a path string that the filesystem is free to reinterpret**. NTFS avoids both with a single decision, by attaching ACLs to objects. This ADR accepts path-keying with both holes mitigated rather than closed. A third defect from the same root should be read as a signal to revisit the decision rather than to patch again.
