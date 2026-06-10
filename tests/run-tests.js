'use strict';
/* Smoke tests for the parsing / matching logic. Run with: node tests/run-tests.js
 * Uses only node built-ins; the app itself has no dependencies. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = require('../app.js');
const {
  normKey, parseDelimited, parseKS13, buildCostCentres, detectFormat,
  buildParentChild, buildLevel, classifyTree, computeCheck, computeSuggestions,
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

/* ---------- completeness ---------- */
const ctx = {
  costCentres,
  projects: [{ id: 1, name: 'Engineering' }, { id: 2, name: 'Sales' }],
  pcProject: { 'P-ENG-01': 1, 'P-ENG-02': 1, 'P-SAL-01': 2 },
  targetProjectId: 1,
  hier: { current, target },
  assignments: {},
};
const chk = computeCheck(ctx);
test('completeness check finds the missing cost centres', () => {
  assert.strictEqual(chk.projectCCs.length, 9);
  assert.deepStrictEqual(chk.missing.map(c => c.key).sort(), ['410150', '420260']);
  assert.strictEqual(chk.covered.length, 7);
  assert.deepStrictEqual(chk.extras, []);
  assert.deepStrictEqual(chk.unknownNodes, []);
});

test('person responsible drives the suggestion', () => {
  const s1 = computeSuggestions('410150', ctx);
  assert.strictEqual(s1[0].id, 'ENG-PLATFORM'); // ANNA MUELLER's other CCs sit there
  assert.strictEqual(s1[0].direct, 3);
  assert.strictEqual(s1[0].sib, 3);             // former as-is neighbours moved there too
  const s2 = computeSuggestions('420260', ctx);
  assert.strictEqual(s2[0].id, 'ENG-DATA');     // BEN ODUYA's other CCs
});

test('assignment resolves the missing entry', () => {
  const ctx2 = { ...ctx, assignments: { '410150': 'ENG-PLATFORM' } };
  const chk2 = computeCheck(ctx2);
  assert.deepStrictEqual(chk2.missing.map(c => c.key), ['420260']);
  assert.deepStrictEqual(chk2.assigned.map(c => c.key), ['410150']);
  // assignments of same responsible reinforce later suggestions
  const s = computeSuggestions('420260', ctx2);
  assert.strictEqual(s[0].id, 'ENG-DATA');
});

test('cost centres of other projects in the target file are flagged as extras', () => {
  const t2 = buildParentChild(parseDelimited(
    'Parent,Child\n,ROOT\nROOT,G1\nG1,0000410100\nG1,0000510100\nG1,XX-TYPO'));
  classifyTree(t2, costCentres);
  const chk3 = computeCheck({ ...ctx, hier: { current, target: t2 } });
  assert.deepStrictEqual(chk3.extras, ['510100']);     // belongs to Sales project
  assert.deepStrictEqual(chk3.unknownNodes, ['XX-TYPO']); // not in KS13 at all
});

test('cycle and duplicate-parent rows are rejected with warnings', () => {
  const t = buildParentChild(parseDelimited('Parent,Child\nA,B\nB,C\nC,A\nA,C'));
  assert.ok(t.warnings.length >= 2);
  assert.deepStrictEqual(t.roots, ['A']);
});

console.log(`\n${passed} tests passed`);
