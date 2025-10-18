#!/usr/bin/env node
// backend/tools/normalize_items.js
// Read items_full.csv, normalize German question prompts into neutral noun phrases
// Writes items_full_normalized.csv alongside the original.

const fs = require('fs');
const path = require('path');

const infile = path.join(__dirname, '..', 'data', 'items_full.csv');
const outfile = path.join(__dirname, '..', 'data', 'items_full_normalized.csv');

if (!fs.existsSync(infile)) {
  console.error('Input file not found:', infile);
  process.exit(2);
}

const raw = fs.readFileSync(infile, 'utf8');
const lines = raw.split(/\r?\n/);
if (lines.length === 0) {
  console.error('Empty CSV');
  process.exit(2);
}

const header = lines[0];
const rows = lines.slice(1).filter(Boolean);

function safeSplit(row) {
  return row.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map(s => s.trim().replace(/^\"|\"$/g, ''));
}

function quoteIfNeeded(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.startsWith(' ')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function normalizePrompt(rawPrompt) {
  if (!rawPrompt || !String(rawPrompt).trim()) return rawPrompt;
  let s = String(rawPrompt).trim();
  // remove trailing question marks and excessive spaces
  s = s.replace(/[?¡!]+$/g, '').trim();

  // helper: remove leading punctuation or bullets
  s = s.replace(/^\u2756\s*/g, '');

  // Lowercase copy for pattern tests
  const low = s.toLowerCase();

  // Patterns: prefer exact German question starts
  // "Wie lang ist ..."
  if (/^wie\s+lang\b/i.test(low)) {
    // remove the question head
    let body = s.replace(/^wie\s+lang\s+(ist\s+(der|die|das)\s+)?/i, '').trim();
    body = body.replace(/^["'\s]+|["'\s]+$/g, '');
    if (!body) return s;
    return `${body} (Länge)`;
  }

  // "Wie hoch ist ..."
  if (/^wie\s+hoch\b/i.test(low)) {
    let body = s.replace(/^wie\s+hoch\s+(ist\s+(der|die|das)\s+)?/i, '').trim();
    body = body.replace(/^["'\s]+|["'\s]+$/g, '');
    if (!body) return s;
    return `${body} (Höhe)`;
  }

  // "Wie breit ist ..."
  if (/^wie\s+breit\b/i.test(low)) {
    let body = s.replace(/^wie\s+breit\s+(ist\s+(der|die|das)\s+)?/i, '').trim();
    body = body.replace(/^["'\s]+|["'\s]+$/g, '');
    if (!body) return s;
    return `${body} (Breite)`;
  }

  // "Wie weit ist ..." -> append "– Entfernung" ; keep any parentheticals like (Luftlinie)
  if (/^wie\s+weit\b/i.test(low)) {
    let body = s.replace(/^wie\s+weit\s+(ist\s+(der|die|das)\s+)?/i, '').trim();
    body = body.replace(/^["'\s]+|["'\s]+$/g, '');
    if (!body) return s;
    // If body already mentions 'Luftlinie' we keep it and append ' – Entfernung'
    return `${body} – Entfernung`;
  }

  // "Wie groß ist ..." -> leave content unchanged (but remove leading question phrasing)
  if (/^wie\s+gro(sz|ß)\b/i.test(low) || /^wie\s+gro[sz]\b/i.test(low)) {
    let body = s.replace(/^wie\s+gro(sz|ß)?\s+(ist\s+(der|die|das)\s+)?/i, '').trim();
    body = body.replace(/^["'\s]+|["'\s]+$/g, '');
    if (!body) return s;
    return `${body}`; // keep as-is; e.g., "Erdumfang" stays
  }

  // If it already looks neutral, just remove trailing question marks (done) and return
  return s;
}

let changed = 0;
const outLines = [header];
for (const row of rows) {
  const cols = safeSplit(row);
  if (cols.length < 3) {
    outLines.push(row);
    continue;
  }
  const originalPrompt = cols[2] || '';
  const normalized = normalizePrompt(originalPrompt);
  if (normalized !== originalPrompt) changed++;
  const newCols = [...cols];
  newCols[2] = normalized;
  // reconstruct row, preserve number of columns
  const outRow = newCols.map(quoteIfNeeded).join(',');
  outLines.push(outRow);
}

fs.writeFileSync(outfile, outLines.join('\n'), 'utf8');
console.log('Done. Input:', infile);
console.log('Output:', outfile);
console.log('Rows processed:', rows.length, 'Prompts changed:', changed);

if (changed > 0) process.exit(0);
process.exit(0);
