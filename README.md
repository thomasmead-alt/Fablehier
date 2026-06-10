# Cost Centre Hierarchy Builder

A web application for reorganising SAP cost centre hierarchies during a restructuring.
**Entirely local**: plain HTML/CSS/JavaScript with **no libraries, no build step and no
network access** — open `index.html` in any modern browser (double-click works, no server
needed). All data stays in the browser; work in progress is kept in `localStorage` and can
be wiped with *Reset all data*.

## Workflow

### 1 · KS13 master data
Upload an export of **KS13 – Display Cost Centers: Master Data**. Supported formats:

- SAP pipe-framed list output (`|Cost Center|Name|…|`, separator lines are skipped)
- tab-separated, comma- or semicolon-CSV

The columns for **cost centre**, **name**, **person responsible** and **profit centre**
are guessed from the header row and can be corrected in the mapping panel. Duplicate
rows are skipped and counted. Files exported with Latin-1 encoding are detected and
re-decoded automatically.

### 2 · Projects
Create a project per restructuring work package and assign **profit centres** to it.
Every cost centre belongs to the project of its **current profit centre** — this is how
the KS13 population is split into project groups.

### 3 · Hierarchies
Upload two hierarchy files:

- **As-is (current)** — the hierarchy as it stands today.
- **To-be (target)** — the target hierarchy, representing **one** project group.
  Loading it creates an **editable working copy** (tab 5); this panel always shows the
  file exactly as uploaded.

Both accept either format (auto-detected, overridable):

| Format | Layout |
|---|---|
| Parent–child | Columns `Parent, Child[, Name]` (header optional; blank parent = root) |
| Level-based | One column per level (`Level1, Level2, …[, Name]`); a row states its node in the deepest filled column, empty leading columns inherit from the row above ("fill-down"), full-path rows also work |

IDs are matched across files case-insensitively, and leading zeros on numeric IDs are
ignored (`0000410100` ≡ `410100`). Multiple parents and cycles are rejected with warnings.

### 4 · Completeness & approvals
Select which project the target file represents. The app checks the working to-be
hierarchy for completeness:

- **Missing — recommendations**: cost centres of the project that are *not* in the to-be
  hierarchy, highlighted in red. Because the hierarchy is organisational, each gets a
  **recommended parent** based on the **person responsible** from KS13 (nodes already
  holding that person's other cost centres score highest; former as-is neighbours are a
  secondary signal). Each recommendation goes through an **approval flow**:
  - **Approve** — applies the placement to the working hierarchy (override the parent
    first for a manual placement). *Approve all recommendations* processes the whole list.
  - **Reject** — the cost centre stays missing but is marked as reviewed; it can be
    reconsidered later.
  - Approved placements can be undone, returning the cost centre to the list.
  Approved placements reinforce later recommendations for the same person responsible.
- **Extras** — cost centres in the to-be hierarchy that belong to a different project.
- **Unknown entries** — leaf entries that don't exist in KS13 at all.
- **As-is vs to-be comparison** — where each project cost centre sits today versus in the
  edited to-be hierarchy (moved / same parent / added / missing / rejected).

### 5 · Edit & export
The working to-be hierarchy is fully editable in two linked views of the **same working
copy** — switching tabs never loses changes:

- **Live view** (tree): drag a node onto a group to move it; row buttons rename (✎),
  add a child group (＋) and delete (✕). Deleting a group promotes its children one
  level up; deleting a cost centre returns it to the missing list. Moves that would
  create a cycle or place nodes under a cost centre are blocked.
- **Table view**: one row per node in hierarchy order — edit names inline and change a
  node's parent from a dropdown (own descendants are excluded automatically).

Additions versus the uploaded file are highlighted green; cost centres outside the
selected project amber. *Discard edits* reloads the working copy from the uploaded file.

**Exports** (CSV with UTF-8 BOM, Excel-friendly):

- **Node changes** — every `CREATE` / `MOVE` / `RENAME` / `MOVE+RENAME` / `DELETE` needed
  to turn the uploaded target file into the edited hierarchy, with old/new name and parent.
- **Cost centre changes** — every `ADD` / `MOVE` / `REMOVE`, with old/new parent, the
  as-is parent for context, and the source of each addition (approved recommendation,
  manual placement or editor).
- Full hierarchy as **parent–child** or **level-based** CSV (additions marked).
- **Completeness report** — every cost centre with its status
  (`OK` / `ADDED` / `MISSING` / `REJECTED` / `EXTRA` / `UNKNOWN`).

## Try it with the sample files

In `samples/`:

1. `sample_ks13.txt` — KS13 export (SAP pipe format), 14 cost centres.
2. Create a project *Engineering* and assign profit centres `P-ENG-01` and `P-ENG-02` to it.
3. `current_levels.csv` — as-is hierarchy (level-based).
4. `target_parent_child.csv` — to-be hierarchy for the Engineering project, deliberately
   missing `0000410150` and `0000420260`. The check flags both; the responsible-person
   recommendations place them under `ENG-PLATFORM` (Anna Mueller) and `ENG-DATA`
   (Ben Oduya) — approve, tweak the hierarchy in tab 5, then export the change files.

## Development

The app itself has zero dependencies. The parsing/matching/editing logic has a smoke-test
suite that runs with nothing but Node built-ins:

```sh
node tests/run-tests.js
```

Files:

- `index.html` — page structure (5 tabs)
- `styles.css` — styling
- `app.js` — all logic: parsing, project grouping, tree building, completeness check,
  recommendation approval flow, tree editing, CRUD diff, exports, localStorage persistence
