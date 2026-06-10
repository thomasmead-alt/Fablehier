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

Both accept either format (auto-detected, overridable):

| Format | Layout |
|---|---|
| Parent–child | Columns `Parent, Child[, Name]` (header optional; blank parent = root) |
| Level-based | One column per level (`Level1, Level2, …[, Name]`); a row states its node in the deepest filled column, empty leading columns inherit from the row above ("fill-down"), full-path rows also work |

IDs are matched across files case-insensitively, and leading zeros on numeric IDs are
ignored (`0000410100` ≡ `410100`). Multiple parents and cycles are rejected with warnings.

### 4 · Completeness & assign
Select which project the target file represents. The app then checks the target file for
completeness:

- **Missing** — cost centres of the project that are *not* in the target file, highlighted
  in red. Because the hierarchy is organisational, the app suggests a parent node for each
  one using the **person responsible** from KS13: nodes already holding that person's other
  cost centres score highest, with the cost centre's former as-is neighbours as a secondary
  signal. Accept the suggestion or pick any node, then *Assign*.
- **Extras** — cost centres in the target file that belong to a different project (or to no
  project), flagged for review.
- **Unknown entries** — leaf entries in the target file that don't exist in KS13 at all
  (typos, retired cost centres or empty groups).
- **As-is vs to-be comparison** — where each project cost centre sits today versus in the
  target, including moves and session assignments.

Exports (CSV, Excel-friendly): the updated hierarchy as **parent–child** or **level-based**
(with session assignments marked `added`), and a **completeness report** listing every cost
centre with its status (`OK` / `MISSING` / `ASSIGNED` / `EXTRA` / `UNKNOWN`).

## Try it with the sample files

In `samples/`:

1. `sample_ks13.txt` — KS13 export (SAP pipe format), 14 cost centres.
2. Create a project *Engineering* and assign profit centres `P-ENG-01` and `P-ENG-02` to it.
3. `current_levels.csv` — as-is hierarchy (level-based).
4. `target_parent_child.csv` — to-be hierarchy for the Engineering project, deliberately
   missing `0000410150` and `0000420260`. The check flags both; the responsible-person
   suggestions place them under `ENG-PLATFORM` (Anna Mueller) and `ENG-DATA` (Ben Oduya).

## Development

The app itself has zero dependencies. The parsing/matching logic has a smoke-test suite
that runs with nothing but Node built-ins:

```sh
node tests/run-tests.js
```

Files:

- `index.html` — page structure (4 tabs)
- `styles.css` — styling
- `app.js` — all logic: parsing, project grouping, tree building, completeness check,
  suggestions, exports, localStorage persistence
