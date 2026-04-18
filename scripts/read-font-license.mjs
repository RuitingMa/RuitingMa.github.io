import { readFileSync } from 'fs';

function parseNameTable(path) {
  const buf = readFileSync(path);
  const numTables = buf.readUInt16BE(4);
  let nameOffset = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = buf.slice(rec, rec + 4).toString('ascii');
    if (tag === 'name') {
      nameOffset = buf.readUInt32BE(rec + 8);
      break;
    }
  }
  if (!nameOffset) return [];
  const count = buf.readUInt16BE(nameOffset + 2);
  const stringOffset = buf.readUInt16BE(nameOffset + 4);
  const stringsBase = nameOffset + stringOffset;
  const records = [];
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    const platformID = buf.readUInt16BE(rec);
    const encodingID = buf.readUInt16BE(rec + 2);
    const languageID = buf.readUInt16BE(rec + 4);
    const nameID = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const offset = buf.readUInt16BE(rec + 10);
    const raw = buf.slice(stringsBase + offset, stringsBase + offset + length);
    let text;
    if (platformID === 3 || platformID === 0) {
      const swapped = Buffer.alloc(raw.length);
      for (let j = 0; j + 1 < raw.length; j += 2) {
        swapped[j] = raw[j + 1];
        swapped[j + 1] = raw[j];
      }
      text = swapped.toString('utf16le');
    } else {
      text = raw.toString('utf8');
    }
    records.push({ platformID, encodingID, languageID, nameID, text });
  }
  return records;
}

const fonts = [
  'C:/Users/Lenovo/AppData/Local/Microsoft/Windows/Fonts/匯文明朝體GBK.ttf',
  'C:/Users/Lenovo/AppData/Local/Microsoft/Windows/Fonts/匯文正楷.ttf',
  'C:/Users/Lenovo/AppData/Local/Microsoft/Windows/Fonts/匯文仿宋.ttf',
  'C:/Users/Lenovo/AppData/Local/Microsoft/Windows/Fonts/匯文港黑.ttf',
];

const LABELS = {
  0: 'Copyright',
  1: 'Family',
  3: 'Unique ID',
  5: 'Version',
  7: 'Trademark',
  8: 'Manufacturer',
  9: 'Designer',
  10: 'Description',
  11: 'Vendor URL',
  12: 'Designer URL',
  13: 'License',
  14: 'License URL',
};

for (const p of fonts) {
  const name = p.split('/').pop();
  console.log('\n=== ' + name + ' ===');
  let recs;
  try {
    recs = parseNameTable(p);
  } catch (e) {
    console.log('ERROR: ' + e.message);
    continue;
  }
  for (const id of Object.keys(LABELS).map(Number)) {
    const matches = recs.filter((r) => r.nameID === id);
    if (!matches.length) continue;
    const picked =
      matches.find((r) => r.platformID === 3 && (r.languageID === 0x0409 || r.languageID === 0x0804 || r.languageID === 0x0404)) ||
      matches[0];
    const text = (picked.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    console.log(`  [${id}] ${LABELS[id]}: ${text.slice(0, 600)}`);
  }
}
