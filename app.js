'use strict';
/*
 * Cost Centre Hierarchy Builder
 * Plain JavaScript, no libraries. All processing happens in the browser;
 * state is persisted to localStorage only.
 */

/* ============================================================ state */

const STORAGE_KEY = 'cc-hier-builder.v1';

const state = {
  ks13FileName: '',
  headers: [],
  rows: [],                 // KS13 data rows (arrays of strings)
  mapping: { cc: -1, name: -1, responsible: -1, profitCentre: -1 },
  costCentres: {},          // normKey -> {key,id,name,responsible,profitCentre,pcKey}
  duplicates: 0,
  projects: [],             // {id, name}
  nextProjectId: 1,
  pcProject: {},            // profit-centre normKey -> projectId
  hier: { current: null, target: null }, // {nodes, roots, warnings, format, fileName}
  hierFormatChoice: { current: 'auto', target: 'auto' },
  targetProjectId: null,
  assignments: {},          // cost-centre normKey -> target group node id
};

/* ============================================================ utilities */

function $(sel) { return document.querySelector(sel); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Normalised key used for matching ids across files: trimmed, upper-cased,
 * and with leading zeros stripped for purely numeric ids (SAP pads cost
 * centres with zeros in some exports and not in others). */
function normKey(s) {
  let k = String(s == null ? '' : s).trim().toUpperCase();
  if (/^\d+$/.test(k)) k = k.replace(/^0+/, '') || '0';
  return k;
}

function normResp(s) {
  return String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');
}

function download(fileName, text) {
  // prefix a UTF-8 BOM so Excel opens the CSV correctly
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function toCSV(rows) {
  return rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

/* ============================================================ file parsing */

/* Split one line of comma/semicolon CSV honouring double quotes. */
function splitQuoted(line, delim) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/*
 * Parse a delimited text file into rows of trimmed cells.
 * Handles: tab-separated, CSV (comma/semicolon), and SAP pipe-framed list
 * output (|cell|cell|), skipping ----- separator lines and title lines.
 */
function parseDelimited(text) {
  const lines = String(text).split(/\r\n?|\n/)
    .filter(l => l.trim() && !/^[\s|+\-=_.]*$/.test(l));
  if (!lines.length) return [];

  const counts = { '\t': 0, '|': 0, ';': 0, ',': 0 };
  for (const l of lines.slice(0, 25)) {
    for (const d of Object.keys(counts)) counts[d] += l.split(d).length - 1;
  }
  let delim = null, best = 0;
  for (const d of ['\t', '|', ';', ',']) {
    if (counts[d] > best) { best = counts[d]; delim = d; }
  }

  const rows = lines.map(l => {
    if (delim === '|') {
      let s = l.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map(c => c.trim());
    }
    if (delim === ',' || delim === ';') return splitQuoted(l, delim).map(c => c.trim());
    if (delim === '\t') return l.split('\t').map(c => c.trim());
    return [l.trim()];
  });

  // Modal column count -> drop title/footer lines, pad short rows.
  const freq = {};
  rows.forEach(r => { freq[r.length] = (freq[r.length] || 0) + 1; });
  let modal = 1, mf = 0;
  for (const k in freq) {
    const n = +k;
    if (freq[k] > mf || (freq[k] === mf && n > modal)) { mf = freq[k]; modal = n; }
  }
  const out = [];
  for (const r of rows) {
    if (modal > 1 && r.length === 1 && /[ :]/.test(r[0])) continue; // title line
    while (r.length < modal) r.push('');
    out.push(r);
  }
  return out;
}

/* ============================================================ KS13 */

function guessMapping(headers) {
  const find = (patterns, exclude) => {
    for (const re of patterns) {
      for (let i = 0; i < headers.length; i++) {
        const h = String(headers[i]).toLowerCase();
        if (exclude && exclude.test(h)) continue;
        if (re.test(h)) return i;
      }
    }
    return -1;
  };
  const m = { cc: -1, name: -1, responsible: -1, profitCentre: -1 };
  m.cc = find(
    [/^cost\s*cent(er|re)$/, /^cost\s*ctr/, /^cctr/, /kostenstelle/, /cost\s*cent/],
    /name|desc|categ|group|respons|hier/);
  m.responsible = find([/person\s*respons/, /respons/, /verantw/, /in\s*charge/]);
  m.profitCentre = find([/^profit\s*cent(er|re)$/, /profit\s*ctr/, /prctr/, /profit/]);
  const taken = new Set([m.cc, m.responsible, m.profitCentre]);
  m.name = -1;
  for (const re of [/cost\s*cent.*(name|desc)/, /^(name|description|desc|short text)$/, /bezeich/, /name|desc|text/]) {
    for (let i = 0; i < headers.length; i++) {
      if (taken.has(i)) continue;
      if (re.test(String(headers[i]).toLowerCase())) { m.name = i; break; }
    }
    if (m.name >= 0) break;
  }
  return m;
}

/* Parse the KS13 text into {headers, rows, mapping}. */
function parseKS13(text) {
  const all = parseDelimited(text);
  if (!all.length) return null;
  let hi = all.findIndex(r => r.some(c => /cost\s*cent|kostenstelle/i.test(c)));
  if (hi < 0) hi = 0;
  const headers = all[hi];
  const headerJoined = headers.join('');
  const rows = all.slice(hi + 1).filter(r => r.join('') !== headerJoined);
  return { headers, rows, mapping: guessMapping(headers) };
}

function buildCostCentres(headers, rows, mapping) {
  const costCentres = {};
  let duplicates = 0;
  if (mapping.cc < 0) return { costCentres, duplicates };
  for (const r of rows) {
    const id = (r[mapping.cc] || '').trim();
    if (!id) continue;
    const key = normKey(id);
    if (costCentres[key]) { duplicates++; continue; }
    const pc = mapping.profitCentre >= 0 ? (r[mapping.profitCentre] || '').trim() : '';
    costCentres[key] = {
      key,
      id,
      name: mapping.name >= 0 ? (r[mapping.name] || '').trim() : '',
      responsible: mapping.responsible >= 0 ? (r[mapping.responsible] || '').trim() : '',
      profitCentre: pc,
      pcKey: normKey(pc),
    };
  }
  return { costCentres, duplicates };
}

function rebuildCostCentres() {
  const { costCentres, duplicates } = buildCostCentres(state.headers, state.rows, state.mapping);
  state.costCentres = costCentres;
  state.duplicates = duplicates;
  if (state.hier.current) classifyTree(state.hier.current, costCentres);
  if (state.hier.target) classifyTree(state.hier.target, costCentres);
}

/* ============================================================ hierarchy files */

function detectFormat(rows) {
  if (!rows.length) return 'level';
  const h = rows[0].map(c => String(c).toLowerCase());
  if (h.some(c => /parent|superior/.test(c)) &&
      h.some(c => /child|node|member|object|cost/.test(c))) return 'parent-child';
  if (h.some(c => /level|stufe|^l\s*[0-9]/.test(c))) return 'level';
  if (rows[0].length >= 2) {
    // parent-child if values of column 1 reappear in column 0
    const col0 = new Set(), col1 = new Set();
    for (const r of rows.slice(0, 200)) {
      if (r[0]) col0.add(normKey(r[0]));
      if (r[1]) col1.add(normKey(r[1]));
    }
    let overlap = 0;
    for (const v of col1) if (col0.has(v)) overlap++;
    if (overlap > 0) return 'parent-child';
  }
  return 'level';
}

function makeNode(nodes, order, rawId) {
  const k = normKey(rawId);
  if (!nodes[k]) {
    nodes[k] = { id: k, label: String(rawId).trim(), name: '', children: [], parent: null, type: 'unknown' };
    order.push(k);
  }
  return nodes[k];
}

function buildParentChild(rows) {
  const warnings = [];
  let start = 0, pIdx = 0, cIdx = 1, nIdx = -1;
  if (rows.length) {
    const h = rows[0].map(c => String(c).toLowerCase());
    if (h.some(c => /parent|superior/.test(c))) {
      pIdx = h.findIndex(c => /parent|superior/.test(c));
      cIdx = h.findIndex((c, i) => i !== pIdx && /child|node|member|object|cost/.test(c));
      if (cIdx < 0) cIdx = pIdx === 0 ? 1 : 0;
      nIdx = h.findIndex((c, i) => i !== pIdx && i !== cIdx && /name|desc|text/.test(c));
      start = 1;
    }
  }
  const nodes = {}, order = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const childRaw = (r[cIdx] || '').trim();
    if (!childRaw) continue;
    const child = makeNode(nodes, order, childRaw);
    if (nIdx >= 0 && (r[nIdx] || '').trim() && !child.name) child.name = r[nIdx].trim();
    const parentRaw = (r[pIdx] || '').trim();
    if (!parentRaw) continue;
    const parent = makeNode(nodes, order, parentRaw);
    if (child.parent && child.parent !== parent.id) {
      warnings.push(`Row ${i + 1}: "${childRaw}" already has parent "${nodes[child.parent].label}" — extra parent "${parentRaw}" ignored.`);
      continue;
    }
    if (child.parent === parent.id) continue;
    // cycle guard
    let cur = parent.id, cyc = false;
    const seen = new Set([child.id]);
    while (cur) {
      if (seen.has(cur)) { cyc = true; break; }
      seen.add(cur);
      cur = nodes[cur] ? nodes[cur].parent : null;
    }
    if (cyc) { warnings.push(`Row ${i + 1}: linking "${childRaw}" under "${parentRaw}" would create a cycle — ignored.`); continue; }
    child.parent = parent.id;
    parent.children.push(child.id);
  }
  const roots = order.filter(k => !nodes[k].parent);
  return { nodes, roots, warnings, format: 'parent-child' };
}

/*
 * Level-based file: each column is a hierarchy level. A row states the node
 * in its deepest filled column; empty leading columns inherit from the row
 * above (classic "fill-down" layout). Full-path rows also work.
 */
function buildLevel(rows) {
  const warnings = [];
  let start = 0, nameIdx = -1;
  if (rows.length) {
    const h = rows[0].map(c => String(c).toLowerCase());
    const looksHeader = h.some(c => /level|stufe|^l\s*[0-9]/.test(c));
    if (looksHeader) {
      start = 1;
      nameIdx = h.findIndex(c => /name|desc|text/.test(c));
    }
  }
  const width = rows.length ? rows[0].length : 0;
  const levelCols = [];
  for (let i = 0; i < width; i++) if (i !== nameIdx) levelCols.push(i);

  const nodes = {}, order = [], roots = [];
  let path = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    let deepest = -1;
    const vals = {};
    levelCols.forEach((ci, d) => {
      const v = (r[ci] || '').trim();
      if (v) { vals[d] = v; deepest = d; }
    });
    if (deepest < 0) continue;
    for (let d = 0; d <= deepest; d++) if (vals[d] !== undefined) path[d] = vals[d];
    path.length = deepest + 1;
    if (path.some(p => p === undefined)) {
      warnings.push(`Row ${i + 1}: level ${deepest + 1} entry has no ancestor at a higher level — skipped.`);
      path = [];
      continue;
    }
    let parent = null;
    for (let d = 0; d <= deepest; d++) {
      const n = makeNode(nodes, order, path[d]);
      if (parent) {
        if (!n.parent) { n.parent = parent.id; parent.children.push(n.id); }
        else if (n.parent !== parent.id) {
          warnings.push(`Row ${i + 1}: "${path[d]}" appears under both "${nodes[n.parent].label}" and "${parent.label}" — first position kept.`);
        }
      } else if (!n.parent && !roots.includes(n.id)) {
        roots.push(n.id);
      }
      parent = n;
    }
    if (nameIdx >= 0 && (r[nameIdx] || '').trim() && parent && !parent.name) {
      parent.name = r[nameIdx].trim();
    }
  }
  return { nodes, roots, warnings, format: 'level' };
}

function parseHierarchy(text, formatChoice) {
  const rows = parseDelimited(text);
  if (!rows.length) return null;
  const format = (formatChoice && formatChoice !== 'auto') ? formatChoice : detectFormat(rows);
  const tree = format === 'parent-child' ? buildParentChild(rows) : buildLevel(rows);
  classifyTree(tree, state.costCentres);
  return tree;
}

/* Mark each node as a cost centre (leaf that exists in KS13), a group, or unknown. */
function classifyTree(tree, costCentres) {
  for (const k in tree.nodes) {
    const n = tree.nodes[k];
    if (costCentres[k] && !n.children.length) {
      n.type = 'cc';
      if (!n.name) n.name = costCentres[k].name;
    } else if (n.children.length) {
      n.type = 'group';
    } else {
      n.type = 'unknown';
    }
  }
}

/* All nodes usable as a parent when assigning (any node that is not a cost centre). */
function groupOptions(tree) {
  const out = [];
  const walk = (id, depth) => {
    const n = tree.nodes[id];
    if (n.type !== 'cc') {
      out.push({ id, depth, label: n.label + (n.name ? ' — ' + n.name : '') });
      n.children.forEach(c => walk(c, depth + 1));
    }
  };
  tree.roots.forEach(r => walk(r, 0));
  return out;
}

/* ============================================================ completeness */

function computeCheck(ctx) {
  const s = ctx || state;
  const proj = s.projects.find(p => p.id === s.targetProjectId) || null;
  const projectCCs = [];
  if (proj) {
    for (const k in s.costCentres) {
      if (s.pcProject[s.costCentres[k].pcKey] === proj.id) projectCCs.push(s.costCentres[k]);
    }
  }
  projectCCs.sort((a, b) => a.id.localeCompare(b.id));

  const target = s.hier.target;
  const present = new Set();
  const extras = [];        // cc keys in the target file that are not in the project
  const unknownNodes = [];  // leaf node ids in the target file not found in KS13
  if (target) {
    for (const k in target.nodes) {
      const n = target.nodes[k];
      if (s.costCentres[k]) {
        present.add(k);
        if (!proj || s.pcProject[s.costCentres[k].pcKey] !== proj.id) extras.push(k);
      } else if (!n.children.length) {
        unknownNodes.push(k);
      }
    }
  }
  const missing = projectCCs.filter(cc => !present.has(cc.key) && !s.assignments[cc.key]);
  const assigned = projectCCs.filter(cc => !present.has(cc.key) && s.assignments[cc.key]);
  const covered = projectCCs.filter(cc => present.has(cc.key));
  return { proj, projectCCs, covered, missing, assigned, extras, unknownNodes };
}

/*
 * Suggest target parent nodes for a missing cost centre. The hierarchy is
 * organisational, so the strongest signal is the person responsible: parents
 * holding cost centres of the same responsible score highest. The as-is
 * hierarchy adds a secondary signal: parents where the cost centre's former
 * neighbours ended up.
 */
function computeSuggestions(ccKey, ctx) {
  const s = ctx || state;
  const target = s.hier.target;
  if (!target) return [];
  const me = s.costCentres[ccKey];
  const resp = me ? normResp(me.responsible) : '';
  const scores = {}; // nodeId -> {direct, anc, sib}
  const bump = (nodeId, field, by) => {
    if (!nodeId || !target.nodes[nodeId]) return;
    if (!scores[nodeId]) scores[nodeId] = { direct: 0, anc: 0, sib: 0 };
    scores[nodeId][field] += by || 1;
  };

  if (resp) {
    for (const k in target.nodes) {
      const n = target.nodes[k];
      if (n.type !== 'cc') continue;
      const info = s.costCentres[k];
      if (!info || normResp(info.responsible) !== resp) continue;
      bump(n.parent, 'direct');
      let p = n.parent ? target.nodes[n.parent].parent : null;
      while (p) { bump(p, 'anc'); p = target.nodes[p].parent; }
    }
    // cost centres already assigned in this session count too
    for (const k in s.assignments) {
      if (k === ccKey) continue;
      const info = s.costCentres[k];
      if (info && normResp(info.responsible) === resp) bump(s.assignments[k], 'direct');
    }
  }

  const current = s.hier.current;
  if (current && current.nodes[ccKey] && current.nodes[ccKey].parent) {
    for (const sib of current.nodes[current.nodes[ccKey].parent].children) {
      if (sib === ccKey) continue;
      const tn = target.nodes[sib];
      if (tn && tn.parent) bump(tn.parent, 'sib');
      else if (s.assignments[sib]) bump(s.assignments[sib], 'sib');
    }
  }

  return Object.keys(scores)
    .filter(id => target.nodes[id].type !== 'cc')
    .map(id => {
      const sc = scores[id];
      return { id, ...sc, score: sc.direct * 100 + sc.sib * 10 + sc.anc };
    })
    .sort((a, b) => b.score - a.score);
}

function suggestionReason(c) {
  const parts = [];
  if (c.direct) parts.push(`${c.direct} cost centre${c.direct > 1 ? 's' : ''} of the same person responsible`);
  if (c.sib) parts.push(`${c.sib} former as-is neighbour${c.sib > 1 ? 's' : ''}`);
  if (!parts.length && c.anc) parts.push('same person responsible deeper in this branch');
  return parts.join(', ');
}

/* ============================================================ exports */

function nodeDisplay(tree, id) {
  const n = tree.nodes[id];
  return n ? (n.label + (n.name ? ' — ' + n.name : '')) : id;
}

function exportParentChild() {
  const tree = state.hier.target;
  if (!tree) return;
  const rows = [['Parent', 'Child', 'Name', 'Type']];
  const typeOf = n => n.type === 'cc' ? 'Cost Centre' : (n.type === 'group' ? 'Group' : 'Unknown');
  const walk = (id, parentLabel) => {
    const n = tree.nodes[id];
    rows.push([parentLabel, n.label, n.name, typeOf(n)]);
    n.children.forEach(c => walk(c, n.label));
    for (const ccKey in state.assignments) {
      if (state.assignments[ccKey] === id) {
        const cc = state.costCentres[ccKey];
        if (cc) rows.push([n.label, cc.id, cc.name, 'Cost Centre (added)']);
      }
    }
  };
  tree.roots.forEach(r => walk(r, ''));
  download('hierarchy_parent_child.csv', toCSV(rows));
}

function exportLevels() {
  const tree = state.hier.target;
  if (!tree) return;
  const flat = []; // {path:[labels], name, responsible, note}
  const walk = (id, path) => {
    const n = tree.nodes[id];
    const p = path.concat(n.label);
    flat.push({ path: p, name: n.name, responsible: '', note: '' });
    n.children.forEach(c => walk(c, p));
    for (const ccKey in state.assignments) {
      if (state.assignments[ccKey] === id) {
        const cc = state.costCentres[ccKey];
        if (cc) flat.push({ path: p.concat(cc.id), name: cc.name, responsible: cc.responsible, note: 'added' });
      }
    }
  };
  tree.roots.forEach(r => walk(r, []));
  // fill responsible for cost-centre rows from KS13
  for (const f of flat) {
    const cc = state.costCentres[normKey(f.path[f.path.length - 1])];
    if (cc && !f.responsible) f.responsible = cc.responsible;
  }
  const depth = Math.max(...flat.map(f => f.path.length), 1);
  const header = [];
  for (let i = 1; i <= depth; i++) header.push('Level' + i);
  header.push('Name', 'Person Responsible', 'Note');
  const rows = [header];
  for (const f of flat) {
    const cells = [];
    for (let i = 0; i < depth; i++) cells.push(i === f.path.length - 1 ? f.path[i] : '');
    rows.push(cells.concat([f.name, f.responsible, f.note]));
  }
  download('hierarchy_levels.csv', toCSV(rows));
}

function exportReport() {
  const chk = computeCheck();
  const tree = state.hier.target;
  const rows = [['Status', 'Cost Centre', 'Name', 'Person Responsible', 'Profit Centre', 'Detail']];
  for (const cc of chk.missing) {
    const sug = computeSuggestions(cc.key)[0];
    rows.push(['MISSING', cc.id, cc.name, cc.responsible, cc.profitCentre,
      sug ? 'Suggested parent: ' + nodeDisplay(tree, sug.id) : 'No suggestion']);
  }
  for (const cc of chk.assigned) {
    rows.push(['ASSIGNED', cc.id, cc.name, cc.responsible, cc.profitCentre,
      'Assigned to: ' + nodeDisplay(tree, state.assignments[cc.key])]);
  }
  for (const cc of chk.covered) {
    rows.push(['OK', cc.id, cc.name, cc.responsible, cc.profitCentre,
      'Parent: ' + (tree.nodes[cc.key].parent ? nodeDisplay(tree, tree.nodes[cc.key].parent) : '(root)')]);
  }
  for (const k of chk.extras) {
    const cc = state.costCentres[k];
    const pn = state.projects.find(p => p.id === state.pcProject[cc.pcKey]);
    rows.push(['EXTRA', cc.id, cc.name, cc.responsible, cc.profitCentre,
      pn ? 'Belongs to project: ' + pn.name : 'Profit centre not assigned to any project']);
  }
  for (const k of chk.unknownNodes) {
    rows.push(['UNKNOWN', tree.nodes[k].label, tree.nodes[k].name, '', '',
      'Leaf in target file but not found in KS13']);
  }
  download('completeness_report.csv', toCSV(rows));
}

/* ============================================================ persistence */

let saveTimer = null;
function scheduleSave() {
  if (typeof localStorage === 'undefined') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      const ind = $('#saveIndicator');
      if (ind) {
        ind.textContent = 'Saved locally ' + new Date().toLocaleTimeString();
      }
    } catch (e) { /* storage full or unavailable — app still works in-memory */ }
  }, 400);
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(state)) {
      if (saved[k] !== undefined) state[k] = saved[k];
    }
  } catch (e) { /* corrupt save — ignore */ }
}

/* ============================================================ rendering */

function changed() {
  scheduleSave();
  renderAll();
}

function renderAll() {
  renderKS13();
  renderProjects();
  renderHier('current');
  renderHier('target');
  renderCheck();
}

/* ---------- KS13 tab ---------- */

function renderKS13() {
  const has = state.headers.length > 0;
  $('#mappingCard').hidden = !has;
  $('#ks13DataCard').hidden = !has;
  if (!has) { $('#ks13Msg').textContent = ''; return; }

  $('#ks13Msg').textContent = `Loaded: ${state.ks13FileName} — ${state.rows.length} rows.`;

  // mapping selects
  const fields = [['mapCC', 'cc'], ['mapName', 'name'], ['mapResp', 'responsible'], ['mapPC', 'profitCentre']];
  for (const [selId, field] of fields) {
    const sel = $('#' + selId);
    sel.innerHTML = '<option value="-1">— not mapped —</option>' +
      state.headers.map((h, i) => `<option value="${i}">${esc(h || '(column ' + (i + 1) + ')')}</option>`).join('');
    sel.value = String(state.mapping[field]);
  }

  // stats
  const pcs = new Set(), resps = new Set();
  for (const k in state.costCentres) {
    const cc = state.costCentres[k];
    if (cc.pcKey) pcs.add(cc.pcKey);
    if (cc.responsible) resps.add(normResp(cc.responsible));
  }
  $('#ks13Stats').innerHTML =
    `<span class="chip">${Object.keys(state.costCentres).length} cost centres</span>` +
    `<span class="chip">${pcs.size} profit centres</span>` +
    `<span class="chip">${resps.size} persons responsible</span>` +
    (state.duplicates ? `<span class="chip amber">${state.duplicates} duplicate rows skipped</span>` : '');

  // table
  const q = ($('#ks13Search').value || '').toLowerCase();
  const mappedIdx = new Set(Object.values(state.mapping).filter(i => i >= 0));
  let html = '<thead><tr>' + state.headers.map((h, i) =>
    `<th class="${mappedIdx.has(i) ? 'mapped' : ''}">${esc(h)}</th>`).join('') + '</tr></thead><tbody>';
  let shown = 0;
  const LIMIT = 300;
  for (const r of state.rows) {
    if (q && !r.some(c => String(c).toLowerCase().includes(q))) continue;
    if (shown >= LIMIT) { shown++; continue; }
    html += '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>';
    shown++;
  }
  html += '</tbody>';
  $('#ks13Table').innerHTML = html;
  if (shown > LIMIT) {
    $('#ks13Table').insertAdjacentHTML('beforeend',
      `<tfoot><tr><td colspan="${state.headers.length}" class="muted">Showing first ${LIMIT} of ${shown} matching rows.</td></tr></tfoot>`);
  }
}

/* ---------- Projects tab ---------- */

function projectName(id) {
  const p = state.projects.find(p => p.id === id);
  return p ? p.name : null;
}

function pcSummary() {
  const map = {}; // pcKey -> {label, count, resps:Set}
  for (const k in state.costCentres) {
    const cc = state.costCentres[k];
    const key = cc.pcKey || '';
    if (!map[key]) map[key] = { key, label: cc.profitCentre || '(no profit centre)', count: 0, resps: new Set() };
    map[key].count++;
    if (cc.responsible) map[key].resps.add(cc.responsible);
  }
  return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
}

function renderProjects() {
  // project list
  const list = $('#projList');
  if (!state.projects.length) {
    list.innerHTML = '<p class="muted">No projects yet.</p>';
  } else {
    list.innerHTML = state.projects.map(p => {
      const pcs = Object.keys(state.pcProject).filter(k => state.pcProject[k] === p.id);
      let ccCount = 0;
      for (const k in state.costCentres) if (state.pcProject[state.costCentres[k].pcKey] === p.id) ccCount++;
      return `<div class="proj-item">
        <span><span class="name">${esc(p.name)}</span>
          <span class="muted">— ${pcs.length} profit centre${pcs.length === 1 ? '' : 's'}, ${ccCount} cost centre${ccCount === 1 ? '' : 's'}</span></span>
        <button class="small danger ghost" data-del-proj="${p.id}">Delete</button>
      </div>`;
    }).join('');
  }
  list.querySelectorAll('[data-del-proj]').forEach(btn => btn.addEventListener('click', () => {
    const id = +btn.dataset.delProj;
    state.projects = state.projects.filter(p => p.id !== id);
    for (const k in state.pcProject) if (state.pcProject[k] === id) delete state.pcProject[k];
    if (state.targetProjectId === id) state.targetProjectId = null;
    changed();
  }));

  // profit centre table
  const q = ($('#pcSearch').value || '').toLowerCase();
  const pcs = pcSummary().filter(pc => !q || pc.label.toLowerCase().includes(q));
  const opts = pid => '<option value="">— unassigned —</option>' +
    state.projects.map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#pcTable').innerHTML = '<thead><tr><th>Profit centre</th><th>Cost centres</th><th>Persons responsible</th><th>Project</th></tr></thead><tbody>' +
    (pcs.length ? pcs.map(pc => `<tr>
      <td class="mono">${esc(pc.label)}</td>
      <td>${pc.count}</td>
      <td class="muted">${esc([...pc.resps].slice(0, 3).join(', '))}${pc.resps.size > 3 ? '…' : ''}</td>
      <td><select data-pc="${esc(pc.key)}">${opts(state.pcProject[pc.key])}</select></td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="muted">Upload a KS13 file first.</td></tr>') + '</tbody>';
  $('#pcTable').querySelectorAll('select[data-pc]').forEach(sel => sel.addEventListener('change', () => {
    const key = sel.dataset.pc;
    if (sel.value) state.pcProject[key] = +sel.value;
    else delete state.pcProject[key];
    changed();
  }));
}

/* ---------- Hierarchy tab ---------- */

function ccCountUnder(tree, id, memo) {
  if (memo[id] !== undefined) return memo[id];
  const n = tree.nodes[id];
  let c = n.type === 'cc' ? 1 : 0;
  for (const ch of n.children) c += ccCountUnder(tree, ch, memo);
  memo[id] = c;
  return c;
}

function renderTree(container, tree, opts) {
  container.innerHTML = '';
  if (!tree) { container.innerHTML = '<p class="muted">No file loaded.</p>'; return; }
  opts = opts || {};
  const memo = {};
  const extraSet = opts.extraSet || new Set();
  const assignsByNode = {};
  if (opts.assignments) {
    for (const ccKey in opts.assignments) {
      (assignsByNode[opts.assignments[ccKey]] = assignsByNode[opts.assignments[ccKey]] || []).push(ccKey);
    }
  }

  const renderCCBits = (id, label, name, responsible, classes) => {
    const div = document.createElement('div');
    div.className = 'node ' + classes;
    div.innerHTML = `<span class="caret leaf">▾</span><span class="nid">${esc(label)}</span>` +
      (name ? `<span class="nname">${esc(name)}</span>` : '') +
      (responsible ? `<span class="nresp">${esc(responsible)}</span>` : '');
    return div;
  };

  const renderNode = id => {
    const n = tree.nodes[id];
    const li = document.createElement('li');
    const added = assignsByNode[id] || [];
    if (n.type === 'cc' || (n.type === 'unknown' && !added.length)) {
      const cc = state.costCentres[id];
      let cls = n.type;
      if (extraSet.has(id)) cls += ' extra';
      li.appendChild(renderCCBits(id, n.label, n.name, cc ? cc.responsible : '', cls));
      return li;
    }
    const row = document.createElement('div');
    row.className = 'node ' + n.type;
    const ccTotal = ccCountUnder(tree, id, memo) + added.length;
    row.innerHTML = `<span class="caret">▾</span><span class="nid">${esc(n.label)}</span>` +
      (n.name ? `<span class="nname">${esc(n.name)}</span>` : '') +
      `<span class="ncount">(${ccTotal} cc)</span>`;
    row.querySelector('.caret').addEventListener('click', () => li.classList.toggle('collapsed'));
    li.appendChild(row);
    const ul = document.createElement('ul');
    n.children.forEach(c => ul.appendChild(renderNode(c)));
    for (const ccKey of added) {
      const cc = state.costCentres[ccKey];
      const liA = document.createElement('li');
      liA.appendChild(renderCCBits(ccKey, cc ? cc.id : ccKey, cc ? cc.name : '', cc ? cc.responsible : '', 'cc added'));
      ul.appendChild(liA);
    }
    li.appendChild(ul);
    return li;
  };

  const ul = document.createElement('ul');
  ul.className = 'tree';
  tree.roots.forEach(r => ul.appendChild(renderNode(r)));
  container.appendChild(ul);
}

function renderHier(slot) {
  const tree = state.hier[slot];
  const info = $(slot === 'current' ? '#curInfo' : '#tgtInfo');
  const treeEl = $(slot === 'current' ? '#curTree' : '#tgtTree');
  $(slot === 'current' ? '#curFormat' : '#tgtFormat').value = state.hierFormatChoice[slot];
  if (!tree) { info.textContent = ''; renderTree(treeEl, null); return; }
  const total = Object.keys(tree.nodes).length;
  let ccs = 0;
  for (const k in tree.nodes) if (tree.nodes[k].type === 'cc') ccs++;
  let txt = `Loaded: ${tree.fileName || ''} — detected format: ${tree.format}, ${total} nodes (${ccs} cost centres matched to KS13).`;
  if (tree.warnings && tree.warnings.length) {
    txt += '\nWarnings:\n' + tree.warnings.slice(0, 8).map(w => '• ' + w).join('\n');
    if (tree.warnings.length > 8) txt += `\n• … and ${tree.warnings.length - 8} more`;
  }
  info.textContent = txt;
  renderTree(treeEl, tree);
}

/* ---------- Check tab ---------- */

function renderCheck() {
  // project select
  const sel = $('#checkProject');
  sel.innerHTML = '<option value="">— choose project —</option>' +
    state.projects.map(p => `<option value="${p.id}" ${p.id === state.targetProjectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  const hint = $('#checkHint');
  const cards = ['#missingCard', '#assignedCard', '#extraCard', '#updatedCard', '#compareCard'];

  const problems = [];
  if (!Object.keys(state.costCentres).length) problems.push('upload a KS13 file (tab 1)');
  if (!state.projects.length) problems.push('create a project and assign profit centres (tab 2)');
  if (!state.hier.target) problems.push('upload a target (to-be) hierarchy file (tab 3)');
  if (!problems.length && !state.targetProjectId) problems.push('choose above which project the target file represents');
  if (problems.length) {
    hint.textContent = 'To run the check: ' + problems.join('; ') + '.';
    $('#checkSummary').innerHTML = '';
    cards.forEach(c => { $(c).hidden = true; });
    return;
  }
  hint.textContent = '';

  const chk = computeCheck();
  const tree = state.hier.target;

  $('#checkSummary').innerHTML =
    `<span class="chip">${chk.projectCCs.length} cost centres in project</span>` +
    `<span class="chip green">${chk.covered.length} in target file</span>` +
    (chk.assigned.length ? `<span class="chip green">${chk.assigned.length} assigned now</span>` : '') +
    (chk.missing.length
      ? `<span class="chip red">${chk.missing.length} missing</span>`
      : `<span class="chip green">complete ✓</span>`) +
    (chk.extras.length ? `<span class="chip amber">${chk.extras.length} not in this project</span>` : '') +
    (chk.unknownNodes.length ? `<span class="chip amber">${chk.unknownNodes.length} unknown entries</span>` : '');

  /* missing table */
  $('#missingCard').hidden = chk.missing.length === 0;
  $('#missingCount').textContent = chk.missing.length;
  if (chk.missing.length) {
    const groups = groupOptions(tree);
    let html = '<thead><tr><th>Cost centre</th><th>Name</th><th>Person responsible</th><th>Profit centre</th><th>Suggestion</th><th>Assign to</th></tr></thead><tbody>';
    for (const cc of chk.missing) {
      const sugs = computeSuggestions(cc.key);
      const top = sugs[0];
      const optHtml = groups.map(g =>
        `<option value="${esc(g.id)}" ${top && g.id === top.id ? 'selected' : ''}>${'  '.repeat(g.depth)}${esc(g.label)}</option>`).join('');
      html += `<tr class="missing">
        <td class="mono">${esc(cc.id)}</td>
        <td>${esc(cc.name)}</td>
        <td>${esc(cc.responsible) || '<span class="muted">—</span>'}</td>
        <td class="mono">${esc(cc.profitCentre)}</td>
        <td class="suggestion">${top
          ? `<strong>${esc(nodeDisplay(tree, top.id))}</strong><br><span class="why">${esc(suggestionReason(top))}</span>`
          : '<span class="muted">no match for this person responsible</span>'}</td>
        <td><div class="inline-form">
          <select data-assign-sel="${esc(cc.key)}">${optHtml}</select>
          <button class="small" data-assign="${esc(cc.key)}">Assign</button>
        </div></td>
      </tr>`;
    }
    html += '</tbody>';
    $('#missingTable').innerHTML = html;
    $('#missingTable').querySelectorAll('[data-assign]').forEach(btn => btn.addEventListener('click', () => {
      const key = btn.dataset.assign;
      const selEl = $('#missingTable').querySelector(`[data-assign-sel="${CSS.escape(key)}"]`);
      if (selEl && selEl.value) {
        state.assignments[key] = selEl.value;
        changed();
      }
    }));
  }

  /* assigned table */
  $('#assignedCard').hidden = chk.assigned.length === 0;
  $('#assignedCount').textContent = chk.assigned.length;
  if (chk.assigned.length) {
    $('#assignedTable').innerHTML = '<thead><tr><th>Cost centre</th><th>Name</th><th>Person responsible</th><th>Assigned to</th><th></th></tr></thead><tbody>' +
      chk.assigned.map(cc => `<tr>
        <td class="mono">${esc(cc.id)}</td><td>${esc(cc.name)}</td><td>${esc(cc.responsible)}</td>
        <td>${esc(nodeDisplay(tree, state.assignments[cc.key]))}</td>
        <td><button class="small ghost danger" data-unassign="${esc(cc.key)}">Undo</button></td>
      </tr>`).join('') + '</tbody>';
    $('#assignedTable').querySelectorAll('[data-unassign]').forEach(btn => btn.addEventListener('click', () => {
      delete state.assignments[btn.dataset.unassign];
      changed();
    }));
  }

  /* extras / unknown */
  const hasReview = chk.extras.length || chk.unknownNodes.length;
  $('#extraCard').hidden = !hasReview;
  if (hasReview) {
    let html = '';
    if (chk.extras.length) {
      html += '<p class="hint">Cost centres that are in the target file but do <strong>not</strong> belong to the selected project (check whether they were included on purpose):</p>';
      html += '<div class="table-wrap"><table><thead><tr><th>Cost centre</th><th>Name</th><th>Profit centre</th><th>Belongs to project</th></tr></thead><tbody>' +
        chk.extras.map(k => {
          const cc = state.costCentres[k];
          return `<tr><td class="mono">${esc(cc.id)}</td><td>${esc(cc.name)}</td><td class="mono">${esc(cc.profitCentre)}</td>
            <td>${esc(projectName(state.pcProject[cc.pcKey]) || '') || '<span class="muted">unassigned profit centre</span>'}</td></tr>`;
        }).join('') + '</tbody></table></div>';
    }
    if (chk.unknownNodes.length) {
      html += '<p class="hint">Leaf entries in the target file that were <strong>not found in the KS13 file</strong> (possible typos, retired cost centres, or empty groups):</p>' +
        '<p class="mono">' + chk.unknownNodes.map(k => esc(state.hier.target.nodes[k].label)).join(', ') + '</p>';
    }
    $('#extraBody').innerHTML = html;
  }

  /* updated tree + exports */
  $('#updatedCard').hidden = false;
  renderTree($('#updatedTree'), tree, {
    assignments: state.assignments,
    extraSet: new Set(chk.extras),
  });

  /* comparison */
  const cur = state.hier.current;
  $('#compareCard').hidden = !cur;
  if (cur) {
    const parentOf = (t, key) => {
      const n = t.nodes[key];
      if (!n) return null;
      return n.parent ? nodeDisplay(t, n.parent) : '(root)';
    };
    let html = '<thead><tr><th>Cost centre</th><th>Name</th><th>Person responsible</th><th>As-is parent</th><th>To-be parent</th><th>Status</th></tr></thead><tbody>';
    for (const cc of chk.projectCCs) {
      const asIs = parentOf(cur, cc.key);
      let toBe = parentOf(tree, cc.key);
      let status;
      if (!toBe && state.assignments[cc.key]) {
        toBe = nodeDisplay(tree, state.assignments[cc.key]);
        status = '<span class="badge green">assigned</span>';
      } else if (!toBe) {
        status = '<span class="badge red">missing in to-be</span>';
      } else if (!asIs) {
        status = '<span class="badge grey">not in as-is file</span>';
      } else {
        const sameParent = cur.nodes[cc.key].parent && tree.nodes[cc.key].parent &&
          cur.nodes[cc.key].parent === tree.nodes[cc.key].parent;
        status = sameParent ? '<span class="badge grey">same parent</span>' : '<span class="badge green">moved</span>';
      }
      html += `<tr><td class="mono">${esc(cc.id)}</td><td>${esc(cc.name)}</td><td>${esc(cc.responsible)}</td>
        <td>${esc(asIs || '—')}</td><td>${esc(toBe || '—')}</td><td>${status}</td></tr>`;
    }
    html += '</tbody>';
    $('#compareTable').innerHTML = html;
  }
}

/* ============================================================ wiring */

function readFileSmart(file, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    let text = reader.result;
    if (text.includes('�')) {
      // utf-8 decode produced replacement chars — likely a latin-1 SAP export
      const r2 = new FileReader();
      r2.onload = () => {
        try { cb(new TextDecoder('iso-8859-1').decode(r2.result)); }
        catch (e) { cb(text); }
      };
      r2.readAsArrayBuffer(file);
      return;
    }
    cb(text);
  };
  reader.readAsText(file);
}

function bindDrop(cardEl, handler) {
  cardEl.addEventListener('dragover', e => { e.preventDefault(); cardEl.classList.add('dragover'); });
  cardEl.addEventListener('dragleave', () => cardEl.classList.remove('dragover'));
  cardEl.addEventListener('drop', e => {
    e.preventDefault();
    cardEl.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handler(f);
  });
}

function loadKS13File(file) {
  readFileSmart(file, text => {
    const parsed = parseKS13(text);
    if (!parsed || !parsed.rows.length) {
      $('#ks13Msg').textContent = 'Could not find any data rows in this file.';
      $('#ks13Msg').className = 'msg error';
      return;
    }
    $('#ks13Msg').className = 'msg';
    state.ks13FileName = file.name;
    state.headers = parsed.headers;
    state.rows = parsed.rows;
    state.mapping = parsed.mapping;
    rebuildCostCentres();
    changed();
  });
}

function loadHierFile(slot, file) {
  readFileSmart(file, text => {
    const tree = parseHierarchy(text, state.hierFormatChoice[slot]);
    if (!tree || !Object.keys(tree.nodes).length) {
      $(slot === 'current' ? '#curInfo' : '#tgtInfo').textContent = 'Could not parse any hierarchy rows from this file.';
      return;
    }
    tree.fileName = file.name;
    tree.sourceText = text; // kept so a format change can re-parse
    state.hier[slot] = tree;
    if (slot === 'target') state.assignments = {};
    changed();
  });
}

function init() {
  loadSaved();

  // tabs
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === btn.dataset.tab));
  }));

  // KS13
  $('#ks13File').addEventListener('change', e => { if (e.target.files[0]) loadKS13File(e.target.files[0]); });
  bindDrop($('#ks13Drop'), loadKS13File);
  $('#ks13Search').addEventListener('input', renderKS13);
  for (const [selId, field] of [['mapCC', 'cc'], ['mapName', 'name'], ['mapResp', 'responsible'], ['mapPC', 'profitCentre']]) {
    $('#' + selId).addEventListener('change', e => {
      state.mapping[field] = +e.target.value;
      rebuildCostCentres();
      changed();
    });
  }

  // projects
  const createProject = () => {
    const name = $('#projNewName').value.trim();
    if (!name) return;
    state.projects.push({ id: state.nextProjectId++, name });
    $('#projNewName').value = '';
    changed();
  };
  $('#projCreateBtn').addEventListener('click', createProject);
  $('#projNewName').addEventListener('keydown', e => { if (e.key === 'Enter') createProject(); });
  $('#pcSearch').addEventListener('input', renderProjects);

  // hierarchies
  $('#curFile').addEventListener('change', e => { if (e.target.files[0]) loadHierFile('current', e.target.files[0]); });
  $('#tgtFile').addEventListener('change', e => { if (e.target.files[0]) loadHierFile('target', e.target.files[0]); });
  bindDrop($('#curDrop'), f => loadHierFile('current', f));
  bindDrop($('#tgtDrop'), f => loadHierFile('target', f));
  for (const [selId, slot] of [['curFormat', 'current'], ['tgtFormat', 'target']]) {
    $('#' + selId).addEventListener('change', e => {
      state.hierFormatChoice[slot] = e.target.value;
      const old = state.hier[slot];
      if (old && old.sourceText) {
        const tree = parseHierarchy(old.sourceText, e.target.value);
        if (tree) {
          tree.fileName = old.fileName;
          tree.sourceText = old.sourceText;
          state.hier[slot] = tree;
          if (slot === 'target') state.assignments = {};
        }
      }
      changed();
    });
  }

  // check
  $('#checkProject').addEventListener('change', e => {
    state.targetProjectId = e.target.value ? +e.target.value : null;
    changed();
  });
  $('#expPC').addEventListener('click', exportParentChild);
  $('#expLevel').addEventListener('click', exportLevels);
  $('#expReport').addEventListener('click', exportReport);

  // reset
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Clear all loaded data, projects and assignments stored in this browser?')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  renderAll();
}

/* ============================================================ entry points */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    state, normKey, normResp, parseDelimited, splitQuoted, guessMapping, parseKS13,
    buildCostCentres, detectFormat, buildParentChild, buildLevel, classifyTree,
    groupOptions, computeCheck, computeSuggestions, toCSV,
  };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
