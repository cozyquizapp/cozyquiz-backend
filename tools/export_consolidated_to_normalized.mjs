import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const inPath = path.join(__dirname, '..', 'data', 'Schaetzchen_CONSOLIDATED_for_App.csv');
const outPath = path.join(__dirname, '..', 'data', 'items_from_consolidated_normalized.csv');

function safeSplit(row) {
  return row
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(s => s.trim().replace(/^"|"$/g, ''));
}

function mapCategory(k) {
  if (!k) return '';
  const s = String(k).toLowerCase();
  if (s.includes('geschwindigkeit') || s.includes('speed')) return 'speed';
  if (s.includes('entfernung') || s.includes('distance')) return 'distance';
  if (s.includes('größe') || s.includes('gro') || s.includes('size')) return 'size';
  if (s.includes('gewicht') || s.includes('weight')) return 'weight';
  return '';
}

function chooseUnit(cat, displayUnit) {
  if (displayUnit && String(displayUnit).trim() !== '') return displayUnit;
  if (cat === 'speed') return 'km/h';
  if (cat === 'distance') return 'km';
  if (cat === 'size') return 'm';
  if (cat === 'weight') return 'kg';
  return '';
}

try {
  const raw = fs.readFileSync(inPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    console.error('No data found in', inPath);
    process.exit(1);
  }

  const header = safeSplit(lines[0]).map(h => h.trim());
  const idx = name => header.findIndex(h => h.toLowerCase() === name.toLowerCase());

  const iKategorie = idx('Kategorie');
  const iID = idx('ID');
  const iPrompt = idx('Prompt');
  const iKurz = idx('Kurzname');
  const iDisplay = idx('display_unit');
  const iValueSI = idx('value_si');
  const iZiel = idx('Zielwert');
  const iFun = idx('FunFact');

  const outRows = [];
  // header for old-normalized format (no min/max)
  outRows.push(['category','id','prompt','unit','trueValue','funFact'].join(','));

  for (let i = 1; i < lines.length; i++) {
    const cols = safeSplit(lines[i]);
    const rawCat = cols[iKategorie] || '';
    const cat = mapCategory(rawCat);
    if (!cat) continue;
    const id = cols[iID] || `r${i}`;
    const prompt = (cols[iPrompt] || cols[iKurz] || '').replace(/\r|\n/g, ' ');
    const display_unit = cols[iDisplay] || '';
    const unit = chooseUnit(cat, display_unit);
    const value_si_raw = cols[iValueSI] || cols[iZiel] || '';
    const trueValue = parseFloat(String(value_si_raw).replace(/[,\s]/g, '.'));
    if (!isFinite(trueValue)) continue;
    const funFact = (cols[iFun] || '').replace(/\r|\n/g, ' ');

    // CSV-escape prompt and funFact
    const esc = (s) => {
      if (s == null) return '';
      const ss = String(s).replace(/"/g, '""');
      return ss.includes(',') || ss.includes('\n') || ss.includes('"') ? `"${ss}"` : ss;
    };

    outRows.push([
      cat,
      String(id),
      esc(prompt),
      String(unit),
      String(trueValue),
      esc(funFact)
    ].join(','));
  }

  fs.writeFileSync(outPath, outRows.join('\n'), 'utf8');
  console.log('Wrote', outPath, 'with', outRows.length - 1, 'items');
} catch (e) {
  console.error('Conversion failed:', e && e.message);
  process.exit(1);
}
