#!/usr/bin/env node
// mcp-qris: offline QRIS (EMVCo Merchant-Presented Mode) tools for developers, over MCP stdio.
// Parse, validate, add an amount to a static QRIS, and render a QRIS payload as an SVG QR code.
// One file, no dependencies, Node >= 18, no network access, no file writes.
// stdout carries only JSON-RPC messages (newline-delimited); logs go to stderr.
//
// References: EMVCo QR Code Specification for Payment Systems, Merchant-Presented Mode v1.1 (Nov 2020);
// Bank Indonesia QRIS (PADG 21/18/PADG/2019 and amendments, PADG 24/1/PADG/2022); ISO/IEC 18004 (QR Code).
//
// This tool never moves money. It only reads and rewrites text.
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_INPUT_CHARS = 2048;
const RECOMMENDED_MAX_CHARS = 512; // EMVCo MPM 4.1: payload "should not exceed 512 alphanumeric characters"
const QRIS_GUI = 'ID.CO.QRIS.WWW';
const QRIS_SINGLE_TX_LIMIT = 10000000; // PADG 24/1/PADG/2022: max Rp10.000.000 per QRIS transaction (verify for changes)

class ToolError extends Error {}

function log(...args) {
  process.stderr.write('[mcp-qris] ' + args.map(String).join(' ') + '\n');
}

// ---------- CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as EMVCo MPM 4.7.3 ----------

export function crc16(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// ---------- names ----------

function rootName(id) {
  const n = Number(id);
  const fixed = {
    '00': 'Payload Format Indicator', '01': 'Point of Initiation Method', '52': 'Merchant Category Code',
    '53': 'Transaction Currency', '54': 'Transaction Amount', '55': 'Tip or Convenience Indicator',
    '56': 'Value of Convenience Fee Fixed', '57': 'Value of Convenience Fee Percentage', '58': 'Country Code',
    '59': 'Merchant Name', '60': 'Merchant City', '61': 'Postal Code', '62': 'Additional Data Field Template',
    '63': 'CRC', '64': 'Merchant Information - Language Template',
  };
  if (fixed[id]) return fixed[id];
  if (n >= 2 && n <= 25) {
    const nets = { 2: 'Visa', 3: 'Visa', 4: 'Mastercard', 5: 'Mastercard', 9: 'Discover', 10: 'Discover', 11: 'Amex', 12: 'Amex', 13: 'JCB', 14: 'JCB', 15: 'UnionPay', 16: 'UnionPay' };
    return `Merchant Account Information (primitive${nets[n] ? ', reserved for ' + nets[n] : ', reserved by EMVCo'})`;
  }
  if (n >= 26 && n <= 51) return 'Merchant Account Information Template';
  if (n >= 65 && n <= 79) return 'RFU for EMVCo';
  if (n >= 80 && n <= 99) return 'Unreserved Template';
  return 'Unknown';
}

const ADDITIONAL_NAMES = {
  '01': 'Bill Number', '02': 'Mobile Number', '03': 'Store Label', '04': 'Loyalty Number', '05': 'Reference Label',
  '06': 'Customer Label', '07': 'Terminal Label', '08': 'Purpose of Transaction', '09': 'Additional Consumer Data Request',
  '10': 'Merchant Tax ID', '11': 'Merchant Channel',
};
const ADDITIONAL_KEYS = {
  '01': 'bill_number', '02': 'mobile_number', '03': 'store_label', '04': 'loyalty_number', '05': 'reference_label',
  '06': 'customer_label', '07': 'terminal_label', '08': 'purpose_of_transaction', '09': 'additional_consumer_data_request',
  '10': 'merchant_tax_id', '11': 'merchant_channel',
};
// EMVCo MPM Table 3.7 maximum lengths.
const ADDITIONAL_MAX = { '01': 25, '02': 25, '03': 25, '04': 25, '05': 25, '06': 25, '07': 25, '08': 25, '09': 3, '10': 20, '11': 3 };
const LANGUAGE_NAMES = { '00': 'Language Preference', '01': 'Merchant Name - Alternate Language', '02': 'Merchant City - Alternate Language' };

// QRIS merchant criteria codes as commonly documented by Indonesian payment providers.
const CRITERIA = { UMI: 'Usaha Mikro (micro)', UKE: 'Usaha Kecil (small)', UME: 'Usaha Menengah (medium)', UBE: 'Usaha Besar (large)', URE: 'Reguler (regular / not classified)' };

// Indonesian QRIS account templates use reverse-domain GUIs under "ID." (e.g. ID.CO.QRIS.WWW). For any other GUI the
// meaning of sub-IDs 01-99 belongs to that payment network (EMVCo MPM 4.7.11), so we do not guess names.
const isIdGui = gui => typeof gui === 'string' && /^ID\./i.test(gui);

function accountSubName(gui, id) {
  if (id === '00') return 'Globally Unique Identifier';
  if (!isIdGui(gui)) return 'Payment network specific';
  if (gui === QRIS_GUI) return { '02': 'NMID (National Merchant ID)', '03': 'Merchant Criteria' }[id] || 'Payment network specific';
  return { '01': 'Merchant PAN', '02': 'Merchant ID', '03': 'Merchant Criteria' }[id] || 'Payment network specific';
}

// ---------- TLV parsing (lengths count characters, per EMVCo MPM 4.4.1.1) ----------

function parseLevel(chars, from, to, where, problems) {
  const items = [];
  let i = from;
  while (i < to) {
    if (to - i < 4) {
      problems.push(err('TRUNCATED', `${where}: data berakhir di tengah ID/panjang pada posisi ${i} / data ends inside an ID or length at character ${i}.`));
      return { items, ok: false };
    }
    const id = chars.slice(i, i + 2).join('');
    const lenTxt = chars.slice(i + 2, i + 4).join('');
    if (!/^\d\d$/.test(id)) {
      problems.push(err('BAD_ID', `${where}: ID "${clip(id)}" pada posisi ${i} bukan 2 digit / ID at character ${i} is not two digits.`));
      return { items, ok: false };
    }
    if (!/^\d\d$/.test(lenTxt)) {
      problems.push(err('BAD_LENGTH', `${where}: panjang "${clip(lenTxt)}" untuk ID ${id} (posisi ${i + 2}) bukan 2 digit / length of ID ${id} is not two digits.`));
      return { items, ok: false };
    }
    const len = Number(lenTxt);
    if (len === 0) problems.push(err('ZERO_LENGTH', `${where}: ID ${id} punya panjang 00 (minimal 01) / ID ${id} has length 00 (minimum 01).`));
    if (i + 4 + len > to) {
      problems.push(err('TRUNCATED', `${where}: ID ${id} menyatakan panjang ${len} tetapi hanya tersisa ${to - i - 4} karakter / ID ${id} declares length ${len} but only ${to - i - 4} characters remain.`));
      return { items, ok: false };
    }
    items.push({ id, length: len, value: chars.slice(i + 4, i + 4 + len).join(''), start: i, valueStart: i + 4, end: i + 4 + len });
    i += 4 + len;
  }
  return { items, ok: true };
}

function clip(s) { return String(s).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 40); }
function err(code, message) { return { level: 'error', code, message }; }
function warn(code, message) { return { level: 'warning', code, message }; }

const ANS_RE = /^[\x20-\x7e]*$/; // EMV Common Character Set is printable ASCII
const AMOUNT_RE = /^(\d+\.?\d*)$/;

function isTemplateRoot(id) {
  const n = Number(id);
  return (n >= 26 && n <= 51) || id === '62' || id === '64' || (n >= 80 && n <= 99);
}

// Full analysis: tree, summary, CRC and every problem found.
export function analyze(input) {
  if (typeof input !== 'string') throw new ToolError('"qris" harus berupa teks / must be a string (paste the QRIS payload text, not an image).');
  const payload = input.replace(/^[\s​﻿]+|[\s​﻿]+$/g, '');
  if (!payload) throw new ToolError('"qris" kosong / is empty. Tempel isi teks QRIS (mulai dengan 000201) / paste the QRIS text (starts with 000201).');
  const chars = Array.from(payload);
  if (chars.length > MAX_INPUT_CHARS) throw new ToolError(`QRIS terlalu panjang (${chars.length} karakter, maks ${MAX_INPUT_CHARS}) / payload too long.`);
  const problems = [];
  if (/[\r\n\t]/.test(payload)) problems.push(err('CONTROL_CHAR', 'Ada baris baru/tab di tengah payload; QRIS asli tidak mengandung karakter ini / the payload contains a newline or tab, which a real QRIS never has.'));
  if (chars.length > RECOMMENDED_MAX_CHARS) problems.push(warn('LONG_PAYLOAD', `Panjang ${chars.length} karakter melebihi batas anjuran EMVCo 512 / exceeds the 512-character recommendation.`));

  const root = parseLevel(chars, 0, chars.length, 'root', problems);
  const tree = [];
  const seen = new Set();
  for (const it of root.items) {
    const node = { tag: it.id, name: rootName(it.id), length: it.length, value: it.value };
    if (seen.has(it.id)) problems.push(err('DUPLICATE_ID', `ID ${it.id} muncul lebih dari sekali di root / appears more than once at the root.`));
    seen.add(it.id);
    if (isTemplateRoot(it.id) && it.length > 0) {
      const sub = parseLevel(chars, it.valueStart, it.end, `ID ${it.id}`, problems);
      const subSeen = new Set();
      const gui = (sub.items.find(s => s.id === '00') || {}).value;
      node.children = sub.items.map(s => {
        if (subSeen.has(s.id)) problems.push(err('DUPLICATE_ID', `ID ${s.id} muncul lebih dari sekali di dalam ID ${it.id} / appears twice inside template ${it.id}.`));
        subSeen.add(s.id);
        let name = 'Unknown';
        const child = { tag: s.id, name, length: s.length, value: s.value };
        if (it.id === '62') {
          const n = Number(s.id);
          name = ADDITIONAL_NAMES[s.id] || (n >= 50 ? 'Payment System Specific Template' : 'RFU for EMVCo');
          if (n >= 50) {
            const deeper = parseLevel(Array.from(s.value), 0, Array.from(s.value).length, `ID 62.${s.id}`, problems);
            child.children = deeper.items.map(d => ({ tag: d.id, name: d.id === '00' ? 'Globally Unique Identifier' : 'Payment system specific', length: d.length, value: d.value }));
          }
        } else if (it.id === '64') name = LANGUAGE_NAMES[s.id] || 'RFU for EMVCo';
        else if (Number(it.id) >= 80) name = s.id === '00' ? 'Globally Unique Identifier' : 'Context specific';
        else name = accountSubName(gui, s.id);
        child.name = name;
        return child;
      });
    }
    tree.push(node);
  }

  const get = id => root.items.find(x => x.id === id);
  const crcItem = get('63');
  let crc = { found: null, computed: null, match: false };
  if (crcItem) {
    const prefix = chars.slice(0, crcItem.valueStart).join('');
    crc = { found: crcItem.value, computed: crc16(prefix), match: false };
    crc.match = crcItem.value.toUpperCase() === crc.computed;
  } else if (root.ok || root.items.length) {
    // Even with a broken structure, try the classic layout "...6304XXXX" so the user still learns the CRC state.
    const m = payload.match(/6304([0-9A-Fa-f]{4})$/);
    if (m) { crc = { found: m[1], computed: crc16(payload.slice(0, -4)), match: false }; crc.match = m[1].toUpperCase() === crc.computed; }
  }

  const before = problems.length;
  checkRules(root, tree, get, crc, crcItem, chars, problems);
  if (!root.ok) {
    // After a structural break the rest of the payload cannot be read, so "missing field" findings would be noise.
    const kept = problems.slice(before).filter(p => !/(_MISSING|^NO_)/.test(p.code));
    problems.splice(before, problems.length - before, ...kept);
    problems.push(warn('CHECKS_SKIPPED', 'Struktur rusak, sisa payload setelah titik rusak tidak bisa dibaca sehingga pengecekan field wajib dilewati / the structure is broken, so the remaining payload could not be read and mandatory-field checks were skipped.'));
  }

  const summary = summarize(tree, get, crc);
  const errors = problems.filter(p => p.level === 'error').length;
  return { payload, chars, valid: errors === 0, errors, warnings: problems.length - errors, crc, summary, tree, problems, rootItems: root.items, structureOk: root.ok };
}

function checkRules(root, tree, get, crc, crcItem, chars, problems) {
  if (!root.ok && !root.items.length) return;
  const ids = root.items.map(x => x.id);
  // position rules
  if (ids[0] !== '00') problems.push(err('PFI_NOT_FIRST', 'ID 00 (Payload Format Indicator) harus menjadi data pertama / must be the first data object (QRIS starts with "000201").'));
  if (!crcItem) problems.push(err('CRC_MISSING', 'ID 63 (CRC) tidak ada / is missing. QRIS selalu diakhiri "6304" + 4 karakter hex / always ends with "6304" + 4 hex characters.'));
  else {
    if (root.ok && ids[ids.length - 1] !== '63') problems.push(err('CRC_NOT_LAST', 'ID 63 (CRC) harus menjadi data terakhir / must be the last data object.'));
    if (crcItem.length !== 4) problems.push(err('CRC_LENGTH', `Panjang CRC harus 04, ditemukan ${String(crcItem.length).padStart(2, '0')} / CRC length must be 04.`));
  }
  if (crc.found !== null) {
    if (!/^[0-9A-F]{4}$/.test(crc.found)) {
      if (/^[0-9a-fA-F]{4}$/.test(crc.found)) problems.push(err('CRC_LOWERCASE', 'CRC harus huruf besar (A-F) / CRC hex must be uppercase.'));
      else problems.push(err('CRC_FORMAT', 'CRC harus 4 karakter hex / CRC must be 4 hex characters.'));
    }
    if (!crc.match) problems.push(err('CRC_MISMATCH', `CRC tidak cocok: tertulis ${clip(crc.found)}, seharusnya ${crc.computed}. Payload rusak/terpotong atau sudah diubah / CRC mismatch: the payload was altered, truncated or mistyped.`));
  }

  const v = id => (get(id) || {}).value;
  // 00
  if (get('00') && v('00') !== '01') problems.push(err('PFI_VALUE', `ID 00 harus "01", ditemukan "${clip(v('00'))}" / Payload Format Indicator must be "01".`));
  if (!get('00')) problems.push(err('PFI_MISSING', 'ID 00 (Payload Format Indicator) tidak ada / is missing.'));
  // 01
  if (get('01')) {
    if (!['11', '12'].includes(v('01'))) problems.push(err('POI_VALUE', `ID 01 harus "11" (statis) atau "12" (dinamis), ditemukan "${clip(v('01'))}" / Point of Initiation must be 11 or 12.`));
  } else problems.push(warn('POI_MISSING', 'ID 01 (statis/dinamis) tidak ada; opsional di EMVCo tetapi QRIS biasanya mencantumkannya / Point of Initiation is missing (optional in EMVCo, normally present in QRIS).'));
  // merchant accounts
  const mai = root.items.filter(x => Number(x.id) >= 2 && Number(x.id) <= 51);
  if (!mai.length) problems.push(err('NO_MERCHANT_ACCOUNT', 'Tidak ada Merchant Account Information (ID 02-51) / at least one merchant account (IDs 02-51) is required.'));
  for (const node of tree) {
    const n = Number(node.tag);
    if (((n >= 26 && n <= 51) || n >= 80) && node.children) {
      const g = node.children.find(c => c.tag === '00');
      if (!g) problems.push(err('GUI_MISSING', `Template ID ${node.tag} tidak punya Globally Unique Identifier (sub-ID 00) / template ${node.tag} has no GUI (sub-ID 00).`));
      else if (g.value.length > 32 || !ANS_RE.test(g.value)) problems.push(err('GUI_FORMAT', `GUI di ID ${node.tag} harus maks 32 karakter ASCII / GUI in ${node.tag} must be at most 32 printable characters.`));
    }
    if (n >= 65 && n <= 79) problems.push(warn('RFU_ID', `ID ${node.tag} dicadangkan EMVCo (RFU) dan seharusnya tidak dipakai / is reserved for future use and should not be present.`));
    if (n >= 17 && n <= 25) problems.push(warn('RESERVED_ID', `ID ${node.tag} dicadangkan EMVCo / is reserved by EMVCo.`));
  }
  const qris = tree.find(t => Number(t.tag) >= 26 && Number(t.tag) <= 51 && t.children && t.children.some(c => c.tag === '00' && c.value === QRIS_GUI));
  if (!qris) problems.push(warn('NO_QRIS_ID', `Tidak ada template dengan GUI "${QRIS_GUI}" (biasanya di ID 51, berisi NMID). Bisa jadi ini bukan QRIS Indonesia / no template with the national QRIS GUI (normally ID 51 with the NMID); this may not be an Indonesian QRIS.`));
  else {
    const nmid = qris.children.find(c => c.tag === '02');
    if (!nmid) problems.push(warn('NMID_MISSING', `Template ${qris.tag} (QRIS) tidak berisi NMID di sub-ID 02 / has no NMID in sub-ID 02.`));
    else if (!/^ID\d{10,13}$/.test(nmid.value)) problems.push(warn('NMID_FORMAT', `NMID "${clip(nmid.value)}" tidak berbentuk umum "ID" + angka / NMID does not look like the usual "ID" + digits form.`));
  }
  for (const node of tree.filter(t => Number(t.tag) >= 26 && Number(t.tag) <= 51 && t.children)) {
    if (!isIdGui((node.children.find(x => x.tag === '00') || {}).value)) continue;
    const c = node.children.find(x => x.tag === '03');
    if (c && !CRITERIA[c.value]) problems.push(warn('CRITERIA_UNKNOWN', `Kriteria merchant "${clip(c.value)}" di ID ${node.tag} tidak dikenal (UMI/UKE/UME/UBE/URE) / unknown merchant criteria.`));
  }
  // 52
  if (!get('52')) problems.push(err('MCC_MISSING', 'ID 52 (Merchant Category Code) tidak ada / is missing.'));
  else if (!/^\d{4}$/.test(v('52'))) problems.push(err('MCC_FORMAT', `MCC harus 4 digit, ditemukan "${clip(v('52'))}" / MCC must be 4 digits.`));
  // 53
  if (!get('53')) problems.push(err('CURRENCY_MISSING', 'ID 53 (mata uang) tidak ada / Transaction Currency is missing.'));
  else if (!/^\d{3}$/.test(v('53'))) problems.push(err('CURRENCY_FORMAT', `Mata uang harus 3 digit ISO 4217, ditemukan "${clip(v('53'))}" / currency must be a 3-digit ISO 4217 code.`));
  else if (v('53') !== '360') problems.push(warn('CURRENCY_NOT_IDR', `Mata uang ${v('53')} bukan 360 (Rupiah) / currency is not 360 (IDR).`));
  // 54
  const poi = v('01');
  if (get('54')) {
    const a = v('54');
    if (a.length > 13) problems.push(err('AMOUNT_LENGTH', 'Nominal (ID 54) maksimal 13 karakter / amount is at most 13 characters.'));
    if (!AMOUNT_RE.test(a)) problems.push(err('AMOUNT_FORMAT', `Nominal "${clip(a)}" hanya boleh angka dan satu titik desimal (tanpa pemisah ribuan) / amount may only contain digits and one "." decimal mark.`));
    else if (!/[1-9]/.test(a)) problems.push(err('AMOUNT_ZERO', 'Nominal tidak boleh nol / amount must not be zero.'));
    else if (/\.\d{3,}$/.test(a)) problems.push(warn('AMOUNT_DECIMALS', 'Nominal punya lebih dari 2 desimal; Rupiah memakai maksimal 2 / more than 2 decimals for IDR.'));
    if (poi === '11') problems.push(warn('STATIC_WITH_AMOUNT', 'QR statis (01=11) tetapi berisi nominal (ID 54). QR berisi nominal biasanya dinamis (12) / static code carries an amount; amount codes are normally dynamic (12).'));
    if (AMOUNT_RE.test(a) && Number(a) > QRIS_SINGLE_TX_LIMIT) problems.push(warn('AMOUNT_OVER_LIMIT', 'Nominal di atas Rp10.000.000, batas per transaksi QRIS menurut PADG 24/1/PADG/2022 (cek aturan terbaru) / above the Rp10,000,000 per-transaction QRIS limit (PADG 24/1/PADG/2022; check for updates).'));
  } else if (poi === '12') problems.push(warn('DYNAMIC_WITHOUT_AMOUNT', 'QR dinamis (01=12) tanpa nominal (ID 54); pembayar akan diminta mengisi nominal / dynamic code without an amount: the payer will be asked to type it.'));
  // 55-57
  const tip = v('55');
  if (get('55') && !['01', '02', '03'].includes(tip)) problems.push(err('TIP_VALUE', `ID 55 harus 01, 02 atau 03, ditemukan "${clip(tip)}" / Tip or Convenience Indicator must be 01, 02 or 03.`));
  if (tip === '02') {
    if (!get('56')) problems.push(err('FEE_FIXED_MISSING', 'ID 55=02 mewajibkan ID 56 (biaya tetap) / 55=02 requires ID 56 (fixed fee).'));
  } else if (get('56')) problems.push(err('FEE_FIXED_UNEXPECTED', 'ID 56 hanya boleh ada jika ID 55=02 / ID 56 is only allowed when ID 55 is 02.'));
  if (get('56')) {
    const f = v('56');
    if (f.length > 13 || !AMOUNT_RE.test(f) || !/[1-9]/.test(f)) problems.push(err('FEE_FIXED_FORMAT', `Biaya tetap "${clip(f)}" harus angka > 0 (maks 13 karakter) / fixed fee must be a non-zero number.`));
  }
  if (tip === '03') {
    if (!get('57')) problems.push(err('FEE_PERCENT_MISSING', 'ID 55=03 mewajibkan ID 57 (biaya persen) / 55=03 requires ID 57 (percentage fee).'));
  } else if (get('57')) problems.push(err('FEE_PERCENT_UNEXPECTED', 'ID 57 hanya boleh ada jika ID 55=03 / ID 57 is only allowed when ID 55 is 03.'));
  if (get('57')) {
    const p = v('57');
    if (p.length > 5 || !AMOUNT_RE.test(p) || Number(p) < 0.01 || Number(p) > 99.99) problems.push(err('FEE_PERCENT_FORMAT', `Biaya persen "${clip(p)}" harus antara 00.01 dan 99.99 tanpa "%" / percentage fee must be 00.01-99.99, no "%".`));
  }
  // 58-61
  if (!get('58')) problems.push(err('COUNTRY_MISSING', 'ID 58 (kode negara) tidak ada / Country Code is missing.'));
  else if (!/^[A-Z]{2}$/.test(v('58'))) problems.push(err('COUNTRY_FORMAT', `Kode negara harus 2 huruf ISO 3166, ditemukan "${clip(v('58'))}" / country must be 2 letters.`));
  else if (v('58') !== 'ID') problems.push(warn('COUNTRY_NOT_ID', `Kode negara ${v('58')} bukan ID (Indonesia) / country is not ID.`));
  for (const [id, label, max, req] of [['59', 'Merchant Name', 25, true], ['60', 'Merchant City', 15, true], ['61', 'Postal Code', 10, false]]) {
    if (!get(id)) { if (req) problems.push(err(`${id}_MISSING`, `ID ${id} (${label}) tidak ada / is missing.`)); continue; }
    if (v(id).length > max) problems.push(err(`${id}_LENGTH`, `ID ${id} (${label}) maksimal ${max} karakter / at most ${max} characters.`));
    if (!ANS_RE.test(v(id))) problems.push(err(`${id}_CHARSET`, `ID ${id} (${label}) hanya boleh karakter ASCII yang bisa dicetak / only printable ASCII is allowed here.`));
  }
  // primitive ans fields
  for (const id of ['00', '01', '52', '53', '54', '55', '56', '57', '58', '63']) {
    if (get(id) && !ANS_RE.test(v(id))) problems.push(err('CHARSET', `ID ${id} berisi karakter di luar ASCII / contains non-ASCII characters.`));
  }
  // 62
  const add = tree.find(t => t.tag === '62');
  if (add) {
    if (!add.children || !add.children.length) problems.push(err('ADDITIONAL_EMPTY', 'ID 62 harus berisi minimal satu data / Additional Data template must contain at least one data object.'));
    for (const c of add.children || []) {
      const n = Number(c.tag);
      if (ADDITIONAL_MAX[c.tag] && c.length > ADDITIONAL_MAX[c.tag]) problems.push(err('ADDITIONAL_LENGTH', `ID 62.${c.tag} (${c.name}) maksimal ${ADDITIONAL_MAX[c.tag]} karakter / at most ${ADDITIONAL_MAX[c.tag]} characters.`));
      if (n <= 11 && !ANS_RE.test(c.value)) problems.push(err('ADDITIONAL_CHARSET', `ID 62.${c.tag} hanya boleh ASCII / must be printable ASCII.`));
      if (c.tag === '09' && (!/^[AME]{1,3}$/.test(c.value) || new Set(c.value).size !== c.value.length)) problems.push(err('ADDITIONAL_09', 'ID 62.09 hanya berisi A, M, E (masing-masing sekali) / may only contain A, M, E once each.'));
      if (c.tag === '11' && !/^[0-7][0-3][0-3]$/.test(c.value)) problems.push(err('ADDITIONAL_11', 'ID 62.11 (Merchant Channel) harus 3 karakter sesuai tabel EMVCo 4.5-4.7 / must be 3 characters per EMVCo tables 4.5-4.7.'));
      if (n >= 12 && n <= 49) problems.push(warn('RFU_ID', `ID 62.${c.tag} dicadangkan EMVCo (RFU) / is reserved for future use.`));
      if (n >= 50 && !(c.children || []).some(d => d.tag === '00')) problems.push(err('GUI_MISSING', `Template 62.${c.tag} tidak punya GUI (sub-ID 00) / has no GUI (sub-ID 00).`));
    }
  }
  // 64
  const lang = tree.find(t => t.tag === '64');
  if (lang && lang.children) {
    const l00 = lang.children.find(c => c.tag === '00');
    if (!l00) problems.push(err('LANG_00_MISSING', 'ID 64 wajib berisi sub-ID 00 (bahasa) / must contain sub-ID 00 (language).'));
    else if (!/^[A-Za-z]{2}$/.test(l00.value)) problems.push(err('LANG_00_FORMAT', 'ID 64.00 harus 2 huruf ISO 639 / must be 2 letters (ISO 639).'));
    const l01 = lang.children.find(c => c.tag === '01');
    if (!l01) problems.push(err('LANG_01_MISSING', 'ID 64 wajib berisi sub-ID 01 (nama merchant) / must contain sub-ID 01 (merchant name).'));
    else if (l01.length > 25) problems.push(err('LANG_01_LENGTH', 'ID 64.01 maksimal 25 karakter / at most 25 characters.'));
    const l02 = lang.children.find(c => c.tag === '02');
    if (l02 && l02.length > 15) problems.push(err('LANG_02_LENGTH', 'ID 64.02 maksimal 15 karakter / at most 15 characters.'));
  }
}

function summarize(tree, get, crc) {
  const v = id => (get(id) || {}).value ?? null;
  const accounts = tree.filter(t => Number(t.tag) >= 2 && Number(t.tag) <= 51).map(t => {
    if (!t.children) return { tag: t.tag, type: 'primitive', value: t.value };
    const sub = id => (t.children.find(c => c.tag === id) || {}).value ?? null;
    const gui = sub('00');
    const out = { tag: t.tag, gui, is_national_qris: gui === QRIS_GUI };
    if (!isIdGui(gui)) {
      const rest = t.children.filter(x => x.tag !== '00');
      if (rest.length) out.network_specific = Object.fromEntries(rest.map(x => [x.tag, x.value]));
      return out;
    }
    if (gui === QRIS_GUI) out.nmid = sub('02');
    else { out.merchant_pan = sub('01'); out.merchant_id = sub('02'); }
    const c = sub('03');
    if (c) out.merchant_criteria = { code: c, meaning: CRITERIA[c] || 'unknown' };
    const extra = t.children.filter(x => !['00', '01', '02', '03'].includes(x.tag) || (gui === QRIS_GUI && x.tag === '01'));
    if (extra.length) out.other = Object.fromEntries(extra.map(x => [x.tag, x.value]));
    return out;
  });
  const national = accounts.find(a => a.is_national_qris);
  const poi = v('01');
  const tipCode = v('55');
  const add = tree.find(t => t.tag === '62');
  const additional = add && add.children ? Object.fromEntries(add.children.map(c => [ADDITIONAL_KEYS[c.tag] || `id_${c.tag}`, c.children ? Object.fromEntries(c.children.map(d => [d.tag, d.value])) : c.value])) : null;
  const lang = tree.find(t => t.tag === '64');
  return {
    payload_format: v('00'),
    point_of_initiation: poi === '11' ? 'static (11): one code, many payments; payer types the amount' : poi === '12' ? 'dynamic (12): one code per transaction' : poi,
    type: poi === '11' ? 'static' : poi === '12' ? 'dynamic' : 'unknown',
    nmid: national ? national.nmid : null,
    merchant_accounts: accounts,
    merchant_category_code: v('52'),
    currency: v('53') ? { code: v('53'), meaning: v('53') === '360' ? 'IDR (Rupiah)' : 'other ISO 4217 currency' } : null,
    amount: v('54'),
    tip_or_convenience: tipCode ? {
      code: tipCode,
      meaning: { '01': 'payer is prompted to enter a tip', '02': 'fixed convenience fee (ID 56)', '03': 'percentage convenience fee (ID 57)' }[tipCode] || 'invalid',
      fixed_fee: v('56'), percentage_fee: v('57'),
    } : null,
    country: v('58'),
    merchant_name: v('59'),
    merchant_city: v('60'),
    postal_code: v('61'),
    additional_data: additional,
    language_template: lang && lang.children ? Object.fromEntries(lang.children.map(c => [c.tag, c.value])) : null,
    crc: crc.found === null ? null : { found: crc.found, computed: crc.computed, match: crc.match },
  };
}

// ---------- static -> dynamic ----------

function serialize(items) {
  return items.map(it => {
    const len = Array.from(it.value).length;
    if (len < 1 || len > 99) throw new ToolError(`Nilai ID ${it.id} panjangnya ${len}; harus 1-99 / value length must be 1-99.`);
    return it.id + String(len).padStart(2, '0') + it.value;
  }).join('');
}

export function withCrc(body) {
  const pre = body + '6304';
  return pre + crc16(pre);
}

function parseRupiahInteger(v, name) {
  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ToolError(`"${name}" harus angka / must be a number.`);
    if (!Number.isInteger(v)) throw new ToolError(`"${name}" harus Rupiah bulat (tanpa sen), mis. 15000 / must be whole Rupiah, e.g. 15000.`);
    if (!Number.isSafeInteger(v)) throw new ToolError(`"${name}" terlalu besar / is too large.`);
    if (v < 1) throw new ToolError(`"${name}" harus lebih dari 0 / must be greater than 0.`);
    s = String(v);
  } else if (typeof v === 'string') {
    const t = v.trim().replace(/^(rp\.?|idr)\s*/i, '').replace(/,-$/, '').replace(/,00$/, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) s = t.replace(/\./g, '');
    else if (/^\d+$/.test(t)) s = t;
    else throw new ToolError(`"${name}" tidak dikenali: "${clip(v)}". Pakai angka Rupiah bulat, mis. 15000 atau "15.000" / use whole Rupiah, e.g. 15000.`);
  } else throw new ToolError(`"${name}" wajib diisi / is required (whole Rupiah, e.g. 15000).`);
  s = s.replace(/^0+(?=\d)/, '');
  if (!/[1-9]/.test(s)) throw new ToolError(`"${name}" harus lebih dari 0 / must be greater than 0.`);
  if (s.length > 13) throw new ToolError(`"${name}" maksimal 13 digit / at most 13 digits.`);
  return s;
}

export function setAmount(args) {
  const a = analyze(args.qris);
  if (!a.structureOk || a.errors) {
    const list = a.problems.filter(p => p.level === 'error').map(p => `- [${p.code}] ${p.message}`).join('\n');
    throw new ToolError('QRIS sumber tidak valid, jadi tidak diubah. Perbaiki/ambil ulang QRIS asli dari merchant. / The source QRIS is invalid, so nothing was changed. Get the original code again.\n' + list);
  }
  const poi = (a.rootItems.find(x => x.id === '01') || {}).value;
  const allowDynamic = args.allow_dynamic_input === true;
  if (poi === '12' && !allowDynamic) {
    throw new ToolError('QRIS ini sudah dinamis (01=12). QR dinamis biasanya untuk satu transaksi saja; minta QR baru dari sistem merchant. Jika yakin, set allow_dynamic_input=true. / This QRIS is already dynamic (one transaction only). Ask the merchant system for a new code, or set allow_dynamic_input=true if you are sure.');
  }
  const amount = parseRupiahInteger(args.amount, 'amount');
  const tipMode = args.tip === undefined || args.tip === null || args.tip === '' ? 'none' : String(args.tip);
  if (!['none', 'prompt', 'fixed', 'percent'].includes(tipMode)) throw new ToolError('"tip" harus none, prompt, fixed atau percent / must be none, prompt, fixed or percent.');
  const tipItems = [];
  if (tipMode === 'prompt') tipItems.push({ id: '55', value: '01' });
  if (tipMode === 'fixed') tipItems.push({ id: '55', value: '02' }, { id: '56', value: parseRupiahInteger(args.tip_value, 'tip_value') });
  if (tipMode === 'percent') {
    const p = typeof args.tip_value === 'string' ? Number(args.tip_value.replace(',', '.').replace('%', '').trim()) : Number(args.tip_value);
    if (!Number.isFinite(p) || p < 0.01 || p > 99.99 || Math.abs(p * 100 - Math.round(p * 100)) > 1e-9) {
      throw new ToolError('"tip_value" untuk percent harus 0.01-99.99 (maks 2 desimal) / must be 0.01-99.99 with at most 2 decimals.');
    }
    tipItems.push({ id: '55', value: '03' }, { id: '57', value: String(Math.round(p * 100) / 100) });
  }
  if (tipMode === 'none' && args.tip_value !== undefined && args.tip_value !== null && args.tip_value !== '') {
    throw new ToolError('"tip_value" diisi tetapi "tip" = none. Pilih tip fixed atau percent / tip_value given but tip is none.');
  }

  const changes = [];
  let items = a.rootItems.filter(x => x.id !== '63').map(x => ({ id: x.id, value: x.value }));
  const old = id => (items.find(x => x.id === id) || {}).value;
  if (old('54') !== undefined) changes.push(`ID 54 nominal lama "${old('54')}" diganti / old amount replaced`);
  for (const id of ['55', '56', '57']) if (old(id) !== undefined) changes.push(`ID ${id} lama dihapus / old ID ${id} removed`);
  items = items.filter(x => !['54', '55', '56', '57'].includes(x.id));
  const poiItem = items.find(x => x.id === '01');
  if (poiItem) { if (poiItem.value !== '12') changes.push('ID 01: 11 (statis) -> 12 (dinamis) / static -> dynamic'); poiItem.value = '12'; }
  else { items.splice(1, 0, { id: '01', value: '12' }); changes.push('ID 01 ditambahkan = 12 (dinamis) / added as dynamic'); }
  const insert = [{ id: '54', value: amount }, ...tipItems];
  let at = items.findIndex(x => x.id === '53');
  if (at >= 0) at += 1;
  else { at = items.findIndex(x => Number(x.id) >= 58); if (at < 0) at = items.length; }
  items.splice(at, 0, ...insert);
  changes.push(`ID 54 = ${amount} (Rp${formatThousands(amount)})`);
  if (tipItems.length) changes.push(`ID 55 = ${tipItems[0].value}` + (tipItems[1] ? `, ID ${tipItems[1].id} = ${tipItems[1].value}` : ''));
  const out = withCrc(serialize(items));
  const check = analyze(out);
  if (!check.valid) {
    log('internal: output failed validation', JSON.stringify(check.problems));
    throw new ToolError('Hasil tidak lolos validasi, tidak dikembalikan. Laporkan ini sebagai bug. / The result failed validation and was not returned. Please report this as a bug.');
  }
  changes.push(`ID 63 CRC dihitung ulang = ${check.crc.computed} / CRC recomputed`);
  const notes = [
    'Ini hanya mengubah teks QR, tidak memindahkan uang. QR dinamis hanya sah sejauh QR statis merchant-nya sah. Uji dulu dengan nominal kecil. / This only rewrites text and never moves money. The dynamic code is only as valid as the merchant\'s static code. Test with a small amount first.',
    'Jangan memakai QRIS milik orang lain tanpa izin pemiliknya. / Never use someone else\'s QRIS without the owner\'s permission.',
  ];
  if (Number(amount) > QRIS_SINGLE_TX_LIMIT) notes.push('Nominal di atas Rp10.000.000: banyak aplikasi akan menolak (batas per transaksi QRIS, PADG 24/1/PADG/2022; cek aturan terbaru). / Above the Rp10,000,000 per-transaction QRIS limit; most apps will refuse it.');
  const addl = check.summary.additional_data;
  if (addl && (addl.bill_number || addl.reference_label) && poi === '12') notes.push('QR sumber membawa nomor tagihan/referensi; nomor itu ikut tersalin. / The source carried a bill/reference number, which was copied as is.');
  return {
    qris: out,
    amount: Number(amount),
    amount_formatted: 'Rp' + formatThousands(amount),
    merchant_name: check.summary.merchant_name,
    nmid: check.summary.nmid,
    crc: check.crc.computed,
    changes,
    warnings: check.problems.filter(p => p.level === 'warning').map(p => `[${p.code}] ${p.message}`),
    notes,
  };
}

function formatThousands(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ---------- QR Code encoder (ISO/IEC 18004, byte mode, versions 1-40) ----------
// Structure follows the public algorithm description (finder/timing/alignment patterns, Reed-Solomon over GF(256)
// with polynomial 0x11D, BCH-coded format/version information, eight masks with the standard penalty rules).

const ECL = { L: { ord: 0, bits: 1 }, M: { ord: 1, bits: 0 }, Q: { ord: 2, bits: 3 }, H: { ord: 3, bits: 2 } };
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function numDataCodewords(ver, ecl) {
  const o = ECL[ecl].ord;
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[o][ver] * NUM_ERROR_CORRECTION_BLOCKS[o][ver];
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

export function encodeQr(text, eclName = 'M') {
  const ecl = ECL[eclName] ? eclName : null;
  if (!ecl) throw new ToolError('"ecc" harus L, M, Q atau H / must be L, M, Q or H.');
  const data = [...Buffer.from(text, 'utf8')];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const ccBits = ver <= 9 ? 8 : 16;
    if (4 + ccBits + data.length * 8 <= numDataCodewords(ver, ecl) * 8) break;
  }
  if (ver > 40) throw new ToolError('Data terlalu panjang untuk satu QR code / data too long for one QR code.');
  const capacity = numDataCodewords(ver, ecl) * 8;
  // bit stream: byte mode 0100, count, data, terminator, pad
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0x4, 4);
  push(data.length, ver <= 9 ? 8 : 16);
  for (const b of data) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // error correction + interleave
  const o = ECL[ecl].ord;
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[o][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[o][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const div = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = codewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => { if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) all.push(block[i]); });
  }
  if (all.length !== rawCodewords) throw new Error('internal: codeword count mismatch');

  // matrix
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = alignmentPositions(ver);
  const n = al.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = mask => {
    const dataBits = (ECL[ecl].bits << 3) | mask;
    let rem = dataBits;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fb = ((dataBits << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(fb, i));
    setFn(8, 7, getBit(fb, 6));
    setFn(8, 8, getBit(fb, 7));
    setFn(7, 8, getBit(fb, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(fb, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(fb, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(fb, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(vb, i);
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }
  // codewords in zigzag
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && bi < all.length * 8) {
          modules[y][x] = getBit(all[bi >>> 3], 7 - (bi & 7));
          bi++;
        }
      }
    }
  }
  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = m => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskFn[m](x, y)) modules[y][x] = !modules[y][x];
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const s = penalty(modules, size);
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(m);
  }
  applyMask(best);
  drawFormat(best);
  return { version: ver, ecc: ecl, mask: best, size, modules };
}

function penalty(m, size) {
  let score = 0;
  const lineScore = get => {
    // N1: runs of 5+ same colour; N3: 1:1:3:1:1 finder-like pattern with 4 light modules on one side
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) score += 3 + run - 5; run = 1; }
      }
      if (run >= 5) score += 3 + run - 5;
      for (let b = 0; b + 10 < size + 4; b++) {
        // treat outside of the symbol as light
        const at = k => (k >= 0 && k < size ? get(a, k) : false);
        const core = at(b) && !at(b + 1) && at(b + 2) && at(b + 3) && at(b + 4) && !at(b + 5) && at(b + 6);
        if (!core) continue;
        const before = !at(b - 1) && !at(b - 2) && !at(b - 3) && !at(b - 4);
        const after = !at(b + 7) && !at(b + 8) && !at(b + 9) && !at(b + 10);
        if (before || after) score += 40;
      }
    }
  };
  lineScore((y, x) => m[y][x]);
  lineScore((x, y) => m[y][x]);
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

export function toSvg(qr, { modulePx = 8, margin = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const dim = qr.size + margin * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let w = 1;
      while (x + w < qr.size && qr.modules[y][x + w]) w++;
      d += `M${x + margin} ${y + margin}h${w}v1h-${w}z`;
      x += w;
    }
  }
  const px = dim * modulePx;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

function qrisToSvg(args) {
  const a = analyze(args.qris);
  if (a.errors) {
    const list = a.problems.filter(p => p.level === 'error').map(p => `- [${p.code}] ${p.message}`).join('\n');
    throw new ToolError('QRIS tidak valid, QR code tidak dibuat (kode rusak tidak akan bisa dibayar). / The QRIS is invalid, so no QR code was made.\n' + list);
  }
  const ecc = args.ecc === undefined ? 'M' : String(args.ecc).toUpperCase();
  const modulePx = intArg(args.module_px, 'module_px', 8, 1, 40);
  const margin = intArg(args.margin, 'margin', 4, 0, 16);
  const dark = colorArg(args.dark_color, 'dark_color', '#000000');
  const light = colorArg(args.light_color, 'light_color', '#ffffff');
  const qr = encodeQr(a.payload, ecc);
  const svg = toSvg(qr, { modulePx, margin, dark, light });
  const notes = [];
  if (margin < 4) notes.push('Margin < 4 modul: beberapa pemindai butuh quiet zone 4 modul / margin below 4 modules can hurt scanning.');
  notes.push('Selalu uji scan dengan aplikasi pembayaran sebelum dicetak, lalu bayar nominal kecil dulu / always test-scan before printing and pay a small amount first.');
  return { svg, version: qr.version, ecc: qr.ecc, mask: qr.mask, modules: qr.size, pixels: (qr.size + margin * 2) * modulePx, type: a.summary.type, merchant_name: a.summary.merchant_name, amount: a.summary.amount, notes };
}

function intArg(v, name, dflt, min, max) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`"${name}" harus bilangan bulat ${min}-${max} / must be an integer ${min}-${max}.`);
  return n;
}

function colorArg(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) throw new ToolError(`"${name}" harus warna hex #rrggbb / must be a #rrggbb colour.`);
  return String(v);
}

// ---------- tools ----------

const QRIS_PROP = { type: 'string', description: 'The QRIS payload text (starts with "000201" and ends with "6304" + 4 hex characters). Paste text, not an image.' };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'parse_qris',
    title: 'Baca QRIS / Parse QRIS',
    description: 'Membongkar teks QRIS menjadi field bernama. Decodes a QRIS / EMVCo merchant-presented QR payload into named fields: static or dynamic, '
      + 'merchant accounts (tags 26-51, incl. NMID in the national QRIS template), MCC, currency, amount, tip/fee, country, merchant name/city, '
      + 'postal code, additional data (tag 62), language template and the CRC check. Offline, nothing is sent anywhere.',
    inputSchema: { type: 'object', properties: { qris: QRIS_PROP }, required: ['qris'] },
    annotations: { title: 'Parse QRIS', ...RO },
  },
  {
    name: 'validate_qris',
    title: 'Validasi QRIS / Validate QRIS',
    description: 'Memeriksa struktur dan CRC QRIS. Validates a QRIS payload: TLV structure, mandatory fields, value formats and the CRC-16/CCITT (init 0xFFFF) checksum. '
      + 'Reports every problem found (errors and warnings) with a code and a fix hint. Offline.',
    inputSchema: { type: 'object', properties: { qris: QRIS_PROP }, required: ['qris'] },
    annotations: { title: 'Validate QRIS', ...RO },
  },
  {
    name: 'set_qris_amount',
    title: 'QRIS statis jadi dinamis / Set QRIS amount',
    description: 'Mengubah QRIS STATIS menjadi DINAMIS dengan nominal Rupiah. Turns a valid STATIC QRIS into a DYNAMIC one with a fixed amount in whole Rupiah: '
      + 'sets tag 01 to 12, inserts tag 54, optionally adds a tip/fee (tags 55-57, off by default) and recomputes the CRC. '
      + 'Refuses invalid or already-dynamic input. This only rewrites text: it does not move money, and the result is only as valid as the merchant\'s static code.',
    inputSchema: {
      type: 'object',
      properties: {
        qris: { ...QRIS_PROP, description: 'The merchant\'s own STATIC QRIS payload text.' },
        amount: { type: ['integer', 'string'], description: 'Amount in whole Rupiah, e.g. 15000 or "15.000". Max 13 digits.' },
        tip: { type: 'string', enum: ['none', 'prompt', 'fixed', 'percent'], default: 'none', description: 'Tip/convenience fee: none (default), prompt (payer types a tip, 55=01), fixed (55=02 + 56), percent (55=03 + 57).' },
        tip_value: { type: ['number', 'string'], description: 'For tip=fixed: whole Rupiah. For tip=percent: 0.01-99.99.' },
        allow_dynamic_input: { type: 'boolean', default: false, description: 'Allow a QRIS that is already dynamic (its amount is replaced). Off by default because dynamic codes are usually single-use.' },
      },
      required: ['qris', 'amount'],
    },
    annotations: { title: 'Set QRIS amount', ...RO },
  },
  {
    name: 'qris_to_svg',
    title: 'QRIS ke gambar SVG / QRIS to SVG',
    description: 'Membuat gambar QR code (SVG) dari teks QRIS yang valid. Renders a valid QRIS payload as an SVG QR code (byte mode, error correction L/M/Q/H, default M). '
      + 'Built-in encoder, no dependencies, offline. Refuses invalid QRIS. Always test-scan the result before printing.',
    inputSchema: {
      type: 'object',
      properties: {
        qris: QRIS_PROP,
        ecc: { type: 'string', enum: ['L', 'M', 'Q', 'H'], default: 'M', description: 'Error correction level (default M).' },
        module_px: { type: 'integer', minimum: 1, maximum: 40, default: 8, description: 'Pixels per module (width/height attributes only; the SVG scales).' },
        margin: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'Quiet zone in modules (4 recommended).' },
        dark_color: { type: 'string', description: 'Module colour #rrggbb (default #000000). Keep strong contrast.' },
        light_color: { type: 'string', description: 'Background colour #rrggbb (default #ffffff).' },
      },
      required: ['qris'],
    },
    annotations: { title: 'QRIS to SVG', ...RO },
  },
];

function publicAnalysis(a) {
  return { valid: a.valid, errors: a.errors, warnings: a.warnings, crc: a.crc, summary: a.summary, fields: a.tree, problems: a.problems };
}

async function callTool(name, args) {
  if (name === 'parse_qris') return json(publicAnalysis(analyze(args.qris)));
  if (name === 'validate_qris') {
    const a = analyze(args.qris);
    const verdict = a.valid
      ? (a.warnings ? `VALID dengan ${a.warnings} peringatan / valid with ${a.warnings} warning(s)` : 'VALID: struktur dan CRC benar / structure and CRC are correct')
      : `TIDAK VALID: ${a.errors} error, ${a.warnings} peringatan / INVALID: ${a.errors} error(s), ${a.warnings} warning(s)`;
    return json({ valid: a.valid, verdict, errors: a.errors, warnings: a.warnings, crc: a.crc, type: a.summary.type, length: a.chars.length, problems: a.problems });
  }
  if (name === 'set_qris_amount') return json(setAmount(args));
  if (name === 'qris_to_svg') {
    const r = qrisToSvg(args);
    const { svg, ...meta } = r;
    return { content: [{ type: 'text', text: svg }, { type: 'text', text: JSON.stringify(meta, null, 2) }], structuredContent: r };
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

function json(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

function textResult(t, isError = false) {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!isRequest) return;
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcp-qris', title: 'QRIS tools (offline)', version: VERSION },
          instructions: 'Offline QRIS tools. parse_qris and validate_qris read a pasted QRIS payload; set_qris_amount turns the merchant\'s own static QRIS '
            + 'into a dynamic one with an amount; qris_to_svg renders a valid payload as an SVG QR code. Nothing moves money and nothing leaves the machine. '
            + 'Never use someone else\'s QRIS without permission, and test with a small amount.',
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'resources/list': result = { resources: [] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${clip(String(name))}` } });
          return;
        }
        try {
          result = await callTool(name, (params && typeof params.arguments === 'object' && params.arguments) || {});
        } catch (e) {
          if (!(e instanceof ToolError)) log('tool failed:', (e && e.stack) || e);
          result = textResult(e instanceof ToolError ? e.message : 'Terjadi kesalahan / Unexpected error: ' + (e && e.message), true);
        }
        break;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${clip(method)}` } });
        return;
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    log('request failed:', (e && e.stack) || e);
    send({ jsonrpc: '2.0', id, error: { code: e.rpcCode || -32603, message: e.message || 'Internal error' } });
  }
}

function main() {
  log(`v${VERSION} ready (offline, no network, no file writes)`);
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
      return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      const p = handle(m && typeof m === 'object' ? m : {}).catch(e => log('fatal handler error:', (e && e.stack) || e));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main();
