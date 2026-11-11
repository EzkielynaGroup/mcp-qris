// Tests for mcp-qris: unit tests on the exported helpers plus end-to-end tests over MCP stdio.
// Every QRIS payload here is SYNTHETIC (fake merchant, fake NMID, fake PAN) and built in this file.
// No network, no real merchant data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc16, analyze, setAmount, withCrc, encodeQr, toSvg, numDataCodewords } from '../mcp-qris.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-qris.mjs');

// ---------- synthetic payload builder ----------
const tlv = (id, v) => id + String(Array.from(v).length).padStart(2, '0') + v;
const MAI26 = tlv('26', tlv('00', 'ID.CO.CONTOH.WWW') + tlv('01', '9360000000000000017') + tlv('02', '000000000000001') + tlv('03', 'UMI'));
const MAI51 = tlv('51', tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'ID1020000000001') + tlv('03', 'UMI'));
// parts: { id: value } overrides; undefined/false removes a field; new IDs are appended in ascending order before 63.
// (A Map keeps "00"/"01" first: plain objects would move integer-like keys such as "26" ahead of them.)
function build(parts = {}) {
  const d = new Map([
    ['00', '01'], ['01', '11'], ['26', null], ['51', null], ['52', '5812'], ['53', '360'], ['58', 'ID'],
    ['59', 'TOKO CONTOH'], ['60', 'JAKARTA'], ['61', '10110'], ['62', tlv('07', 'KASIR01')],
  ]);
  const extra = Object.keys(parts).filter(k => !d.has(k)).sort();
  for (const [k, v] of Object.entries(parts)) if (d.has(k)) d.set(k, v);
  for (const k of extra) d.set(k, parts[k]);
  let body = '';
  for (const [id, v] of d) {
    if (v === undefined) continue;
    if (id === '26' && v === null) { body += MAI26; continue; }
    if (id === '51' && v === null) { body += MAI51; continue; }
    if (v === false) continue;
    body += tlv(id, v);
  }
  return withCrc(body);
}
const STATIC = build();
// Same layout but the CRC is replaced by an arbitrary value.
const fixCrc = (p, crc) => p.slice(0, -4) + crc;
const codes = a => a.problems.map(p => p.code);

// EMVCo MPM v1.1 Annex B example payload (EMVCo's own sample; includes UTF-8 characters in template 64).
const EMVCO_EXAMPLE = '00020101021229300012D156000000000510A93FO3230Q31280012D15600000001030812345678520441115802CN5914BEST TRANSPORT6007BEIJING64200002ZH0104最佳运输0202北京540523.7253031565502016233030412340603***0708A60086670902ME91320016A0112233449988770708123456786304A13A';

// ---------- CRC ----------
test('crc16: CRC-16/CCITT-FALSE known vectors', () => {
  assert.equal(crc16('123456789'), '29B1'); // standard check value for poly 0x1021, init 0xFFFF
  assert.equal(crc16(''), 'FFFF');
  assert.equal(crc16('A'), 'B915');
  assert.equal(crc16(Buffer.from('123456789')), '29B1');
  // EMVCo Annex B: CRC over UTF-8 bytes of everything up to and including "6304"
  assert.equal(crc16(EMVCO_EXAMPLE.slice(0, -4)), 'A13A');
  assert.match(crc16('x'), /^[0-9A-F]{4}$/);
});

// ---------- parse ----------
test('analyze: synthetic static QRIS is valid and fully decoded', () => {
  const a = analyze(STATIC);
  assert.equal(a.valid, true, JSON.stringify(a.problems));
  assert.deepEqual(a.problems, []);
  const s = a.summary;
  assert.equal(s.type, 'static');
  assert.equal(s.payload_format, '01');
  assert.equal(s.nmid, 'ID1020000000001');
  assert.equal(s.merchant_name, 'TOKO CONTOH');
  assert.equal(s.merchant_city, 'JAKARTA');
  assert.equal(s.postal_code, '10110');
  assert.equal(s.country, 'ID');
  assert.equal(s.merchant_category_code, '5812');
  assert.deepEqual(s.currency, { code: '360', meaning: 'IDR (Rupiah)' });
  assert.equal(s.amount, null);
  assert.deepEqual(s.additional_data, { terminal_label: 'KASIR01' });
  assert.equal(s.merchant_accounts.length, 2);
  assert.deepEqual(s.merchant_accounts[0], { tag: '26', gui: 'ID.CO.CONTOH.WWW', is_national_qris: false, merchant_pan: '9360000000000000017', merchant_id: '000000000000001', merchant_criteria: { code: 'UMI', meaning: 'Usaha Mikro (micro)' } });
  assert.equal(s.merchant_accounts[1].nmid, 'ID1020000000001');
  assert.equal(s.crc.match, true);
  const t51 = a.tree.find(t => t.tag === '51');
  assert.equal(t51.children.find(c => c.tag === '02').name, 'NMID (National Merchant ID)');
  assert.equal(a.tree.find(t => t.tag === '62').children[0].name, 'Terminal Label');
});

test('analyze: EMVCo Annex B example (UTF-8, language template, tip prompt, unreserved template)', () => {
  const a = analyze(EMVCO_EXAMPLE);
  assert.equal(a.valid, true, JSON.stringify(a.problems));
  assert.equal(a.crc.computed, 'A13A');
  assert.deepEqual(codes(a).sort(), ['COUNTRY_NOT_ID', 'CURRENCY_NOT_IDR', 'NO_QRIS_ID']);
  const s = a.summary;
  assert.equal(s.type, 'dynamic');
  assert.equal(s.amount, '23.72');
  assert.equal(s.tip_or_convenience.code, '01');
  assert.deepEqual(s.language_template, { '00': 'ZH', '01': '最佳运输', '02': '北京' });
  assert.deepEqual(s.additional_data, { store_label: '1234', customer_label: '***', terminal_label: 'A6008667', additional_consumer_data_request: 'ME' });
  assert.equal(a.tree.find(t => t.tag === '91').name, 'Unreserved Template');
});

test('analyze: whitespace around the payload is ignored', () => {
  assert.equal(analyze(`  \n${STATIC}\n `).valid, true);
});

// ---------- malformed inputs ----------
test('validate: CRC problems', () => {
  const bad = fixCrc(STATIC, STATIC.slice(-4) === '0000' ? '0001' : '0000');
  const a = analyze(bad);
  assert.equal(a.valid, false);
  assert.deepEqual(codes(a), ['CRC_MISMATCH']);
  assert.equal(a.crc.computed, STATIC.slice(-4));
  const lower = STATIC.slice(0, -4) + STATIC.slice(-4).toLowerCase();
  if (lower !== STATIC) assert.ok(codes(analyze(lower)).includes('CRC_LOWERCASE'));
  // one changed character in the merchant name breaks the CRC
  assert.ok(codes(analyze(STATIC.replace('TOKO CONTOH', 'TOKO CONTOX'))).includes('CRC_MISMATCH'));
  // CRC tag missing entirely
  const noCrc = STATIC.slice(0, -8);
  assert.ok(codes(analyze(noCrc)).includes('CRC_MISSING'));
  // CRC not last
  const body = STATIC.slice(0, -8);
  const crcFirst = withCrc(body).slice(-8);
  const moved = analyze(body.slice(0, 6) + crcFirst + body.slice(6));
  assert.ok(codes(moved).includes('CRC_NOT_LAST'));
  // wrong CRC length
  assert.ok(codes(analyze(body + '630300A')).includes('CRC_LENGTH'));
  assert.ok(codes(analyze(body + '6304ZZZZ')).includes('CRC_FORMAT'));
});

test('validate: broken TLV structure is reported, not thrown', () => {
  const t = analyze(STATIC.slice(0, 60));
  assert.equal(t.valid, false);
  assert.ok(codes(t).includes('TRUNCATED'));
  assert.ok(codes(t).includes('CHECKS_SKIPPED'));
  assert.ok(!codes(t).includes('MCC_MISSING'), 'no missing-field noise after a break');
  assert.ok(codes(analyze('0002010X0211')).includes('BAD_ID'));
  assert.ok(codes(analyze('000201010X11')).includes('BAD_LENGTH'));
  assert.ok(codes(analyze('00020101')).includes('TRUNCATED'));
  assert.ok(codes(analyze('000')).includes('TRUNCATED'));
  assert.ok(codes(analyze(withCrc('0002015200' + '53033605802ID'))).includes('ZERO_LENGTH'));
  assert.ok(codes(analyze('hello world, this is not a qris')).includes('BAD_ID'));
});

test('validate: field rules', () => {
  const has = (p, code) => assert.ok(codes(analyze(p)).includes(code), `${code} expected in ${JSON.stringify(codes(analyze(p)))}`);
  has(build({ '00': '02' }), 'PFI_VALUE');
  has(withCrc(STATIC.slice(6, -8)), 'PFI_NOT_FIRST');
  has(build({ '01': '13' }), 'POI_VALUE');
  has(build({ '01': undefined }), 'POI_MISSING');
  has(build({ '52': '58A2' }), 'MCC_FORMAT');
  has(build({ '52': undefined }), 'MCC_MISSING');
  has(build({ '53': '36' }), 'CURRENCY_FORMAT');
  has(build({ '53': '840' }), 'CURRENCY_NOT_IDR');
  has(build({ '54': '10,000' }), 'AMOUNT_FORMAT');
  has(build({ '54': '10 000' }), 'AMOUNT_FORMAT');
  has(build({ '54': '0' }), 'AMOUNT_ZERO');
  has(build({ '54': '0.00' }), 'AMOUNT_ZERO');
  has(build({ '54': '12345678901234' }), 'AMOUNT_LENGTH');
  has(build({ '54': '5000' }), 'STATIC_WITH_AMOUNT');
  has(build({ '01': '12' }), 'DYNAMIC_WITHOUT_AMOUNT');
  has(build({ '01': '12', '54': '15000000' }), 'AMOUNT_OVER_LIMIT');
  has(build({ '55': '04' }), 'TIP_VALUE');
  has(build({ '55': '02' }), 'FEE_FIXED_MISSING');
  has(build({ '56': '1000' }), 'FEE_FIXED_UNEXPECTED');
  has(build({ '55': '02', '56': '0' }), 'FEE_FIXED_FORMAT');
  has(build({ '55': '03' }), 'FEE_PERCENT_MISSING');
  has(build({ '57': '5' }), 'FEE_PERCENT_UNEXPECTED');
  has(build({ '55': '03', '57': '100' }), 'FEE_PERCENT_FORMAT');
  has(build({ '55': '03', '57': '5%' }), 'FEE_PERCENT_FORMAT');
  has(build({ '58': 'IDN' }), 'COUNTRY_FORMAT');
  has(build({ '58': 'MY' }), 'COUNTRY_NOT_ID');
  has(build({ '58': undefined }), 'COUNTRY_MISSING');
  has(build({ '59': 'A'.repeat(26) }), '59_LENGTH');
  has(build({ '59': 'Toko Ñandú' }), '59_CHARSET');
  has(build({ '59': undefined }), '59_MISSING');
  has(build({ '60': 'KOTA YANG SANGAT PANJANG' }), '60_LENGTH');
  has(build({ '60': undefined }), '60_MISSING');
  has(build({ '61': '12345678901' }), '61_LENGTH');
  has(build({ '62': tlv('09', 'MX') }), 'ADDITIONAL_09');
  has(build({ '62': tlv('09', 'MM') }), 'ADDITIONAL_09');
  has(build({ '62': tlv('11', '999') }), 'ADDITIONAL_11');
  has(build({ '62': tlv('01', 'B'.repeat(26)) }), 'ADDITIONAL_LENGTH');
  has(build({ '62': tlv('20', 'X') }), 'RFU_ID');
  has(build({ '62': tlv('50', tlv('01', 'X')) }), 'GUI_MISSING');
  has(build({ '64': tlv('00', 'ID') }), 'LANG_01_MISSING');
  has(build({ '64': tlv('01', 'TOKO') }), 'LANG_00_MISSING');
  has(build({ '64': tlv('00', 'I1') + tlv('01', 'TOKO') }), 'LANG_00_FORMAT');
  has(build({ '70': 'X' }), 'RFU_ID');
  has(build({ '80': tlv('01', 'X') }), 'GUI_MISSING');
  has(build({ '26': tlv('01', '123') }), 'GUI_MISSING');
  has(build({ '51': tlv('00', 'ID.CO.QRIS.WWW') + tlv('03', 'UMI') }), 'NMID_MISSING');
  has(build({ '51': tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'XX12') }), 'NMID_FORMAT');
  has(build({ '51': tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'ID1020000000001') + tlv('03', 'ABC') }), 'CRITERIA_UNKNOWN');
  has(build({ '51': false }), 'NO_QRIS_ID');
  has(build({ '26': false, '51': false }), 'NO_MERCHANT_ACCOUNT');
  has(STATIC.slice(0, 20) + '\n' + STATIC.slice(20), 'CONTROL_CHAR');
  has(build({ '81': tlv('00', 'X'.repeat(33)) }), 'GUI_FORMAT');
  // duplicate root ID
  has(withCrc(STATIC.slice(0, -8) + tlv('52', '5812')), 'DUPLICATE_ID');
  // > 512 characters is only a warning
  const long = build({ '80': tlv('00', 'COM.EXAMPLE') + tlv('01', 'X'.repeat(80)), '81': tlv('00', 'COM.EXAMPLE') + tlv('01', 'X'.repeat(80)), '82': tlv('00', 'COM.EXAMPLE') + tlv('01', 'X'.repeat(80)), '83': tlv('00', 'COM.EXAMPLE') + tlv('01', 'X'.repeat(80)), '84': tlv('00', 'COM.EXAMPLE') + tlv('01', 'X'.repeat(80)) });
  const la = analyze(long);
  assert.ok(codes(la).includes('LONG_PAYLOAD'));
  assert.equal(la.valid, true);
});

test('analyze: input guards', () => {
  assert.throws(() => analyze(''), /kosong/);
  assert.throws(() => analyze('   '), /kosong/);
  assert.throws(() => analyze(123), /string/);
  assert.throws(() => analyze(undefined), /string/);
  assert.throws(() => analyze('0'.repeat(3000)), /terlalu panjang/);
});

// ---------- set amount ----------
test('setAmount: static -> dynamic with amount, CRC recomputed, tag order kept', () => {
  const r = setAmount({ qris: STATIC, amount: 25000 });
  const a = analyze(r.qris);
  assert.equal(a.valid, true, JSON.stringify(a.problems));
  assert.deepEqual(a.problems, []);
  assert.equal(a.summary.type, 'dynamic');
  assert.equal(a.summary.amount, '25000');
  assert.equal(r.amount, 25000);
  assert.equal(r.amount_formatted, 'Rp25.000');
  assert.equal(r.crc, crc16(r.qris.slice(0, -4)));
  assert.equal(r.qris.slice(-8, -4), '6304');
  // only 01, 54 and CRC change
  assert.equal(r.qris, withCrc(STATIC.slice(0, -8).replace('010211', '010212').replace('5303360', '5303360540525000')));
  assert.ok(a.rootItems.map(x => x.id).join(',').includes('53,54,58'));
  // the dynamic result keeps every merchant field
  for (const k of ['nmid', 'merchant_name', 'merchant_city', 'postal_code', 'merchant_category_code']) assert.deepEqual(a.summary[k], analyze(STATIC).summary[k]);
});

test('setAmount: amount formats and rejections', () => {
  for (const v of [15000, '15000', '15.000', 'Rp 15.000', 'Rp15.000,-', 'IDR 15000', '015000', '15.000,00']) {
    assert.equal(analyze(setAmount({ qris: STATIC, amount: v }).qris).summary.amount, '15000', String(v));
  }
  assert.equal(analyze(setAmount({ qris: STATIC, amount: 1 }).qris).summary.amount, '1');
  assert.equal(analyze(setAmount({ qris: STATIC, amount: 9999999999999 }).qris).summary.amount, '9999999999999');
  for (const v of [0, -5, 1.5, '1,5', 'abc', '', null, undefined, '15.00', 10000000000000, '0', NaN, Infinity, {}, []]) {
    assert.throws(() => setAmount({ qris: STATIC, amount: v }), /amount/, String(v));
  }
});

test('setAmount: refuses invalid or dynamic sources', () => {
  assert.throws(() => setAmount({ qris: fixCrc(STATIC, '0000'), amount: 1000 }), /tidak valid[\s\S]*CRC_MISMATCH/);
  assert.throws(() => setAmount({ qris: STATIC.slice(0, 40), amount: 1000 }), /tidak valid/);
  const dyn = setAmount({ qris: STATIC, amount: 1000 }).qris;
  assert.throws(() => setAmount({ qris: dyn, amount: 2000 }), /sudah dinamis/);
  const again = setAmount({ qris: dyn, amount: 2000, allow_dynamic_input: true });
  assert.equal(analyze(again.qris).summary.amount, '2000');
  assert.ok(again.changes.some(c => c.includes('nominal lama "1000"')));
});

test('setAmount: tip / convenience fee options (off by default)', () => {
  assert.equal(analyze(setAmount({ qris: STATIC, amount: 1000 }).qris).summary.tip_or_convenience, null);
  const p = analyze(setAmount({ qris: STATIC, amount: 1000, tip: 'prompt' }).qris);
  assert.equal(p.valid, true);
  assert.equal(p.summary.tip_or_convenience.code, '01');
  const f = analyze(setAmount({ qris: STATIC, amount: 1000, tip: 'fixed', tip_value: '2.500' }).qris);
  assert.equal(f.valid, true);
  assert.equal(f.summary.tip_or_convenience.fixed_fee, '2500');
  const c = analyze(setAmount({ qris: STATIC, amount: 1000, tip: 'percent', tip_value: '2,5%' }).qris);
  assert.equal(c.valid, true);
  assert.equal(c.summary.tip_or_convenience.percentage_fee, '2.5');
  assert.ok(c.rootItems.map(x => x.id).join(',').includes('53,54,55,57,58'));
  assert.throws(() => setAmount({ qris: STATIC, amount: 1000, tip: 'percent', tip_value: 0 }), /tip_value/);
  assert.throws(() => setAmount({ qris: STATIC, amount: 1000, tip: 'percent', tip_value: 100 }), /tip_value/);
  assert.throws(() => setAmount({ qris: STATIC, amount: 1000, tip: 'percent', tip_value: 1.234 }), /tip_value/);
  assert.throws(() => setAmount({ qris: STATIC, amount: 1000, tip: 'fixed' }), /tip_value/);
  assert.throws(() => setAmount({ qris: STATIC, amount: 1000, tip_value: 5 }), /tip_value/);
  assert.throws(() => setAmount({ qris: STATIC, amount: 1000, tip: 'gratis' }), /tip/);
  // a source with an old tip is cleaned when the amount is replaced
  const withTip = setAmount({ qris: STATIC, amount: 1000, tip: 'fixed', tip_value: 500 }).qris;
  const replaced = analyze(setAmount({ qris: withTip, amount: 3000, allow_dynamic_input: true }).qris);
  assert.equal(replaced.summary.tip_or_convenience, null);
  assert.equal(replaced.valid, true);
});

test('setAmount: missing point-of-initiation is added right after tag 00; big amounts warn', () => {
  const noPoi = build({ '01': undefined });
  const r = setAmount({ qris: noPoi, amount: 5000 });
  assert.ok(r.qris.startsWith('000201010212'));
  assert.equal(analyze(r.qris).valid, true);
  const big = setAmount({ qris: STATIC, amount: 12000000 });
  assert.ok(big.warnings.some(w => w.includes('AMOUNT_OVER_LIMIT')));
  assert.ok(big.notes.some(n => n.includes('10.000.000')));
});

// ---------- QR encoder ----------
const matrixHash = qr => crypto.createHash('sha256').update(qr.modules.map(r => r.map(c => (c ? '1' : '0')).join('')).join('\n')).digest('hex');

test('encodeQr: capacities match the ISO/IEC 18004 byte-mode table', () => {
  const known = { 1: [17, 14, 11, 7], 2: [32, 26, 20, 14], 5: [106, 84, 60, 44], 10: [271, 213, 151, 119], 20: [858, 666, 482, 382], 40: [2953, 2331, 1663, 1273] };
  for (const [v, caps] of Object.entries(known)) {
    ['L', 'M', 'Q', 'H'].forEach((e, i) => {
      const bytes = Math.floor((numDataCodewords(Number(v), e) * 8 - 4 - (Number(v) <= 9 ? 8 : 16)) / 8);
      assert.equal(bytes, caps[i], `v${v}-${e}`);
    });
  }
  assert.equal(encodeQr('A'.repeat(14), 'M').version, 1);
  assert.equal(encodeQr('A'.repeat(15), 'M').version, 2);
  assert.equal(encodeQr('A'.repeat(2953), 'L').version, 40);
  assert.throws(() => encodeQr('A'.repeat(2954), 'L'), /terlalu panjang/);
  assert.throws(() => encodeQr('x', 'Z'), /ecc/);
});

// Golden matrices. These exact symbols were decoded back to the input with two independent decoders
// (macOS CoreImage CIDetector and Vision VNDetectBarcodesRequest) when the encoder was written, together with
// 268 other symbols covering versions 1-40, levels L/M/Q/H and all 8 masks (see tools/verify-macos.mjs).
test('encodeQr: golden matrices', () => {
  const dyn = setAmount({ qris: STATIC, amount: 25000 }).qris;
  const cases = [
    [STATIC, 'M', 10, 2, '8b7ce883ca330141952ddd823d70e4f2f8096c4d2c1a25c7575f5edc021ea87c'],
    [dyn, 'H', 16, 2, '8af7335648a9f0933d721b8245b571d5cd93b7797b8326f981d617e4408e24ba'],
    ['HELLO WORLD', 'Q', 1, 3, '7dde2e7cd1825ca01e2991318140b079bc9f0f4d8bfd00a2cdabb866129495ac'],
  ];
  for (const [text, ecc, ver, mask, hash] of cases) {
    const qr = encodeQr(text, ecc);
    assert.equal(qr.version, ver);
    assert.equal(qr.mask, mask);
    assert.equal(matrixHash(qr), hash, `${ecc} v${ver}`);
  }
});

test('encodeQr: structure (finders, timing, dark module, format + version info)', () => {
  for (const [text, ecc] of [['x', 'L'], [STATIC, 'M'], ['Z'.repeat(400), 'Q'], ['Y'.repeat(1000), 'H']]) {
    const qr = encodeQr(text, ecc);
    const { size, modules: m } = qr;
    assert.equal(size, qr.version * 4 + 17);
    const finderOk = (cx, cy) => {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        assert.equal(m[cy + dy][cx + dx], d !== 2, `finder at ${cx},${cy}`);
      }
    };
    finderOk(3, 3); finderOk(size - 4, 3); finderOk(3, size - 4);
    for (let i = 8; i < size - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
    assert.equal(m[size - 8][8], true, 'dark module');
    // format info, first copy: bits 0-5 at (8,0..5), 6 at (8,7), 7 at (8,8), 8 at (7,8), 9-14 at (5..0, 8)
    let fb = 0;
    const bitAt = (x, y) => (m[y][x] ? 1 : 0);
    const pos = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    pos.forEach(([x, y], i) => { fb |= bitAt(x, y) << i; });
    fb ^= 0x5412;
    const eclBits = { L: 1, M: 0, Q: 3, H: 2 }[ecc];
    assert.equal(fb >>> 13, eclBits, 'ecc level in format info');
    assert.equal((fb >>> 10) & 7, qr.mask, 'mask in format info');
    let rem = fb >>> 10;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(fb & 0x3ff, rem & 0x3ff, 'format BCH');
    // second copy equals the first
    let fb2 = 0;
    for (let i = 0; i < 8; i++) fb2 |= bitAt(size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) fb2 |= bitAt(8, size - 15 + i) << i;
    assert.equal(fb2 ^ 0x5412, fb);
    if (qr.version >= 7) {
      let vb = 0;
      for (let i = 0; i < 18; i++) vb |= bitAt(size - 11 + (i % 3), Math.floor(i / 3)) << i;
      assert.equal(vb >>> 12, qr.version);
    }
  }
});

test('toSvg: well-formed, scalable, quiet zone and colours', () => {
  const qr = encodeQr('x', 'M');
  const svg = toSvg(qr, { modulePx: 10, margin: 4, dark: '#112233', light: '#fefefe' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29" width="290" height="290"/);
  assert.match(svg, /fill="#112233"/);
  assert.match(svg, /<rect width="29" height="29" fill="#fefefe"\/>/);
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(!/NaN|undefined/.test(svg));
  // every dark module is covered exactly once by the run-length path
  let area = 0;
  for (const mm of svg.matchAll(/M(\d+) (\d+)h(\d+)/g)) area += Number(mm[3]);
  assert.equal(area, qr.modules.flat().filter(Boolean).length);
});

// ---------- MCP over stdio ----------
function startMcp() {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map();
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  const request = (method, params, raw) => new Promise((resolve, reject) => {
    const id = raw ? null : nextId++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    waiting.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write((raw || JSON.stringify({ jsonrpc: '2.0', id, method, params })) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const stop = () => new Promise(r => { if (child.exitCode !== null) return r(); child.on('exit', r); child.stdin.end(); });
  const kill = () => { if (child.exitCode === null) child.kill(); };
  return { request, notify, call, stop, kill, stderr: () => stderr };
}
const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

test('mcp: handshake, ping, tools/list, unknown method/tool, parse error', async t => {
  const mcp = startMcp();
  t.after(mcp.kill);
  const init = await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'mcp-qris');
  assert.ok(init.result.capabilities.tools);
  mcp.notify('notifications/initialized');
  assert.equal((await mcp.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.deepEqual((await mcp.request('ping')).result, {});
  const list = (await mcp.request('tools/list', {})).result.tools;
  assert.deepEqual(list.map(t => t.name).sort(), ['parse_qris', 'qris_to_svg', 'set_qris_amount', 'validate_qris']);
  for (const t of list) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.inputSchema.required.includes('qris'));
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, false);
    assert.ok(t.description.length > 40);
  }
  assert.equal((await mcp.request('no/such')).error.code, -32601);
  assert.equal((await mcp.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await mcp.request(null, null, '{not json')).error.code, -32700);
  await mcp.stop();
  assert.match(mcp.stderr(), /ready/);
});

test('mcp: every tool end to end, errors as isError', async t => {
  const mcp = startMcp();
  t.after(mcp.kill);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const p = await mcp.call('parse_qris', { qris: STATIC });
  assert.ok(!p.isError);
  assert.equal(p.structuredContent.summary.nmid, 'ID1020000000001');
  assert.equal(JSON.parse(textOf(p)).valid, true);

  const v = await mcp.call('validate_qris', { qris: fixCrc(STATIC, '0000') });
  assert.equal(v.structuredContent.valid, false);
  assert.match(v.structuredContent.verdict, /TIDAK VALID/);
  assert.equal(v.structuredContent.problems[0].code, 'CRC_MISMATCH');
  const ok = await mcp.call('validate_qris', { qris: STATIC });
  assert.match(ok.structuredContent.verdict, /^VALID/);

  const s = await mcp.call('set_qris_amount', { qris: STATIC, amount: '10.000' });
  assert.ok(!s.isError, textOf(s));
  assert.equal(analyze(s.structuredContent.qris).summary.amount, '10000');
  assert.ok(s.structuredContent.notes.join(' ').includes('never moves money'));

  const svg = await mcp.call('qris_to_svg', { qris: s.structuredContent.qris, ecc: 'q', module_px: 5, margin: 4 });
  assert.ok(!svg.isError, textOf(svg));
  assert.ok(svg.content[0].text.startsWith('<svg'));
  assert.equal(svg.structuredContent.ecc, 'Q');
  assert.equal(svg.structuredContent.pixels, (svg.structuredContent.modules + 8) * 5);

  for (const [tool, args, re] of [
    ['parse_qris', {}, /string/],
    ['parse_qris', { qris: '' }, /kosong/],
    ['set_qris_amount', { qris: STATIC }, /amount/],
    ['set_qris_amount', { qris: fixCrc(STATIC, '0000'), amount: 1000 }, /CRC_MISMATCH/],
    ['qris_to_svg', { qris: fixCrc(STATIC, '0000') }, /tidak valid/],
    ['qris_to_svg', { qris: STATIC, ecc: 'X' }, /ecc/],
    ['qris_to_svg', { qris: STATIC, module_px: 0 }, /module_px/],
    ['qris_to_svg', { qris: STATIC, margin: 99 }, /margin/],
    ['qris_to_svg', { qris: STATIC, dark_color: 'red' }, /dark_color/],
  ]) {
    const r = await mcp.call(tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`);
    assert.match(textOf(r), re);
    assert.ok(!/\bat \w+ \(|node:internal/.test(textOf(r)), 'no stack traces');
  }
  await mcp.stop();
});
