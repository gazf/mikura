## ADR-036: Role records with per-role generations, replacing the single versioned document

**Decision**: Store **one role per KV record**, each carrying its own **generation history** and an **enabled flag**. The policy text becomes a derived import/export format rather than the storage location. **This ADR revises ADR-035's storage and editing decisions only**; the model — named roles, `max` across roles, nearest-ancestor within a role, default-deny-means-invisible, derived visibility, pinned rule paths, the two testing layers — is unchanged and this ADR depends on all of it.

### Background

ADR-035 chose a single versioned document, and gave three reasons: a file on disk would bypass validation, "who can access what" should be readable as one artifact, and retained versions give diff and rollback for free. The first survives contact with implementation. The other two did not, in the specific ways below.

**The unit of operation is a role, but the unit of storage was the whole document.** Every real edit is "change what `projects-editor` grants". Saving that required rewriting the entire document, so the console had to splice a role's block into the text over its line range — the parser had to report `endLine` purely so the editor could put text back where it found it. That machinery exists only to bridge a mismatch between how the data is edited and how it is stored.

**Rollback was at the wrong granularity.** To see what one role looked like before yesterday's change, an operator had to diff two full-document snapshots and find the relevant hunk. Restoring one role meant reconstructing a document that mixed that role's old state with every other role's current state. The thing people want to undo is a role.

**Snapshots grew without bound.** Each save wrote a full copy of the text. Nothing pruned them. This is invisible at first and unpleasant later, and no retention policy is obviously right for whole-document snapshots — dropping old versions of a document silently drops the history of roles that were not even edited.

**Three UI attempts failed against the same mismatch.** A raw textarea, then per-role cards, then a master/detail pane. Each was an attempt to make a role-shaped interface sit on a document-shaped store. The interface that was actually wanted — a table of roles with edit and enable/disable per row — is trivial over records and awkward over a document.

### What changes

| | ADR-035 | ADR-036 |
|---|---|---|
| Storage | `["policy_versions", n]` → full text | `["roles", name]` + `["role_generations", name, gen]` |
| Save unit | whole document | one role |
| History | document versions, unbounded | per-role generations, last 10 |
| Text | the stored artifact | derived; import and export only |
| Enable/disable | not expressible | `enabled` flag, `disabled role X { }` in text |

`PUT /admin/policy` becomes an **import** — a replacement of all roles, not a merge — and `GET /admin/policy` an export. Import runs the same guards as any other write; only the bootstrap path (`seed`, the recovery CLI) may skip them, because the "at least one admin" check necessarily fails before anyone is assigned.

### Text is derived, not stored

The compiled policy is built by rendering the records to text, parsing it, and compiling that. The detour is deliberate: it keeps **one** parser and **one** evaluator. A records-to-compiled path built alongside the text path would be a second implementation of the same semantics, and the two would drift — the class of bug where the console shows one thing and the file system enforces another.

The cost is a parse on every cache miss, which happens once per change rather than once per request.

Rendering is deterministic and roles are emitted in name order, so export is stable and diffable. Hand-written comments in an imported document are **not** preserved, which is the real loss relative to ADR-035: the document is no longer a place to write prose. Explanation belongs in role names and in the console.

### Enabled is not a permission

A disabled role contributes nothing to any user's effective level. Its definition and its assignments both remain. This is the operational switch that was previously only expressible by deleting the role and re-creating it later — which destroyed the assignments and the history along with it.

Three consequences follow, and each was decided rather than inherited:

- **Role unit tests still run for disabled roles.** A test states what the role means; disabling states whether it currently applies. If tests stopped running while a role was off, re-enabling it would be a leap in the dark. A disabled role whose tests fail cannot be saved.
- **Pinned paths still include disabled roles' rules.** Disabling is temporary, and a folder deleted meanwhile would leave the rule dangling on re-enable.
- **Disabling the last role granting `admin /` is refused**, by the same invariant that refuses deleting it. This falls out of running the guard on the candidate state rather than being a special case.

### Generations

A generation is created **only by a definition change**. Switching the active generation does not create one, and neither does toggling enabled — otherwise "flip it off and on again" would bury the actual edit history.

Retention is the last 10 per role, pruned on save. The requirement this serves is "go back to what it was", not "reconstruct the audit trail" — the audit log already answers who changed what and when, and it is the right place for that question because it spans every entity rather than just roles.

### Validation still runs over all roles

Saving one role validates the **entire candidate set**: the role in question replaced, everything else as stored. Nothing about the checks is per-role — cross-role `deny` collisions, the assignment-layer assertion veto, and the "at least one user holds `admin /`" invariant all require the whole picture. Per-role storage narrows what is written, not what is checked.

This is what keeps ADR-035's guarantee that the console cannot save a configuration that locks everyone out, while giving up the whole-document PUT.

### Consequences

- `["policy_current"]` and `["policy_versions", n]` are removed. `savePolicy`, `listPolicyVersions`, and `installBootstrapPolicy` are replaced by `saveRole`, `setRoleEnabled`, `activateGeneration`, `deleteRole`, `listRoleGenerations`, and `importPolicyText`.
- `PolicyRole` gains `enabled`; the grammar gains a leading `disabled` modifier. `endLine`, added so the console could splice text, is retained only because it costs nothing and keeps parse errors locatable.
- `deleteRole` removes the role's assignments too. Leaving them would produce a permanent "assignment points at an undefined role" warning with no way to clear it.
- The console's roles tab is a table with edit and enable/disable per row, and a separate editor screen. The text import/export moves out of the main editing path.
- Optimistic concurrency narrows from the document to the role: two administrators editing different roles no longer conflict.

### Rejected alternatives

**Keeping the document and deriving per-role history from version diffs.** Every question about one role would require reading and diffing full snapshots, and retention would still have to be decided for the document as a whole.

**Storing records and dropping the text entirely.** Export is what makes a policy movable between deployments and reviewable outside the console. Removing it would trade a genuine capability for the deletion of one rendering function.

**A separate compiled-from-records path, skipping the text detour.** Two implementations of the same semantics, guaranteed to drift. The parse cost it saves is incurred once per change.

**Treating enable/disable as a generation.** It would make the generation list a mix of "what this role means" and "whether it was on", and the second would quickly outnumber the first.

### Relationship to other ADRs

- **Revises ADR-035** on storage, the editing API, and the console's shape. The evaluation model, the levels, invisibility and derived visibility, pinned rule paths, the two testing layers, and the reasoning behind all of them are unchanged and still authoritative.
- **Depends on ADR-033.** The console remains a BFF reaching `/admin/*`; the relay handlers gain the role endpoints and stay declared one by one.
