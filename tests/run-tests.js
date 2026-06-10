'use strict';
/* Smoke tests for the parsing / matching / editing logic. Run with: node tests/run-tests.js
 * Uses only node built-ins; the app itself has no dependencies. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = require('../app.js');
const {
  normKey, parseDelimited, parseKS13, buildCostCentres, detectFormat,
  buildParentChild, buildLevel, classifyTree, computeCheck, computeSuggestions,
  deepCopyTree, isInSubtree, moveNode, renameNode, addGroup, deleteNodePromote,
  removeCCNode, approveRec, undoApproval, rejectRec, reconsiderRec, diffChanges,
} = app;

const sample = f => fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

/* ---------- normKey ---------- */
test('normKey strips leading zeros on numeric ids only', () => {
  assert.strictEqual(normKey('0000410100'), '410100');
  assert.strictEqual(normKey(' p-eng-01 '), 'P-ENG-01');
  assert.strictEqual(normKey('0000'), '0');
});

/* ---------- KS13 parsing ---------- */
const ks13 = parseKS13(sample('sample_ks13.txt'));
test('KS13: header and rows detected in SAP pipe format', () => {
  assert.ok(ks13);
  assert.strictEqual(ks13.headers[0], 'Cost Center');
  assert.strictEqual(ks13.rows.length, 14);
});
test('KS13: column mapping guessed', () => {
  assert.strictEqual(ks13.headers[ks13.mapping.cc], 'Cost Center');
  assert.strictEqual(ks13.headers[ks13.mapping.name], 'Cost Center Name');
  assert.strictEqual(ks13.headers[ks13.mapping.responsible], 'Person Responsible');
  assert.strictEqual(ks13.headers[ks13.mapping.profitCentre], 'Profit Center');
});
const { costCentres, duplicates } = buildCostCentres(ks13.headers, ks13.rows, ks13.mapping);
test('KS13: cost centres built', () => {
  assert.strictEqual(Object.keys(costCentres).length, 14);
  assert.strictEqual(duplicates, 0);
  assert.strictEqual(costCentres['410150'].responsible, 'ANNA MUELLER');
  assert.strictEqual(costCentres['410150'].pcKey, 'P-ENG-01');
});

/* ---------- hierarchy parsing ---------- */
const tgtRows = parseDelimited(sample('target_parent_child.csv'));
test('format detection', () => {
  assert.strictEqual(detectFormat(tgtRows), 'parent-child');
  assert.strictEqual(detectFormat(parseDelimited(sample('current_levels.csv'))), 'level');
});

const target = buildParentChild(tgtRows);
classifyTree(target, costCentres);
test('parent-child tree built', () => {
  assert.deepStrictEqual(target.roots, ['ENG-ROOT']);
  assert.strictEqual(target.nodes['ENG-ROOT'].children.length, 3);
  assert.strictEqual(target.nodes['410100'].parent, 'ENG-PLATFORM');
  assert.strictEqual(target.nodes['410100'].type, 'cc');
  assert.strictEqual(target.nodes['ENG-PLATFORM'].type, 'group');
  assert.strictEqual(target.warnings.length, 0);
});

const current = buildLevel(parseDelimited(sample('current_levels.csv')));
classifyTree(current, costCentres);
test('level tree built with fill-down', () => {
  assert.deepStrictEqual(current.roots, ['CORP']);
  assert.strictEqual(current.nodes['410150'].parent, 'ENG-DEV');
  assert.strictEqual(current.nodes['510100'].parent, 'SALES-OLD');
  assert.strictEqual(current.nodes['ENG-OLD'].parent, 'CORP');
  assert.strictEqual(current.warnings.length, 0);
});

/* ---------- completeness with working copy ---------- */
function makeCtx() {
  return {
    costCentres,
    projects: [{ id: 1, name: 'Engineering' }, { id: 2, name: 'Sales' }],
    pcProject: { 'P-ENG-01': 1, 'P-ENG-02': 1, 'P-SAL-01': 2 },
    targetProjectId: 1,
    hier: { current, target },
    work: deepCopyTree(target),
    recs: {},
  };
}

const ctx = makeCtx();
const chk = computeCheck(ctx);
test('completeness check finds the missing cost centres', () => {
  assert.strictEqual(chk.projectCCs.length, 9);
  assert.deepStrictEqual(chk.missing.map(c => c.key).sort(), ['410150', '420260']);
  assert.strictEqual(chk.covered.length, 7);
  assert.deepStrictEqual(chk.extras, []);
  assert.deepStrictEqual(chk.unknownNodes, []);
});

test('person responsible drives the recommendation', () => {
  const s1 = computeSuggestions('410150', ctx);
  assert.strictEqual(s1[0].id, 'ENG-PLATFORM'); // ANNA MUELLER's other CCs sit there
  assert.strictEqual(s1[0].direct, 3);
  assert.strictEqual(s1[0].sib, 3);             // former as-is neighbours moved there too
  const s2 = computeSuggestions('420260', ctx);
  assert.strictEqual(s2[0].id, 'ENG-DATA');     // BEN ODUYA's other CCs
});

/* ---------- approval flow ---------- */
test('approve inserts the cost centre into the working tree', () => {
  const c = makeCtx();
  const res = approveRec('410150', 'ENG-PLATFORM', false, c);
  assert.ok(res.ok);
  assert.strictEqual(c.work.nodes['410150'].parent, 'ENG-PLATFORM');
  assert.ok(c.work.nodes['ENG-PLATFORM'].children.includes('410150'));
  const chk2 = computeCheck(c);
  assert.deepStrictEqual(chk2.missing.map(x => x.key), ['420260']);
  assert.deepStrictEqual(chk2.added.map(x => x.key), ['410150']);
  // approved placement reinforces the next recommendation (4 matching CCs now)
  classifyTree(c.work, costCentres);
  const s = computeSuggestions('420260', c);
  assert.strictEqual(s[0].id, 'ENG-DATA');
});

test('reject keeps the cost centre missing but reviewed; reconsider reverts', () => {
  const c = makeCtx();
  rejectRec('420260', c);
  let chk2 = computeCheck(c);
  assert.deepStrictEqual(chk2.missing.map(x => x.key), ['410150']);
  assert.deepStrictEqual(chk2.rejected.map(x => x.key), ['420260']);
  reconsiderRec('420260', c);
  chk2 = computeCheck(c);
  assert.deepStrictEqual(chk2.missing.map(x => x.key).sort(), ['410150', '420260']);
});

test('undo approval returns the cost centre to the missing list', () => {
  const c = makeCtx();
  approveRec('410150', 'ENG-PLATFORM', true, c);
  undoApproval('410150', c);
  assert.ok(!c.work.nodes['410150']);
  const chk2 = computeCheck(c);
  assert.deepStrictEqual(chk2.missing.map(x => x.key).sort(), ['410150', '420260']);
});

/* ---------- tree editing ---------- */
test('moveNode moves a node and rejects cycles and cc parents', () => {
  const w = deepCopyTree(target);
  classifyTree(w, costCentres);
  assert.ok(moveNode(w, '420300', 'ENG-DATA').ok);
  assert.strictEqual(w.nodes['420300'].parent, 'ENG-DATA');
  assert.ok(!w.nodes['ENG-QUALITY'].children.includes('420300'));
  assert.ok(w.nodes['ENG-DATA'].children.includes('420300'));
  // cycle: ENG-ROOT under its own descendant
  assert.strictEqual(moveNode(w, 'ENG-ROOT', 'ENG-DATA').ok, false);
  // cost centre cannot be a parent
  assert.strictEqual(moveNode(w, '420210', '410100').ok, false);
  // move to root
  assert.ok(moveNode(w, 'ENG-QUALITY', null).ok);
  assert.ok(w.roots.includes('ENG-QUALITY'));
  assert.strictEqual(w.nodes['ENG-QUALITY'].parent, null);
});

test('addGroup / renameNode / deleteNodePromote / removeCCNode', () => {
  const w = deepCopyTree(target);
  classifyTree(w, costCentres);
  assert.strictEqual(addGroup(w, 'ENG-ROOT', 'ENG-PLATFORM', 'dup').ok, false);
  const res = addGroup(w, 'ENG-ROOT', 'ENG-OPS', 'Operations');
  assert.ok(res.ok);
  assert.strictEqual(w.nodes['ENG-OPS'].parent, 'ENG-ROOT');
  assert.strictEqual(w.nodes['ENG-OPS'].type, 'group');
  renameNode(w, 'ENG-OPS', 'Ops Organisation');
  assert.strictEqual(w.nodes['ENG-OPS'].name, 'Ops Organisation');
  // delete a group: children move up one level, keeping position
  const del = deleteNodePromote(w, 'ENG-PLATFORM');
  assert.deepStrictEqual(del.promoted, ['410100', '410110', '410120']);
  assert.strictEqual(w.nodes['410100'].parent, 'ENG-ROOT');
  assert.ok(w.nodes['ENG-ROOT'].children.includes('410110'));
  assert.ok(!w.nodes['ENG-PLATFORM']);
  // remove a cost centre entirely
  removeCCNode(w, '420200');
  assert.ok(!w.nodes['420200']);
  assert.ok(!w.nodes['ENG-DATA'].children.includes('420200'));
});

test('isInSubtree', () => {
  assert.strictEqual(isInSubtree(target, 'ENG-ROOT', '410100'), true);
  assert.strictEqual(isInSubtree(target, 'ENG-DATA', '410100'), false);
});

/* ---------- CRUD diff ---------- */
test('diffChanges lists node and cost centre CRUD against the uploaded file', () => {
  const c = makeCtx();
  const w = c.work;
  classifyTree(w, costCentres);
  approveRec('410150', 'ENG-PLATFORM', false, c);            // CC ADD
  moveNode(w, '420300', 'ENG-DATA');                          // CC MOVE
  removeCCNode(w, '430310');                                  // CC REMOVE
  addGroup(w, 'ENG-ROOT', 'ENG-OPS', 'Operations');           // node CREATE
  renameNode(w, 'ENG-DATA', 'Data & AI Organisation');        // node RENAME
  moveNode(w, 'ENG-QUALITY', 'ENG-OPS');                      // node MOVE
  const { nodeChanges, ccChanges } = diffChanges(target, w, costCentres);

  const byAction = list => list.reduce((m, x) => ((m[x.action] = m[x.action] || []).push(x), m), {});
  const nc = byAction(nodeChanges);
  assert.strictEqual(nc.CREATE.length, 1);
  assert.strictEqual(nc.CREATE[0].label, 'ENG-OPS');
  assert.strictEqual(nc.CREATE[0].newParent, 'ENG-ROOT');
  assert.strictEqual(nc.RENAME[0].label, 'ENG-DATA');
  assert.strictEqual(nc.RENAME[0].oldName, 'Data Organisation');
  assert.strictEqual(nc.RENAME[0].newName, 'Data & AI Organisation');
  assert.strictEqual(nc.MOVE[0].label, 'ENG-QUALITY');
  assert.strictEqual(nc.MOVE[0].oldParent, 'ENG-ROOT');
  assert.strictEqual(nc.MOVE[0].newParent, 'ENG-OPS');
  assert.strictEqual(nodeChanges.length, 3);

  const cch = byAction(ccChanges);
  assert.strictEqual(cch.ADD.length, 1);
  assert.strictEqual(cch.ADD[0].cc.key, '410150');
  assert.strictEqual(cch.ADD[0].newParent, 'ENG-PLATFORM');
  assert.strictEqual(cch.MOVE.length, 1);
  assert.strictEqual(cch.MOVE[0].cc.key, '420300');
  assert.strictEqual(cch.MOVE[0].oldParent, 'ENG-QUALITY');
  assert.strictEqual(cch.MOVE[0].newParent, 'ENG-DATA');
  assert.strictEqual(cch.REMOVE.length, 1);
  assert.strictEqual(cch.REMOVE[0].cc.key, '430310');
  assert.strictEqual(ccChanges.length, 3);
  // ADD rows come first so downstream tooling can apply changes in order
  assert.strictEqual(ccChanges[0].action, 'ADD');
});

test('diffChanges reports no changes for an untouched working copy', () => {
  const { nodeChanges, ccChanges } = diffChanges(target, deepCopyTree(target), costCentres);
  assert.strictEqual(nodeChanges.length, 0);
  assert.strictEqual(ccChanges.length, 0);
});

console.log(`\n${passed} tests passed`);
