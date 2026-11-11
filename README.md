# mcp-qris

<!-- ezk:badges -->
[![npm](https://img.shields.io/npm/v/mcp-qris?color=c2410c)](https://www.npmjs.com/package/mcp-qris) [![CI](https://github.com/EzkielynaGroup/mcp-qris/actions/workflows/test.yml/badge.svg)](https://github.com/EzkielynaGroup/mcp-qris/actions/workflows/test.yml) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.EzkielynaGroup%2Fmcp--qris-1f6feb)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.EzkielynaGroup/mcp-qris) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
<!-- /ezk:badges -->

An offline [MCP](https://modelcontextprotocol.io) server that lets your AI assistant **read, check and prepare QRIS payment codes** (Indonesia's national QR standard, built on EMVCo Merchant-Presented Mode). No API key, no network, no dependencies.

Example: *"Here is my shop's static QRIS text: `000201010211...6304ABCD`. Is it valid, and can you make a dynamic version for Rp25.000 and give me the SVG?"*

> 🇮🇩 Bahasa Indonesia: lihat [bagian di bawah](#bahasa-indonesia).

> **Read this first.** This tool only reads and rewrites text. **It does not move money**, it cannot see or confirm payments, and it is not connected to any bank or payment provider. A dynamic QRIS made here is only as valid as the merchant's own static QRIS it came from. **Test with a small amount first.** **Never paste or modify someone else's QRIS** without the owner's permission: changing a QRIS to collect money that is not yours is fraud.

- **Offline**: one `.mjs` file, Node.js 18+, no `npm install`, no network calls, no file writes.
- **Input is text**: paste the QRIS payload string (it starts with `000201`). Decoding a photo or screenshot is out of scope; scan it with any QR reader app first.
- **Honest validation**: every problem is reported with a code, never silently "fixed".

## Tools

| Tool | What it does |
|---|---|
| `parse_qris` | Decodes the payload into named fields: payload format, static (11) / dynamic (12), merchant account templates 26-51 (GUI, merchant PAN, merchant ID, **NMID** in the national `ID.CO.QRIS.WWW` template, merchant criteria UMI/UKE/UME/UBE/URE), MCC, currency (360 = IDR), amount, tip/fee (55-57), country, merchant name/city, postal code, additional data (62: bill number, store label, terminal label, ...), language template (64) and the CRC check. |
| `validate_qris` | Checks the TLV structure, mandatory fields, value formats and the CRC-16/CCITT checksum (polynomial 0x1021, initial value 0xFFFF). Reports **every** problem as an error or warning with a code (for example `CRC_MISMATCH`, `TRUNCATED`, `AMOUNT_FORMAT`). |
| `set_qris_amount` | Turns a valid **static** QRIS into a **dynamic** one with an amount in whole Rupiah: sets tag 01 to `12`, inserts tag 54 right after the currency, optionally adds a tip or convenience fee (tags 55-57, **off by default**) and recomputes the CRC. Refuses invalid input and, by default, input that is already dynamic. The result is validated again before it is returned. |
| `qris_to_svg` | Renders a valid QRIS payload as an **SVG QR code** with a built-in encoder (byte mode, versions 1-40, error correction L/M/Q/H, default M, 4-module quiet zone). Refuses invalid QRIS. |

All tools are read-only (`readOnlyHint: true`) and closed-world (`openWorldHint: false`).

### What `set_qris_amount` changes

| Tag | Before (static) | After (dynamic) |
|---|---|---|
| 01 Point of Initiation | `11` (or missing) | `12` |
| 54 Transaction Amount | absent | e.g. `25000` |
| 55-57 Tip / fee | absent | only if you ask (`tip`: `prompt`, `fixed`, `percent`) |
| 63 CRC | old checksum | recomputed |

Everything else (merchant accounts, NMID, name, city, MCC, tag 62) is copied unchanged, in the same order.

## Install

**With npx (recommended):** nothing to install. The configs below run `npx -y mcp-qris`.

**From source:**

```bash
git clone https://github.com/EzkielynaGroup/mcp-qris.git
cd mcp-qris
node --test test/        # optional: offline tests
```

Then use `"command": "node"` with `"args": ["/full/path/to/mcp-qris.mjs"]` instead of `npx`.

On Windows, if the app cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "mcp-qris"]`.

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`), then fully quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "qris": {
      "command": "npx",
      "args": ["-y", "mcp-qris"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add qris -- npx -y mcp-qris
```

Add `--scope user` to make it available in every project. Check with `claude mcp list`.

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), same JSON as Claude Desktop.

### OpenCode

`opencode.json` in the project, or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "qris": {
      "type": "local",
      "command": ["npx", "-y", "mcp-qris"],
      "enabled": true
    }
  }
}
```

## Configuration

No environment variables and no API key. The server never opens a network connection and never writes files.

## Safety and limits

- Input is limited to 2,048 characters; EMVCo recommends at most 512, longer payloads get a warning.
- Lengths are counted in characters (EMVCo MPM 4.4.1.1); the CRC is computed over the UTF-8 bytes.
- `set_qris_amount` writes whole Rupiah only (1 to 13 digits) and warns above **Rp10.000.000**, the per-transaction QRIS limit in Bank Indonesia regulation PADG 24/1/PADG/2022 (check for newer rules).
- Already-dynamic codes are refused unless `allow_dynamic_input: true`, because dynamic codes are usually meant for one transaction.
- `qris_to_svg` never encodes an invalid QRIS: a broken code cannot be paid and only confuses buyers.
- Answers never contain stack traces; logs go to stderr only.

## Standards and sources

- **EMVCo**, *EMV QR Code Specification for Payment Systems: Merchant-Presented Mode*, version 1.1, November 2020 ([emvco.com](https://www.emvco.com/)): data objects, ID allocation, CRC (ISO/IEC 13239, polynomial 0x1021, initial value 0xFFFF), amount and fee formats. All field rules in `validate_qris` follow this document. The CRC and parser are tested against the example payload in its Annex B.
- **Bank Indonesia**, QRIS (Quick Response Code Indonesian Standard) ([bi.go.id](https://www.bi.go.id/id/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/)): PADG 21/18/PADG/2019 on implementing the national QR code standard for payments (and its amendments), PADG 24/1/PADG/2022 (Rp10.000.000 per-transaction limit).
- **ASPI** (Asosiasi Sistem Pembayaran Indonesia) maintains the QRIS technical specification. That document is distributed to industry members and was **not available to us**. The QRIS-specific labels in this tool (national template GUI `ID.CO.QRIS.WWW`, NMID in its sub-ID 02, merchant criteria UMI/UKE/UME/UBE/URE in sub-ID 03, PAN/merchant ID in sub-IDs 01/02 of tags 26-45) come from public documentation by Indonesian payment providers and open-source parsers, so treat them as **descriptive, not authoritative**. They only affect labels and warnings, never the CRC or structure checks.
- **ISO/IEC 18004** (QR Code) for the encoder: capacities are tested against the standard byte-mode table, and the encoder was cross-checked by decoding 268 generated symbols (versions 1-40, L/M/Q/H, all 8 masks, UTF-8 text) with two independent decoders (macOS CoreImage and Vision). See `tools/verify-macos.mjs`.

Every QRIS in the tests is synthetic (fake merchant "TOKO CONTOH", fake NMID). No real merchant's code is included.

## FAQ

**How do I check if a QRIS code is valid?**
Paste the QRIS text into `validate_qris`. It checks the structure, the mandatory EMVCo fields and the CRC-16 checksum in the last 4 characters, and lists every problem it finds.

**How do I turn a static QRIS into a dynamic QRIS with an amount?**
Use `set_qris_amount` with your own static QRIS and the amount in Rupiah. It sets tag 01 to 12, adds tag 54 and recomputes the CRC; then test-pay a small amount before you rely on it.

**Does changing the amount in a QRIS move money or create a payment?**
No. A QRIS is just text that the payer's app reads; nothing is sent to a bank. The money still goes to the merchant account inside the original code, and the payer's app shows the merchant name before paying.

**How is the QRIS CRC calculated?**
CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, over every character up to and including `6304`, written as 4 uppercase hex digits. The check value for `123456789` is `29B1`.

**Where is the NMID in a QRIS?**
In the national QRIS merchant account template (usually tag 51, GUI `ID.CO.QRIS.WWW`), sub-ID 02, for example `ID10...`. `parse_qris` returns it as `summary.nmid`.

**Can it read a QRIS from a photo?**
No. Scan the code with any QR reader app, copy the text, and paste it here.

## Development

```bash
node --test test/
```

19 tests (unit tests plus end-to-end tests over MCP stdio), offline. On macOS you can repeat the encoder cross-check with `tools/verify-macos.mjs` and `tools/verify-macos.swift`. Issues and pull requests are welcome.

---

## Bahasa Indonesia

Server MCP **offline** untuk **membaca, memeriksa, dan menyiapkan kode pembayaran QRIS** lewat asisten AI (Claude Desktop, Claude Code, Cursor, OpenCode). Tanpa API key, tanpa internet, tanpa dependensi.

Contoh: *"Ini teks QRIS statis toko saya: `000201010211...6304ABCD`. Valid tidak? Tolong buatkan versi dinamis Rp25.000 dan gambar SVG-nya."*

> **Wajib dibaca.** Alat ini hanya membaca dan menulis ulang teks. **Tidak memindahkan uang**, tidak bisa melihat atau mengonfirmasi pembayaran, dan tidak terhubung ke bank/PJSP mana pun. QRIS dinamis hasil alat ini hanya sah sejauh QRIS statis milik merchant-nya sah. **Uji dulu dengan nominal kecil.** **Jangan menempel atau mengubah QRIS milik orang lain** tanpa izin pemiliknya: mengubah QRIS untuk menerima uang yang bukan hak Anda adalah penipuan.

**Tools**

| Tool | Fungsi |
|---|---|
| `parse_qris` | Membongkar QRIS jadi field bernama: statis/dinamis, akun merchant (tag 26-51, termasuk **NMID**), MCC, mata uang (360 = Rupiah), nominal, tip/biaya, nama/kota merchant, kode pos, data tambahan (tag 62), dan cek CRC. |
| `validate_qris` | Memeriksa struktur TLV, field wajib, format nilai, dan CRC-16/CCITT (0xFFFF). Melaporkan **semua** masalah beserta kodenya. |
| `set_qris_amount` | Mengubah QRIS **statis** yang valid menjadi **dinamis** dengan nominal Rupiah bulat: tag 01 jadi `12`, tag 54 ditambahkan, tip/biaya (tag 55-57) opsional dan **mati secara default**, CRC dihitung ulang. QRIS rusak atau yang sudah dinamis ditolak. |
| `qris_to_svg` | Membuat gambar QR (SVG) dari QRIS yang valid dengan encoder bawaan (level koreksi L/M/Q/H, default M). |

**Instalasi**: sama seperti contoh di atas. Claude Code: `claude mcp add qris -- npx -y mcp-qris`. Windows: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "mcp-qris"]`. Tidak ada variabel lingkungan atau API key.

**Batasan**: input berupa teks (bukan foto); nominal Rupiah bulat 1-13 digit; peringatan di atas Rp10.000.000 (batas per transaksi QRIS menurut PADG 24/1/PADG/2022, cek aturan terbaru); QRIS yang sudah dinamis ditolak kecuali `allow_dynamic_input: true`.

**Sumber**: spesifikasi EMVCo Merchant-Presented Mode v1.1 (November 2020) untuk struktur, field, dan CRC; Bank Indonesia (PADG 21/18/PADG/2019 beserta perubahannya, PADG 24/1/PADG/2022) untuk QRIS. Spesifikasi teknis QRIS dari ASPI tidak tersedia untuk publik, jadi label khusus QRIS (GUI `ID.CO.QRIS.WWW`, NMID di sub-ID 02, kriteria UMI/UKE/UME/UBE/URE) diambil dari dokumentasi publik PJSP dan parser open-source: anggap sebagai keterangan, bukan acuan baku. Semua QRIS di test adalah contoh buatan (merchant fiktif "TOKO CONTOH").

**Tanya jawab**

- *Bagaimana cara cek QRIS valid atau tidak?* Tempel teks QRIS ke `validate_qris`; alat memeriksa struktur, field wajib, dan CRC di 4 karakter terakhir.
- *Bagaimana mengubah QRIS statis jadi dinamis dengan nominal?* Pakai `set_qris_amount` dengan QRIS statis milik Anda sendiri, lalu uji bayar nominal kecil.
- *Apakah mengubah nominal QRIS memindahkan uang?* Tidak. QRIS hanya teks; uang tetap masuk ke rekening merchant yang ada di kode aslinya, dan aplikasi pembayar menampilkan nama merchant sebelum membayar.
- *Di mana letak NMID?* Di template QRIS nasional (biasanya tag 51, GUI `ID.CO.QRIS.WWW`), sub-ID 02.

## License

MIT. See [LICENSE](LICENSE). QRIS is a standard of Bank Indonesia and ASPI; EMV is a trademark of EMVCo. This project is independent and not affiliated with Bank Indonesia, ASPI, EMVCo or any payment provider.

---

Made by [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=mcp-qris), an independent AI API gateway for Indonesian developers (pay with QRIS).

<!-- ezk:toolkit -->
---

### Part of the Ezkielyna developer toolkit

Open-source tools from [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=mcp-qris), an independent OpenAI- and Anthropic-compatible AI API gateway (pay with QRIS, USDT or Binance Pay; no credit card).

| No API key needed | With an Ezkielyna key |
|---|---|
| [mcp-bmkg](https://github.com/EzkielynaGroup/mcp-bmkg) · [mcp-wilayah-indonesia](https://github.com/EzkielynaGroup/mcp-wilayah-indonesia) · [mcp-hari-libur-indonesia](https://github.com/EzkielynaGroup/mcp-hari-libur-indonesia) · [mcp-rupiah](https://github.com/EzkielynaGroup/mcp-rupiah) · [mcp-qris](https://github.com/EzkielynaGroup/mcp-qris) · [ai-model-status-mcp](https://github.com/EzkielynaGroup/ai-model-status-mcp) | [ezkielyna-mcp](https://github.com/EzkielynaGroup/ezkielyna-mcp) · [ezkielyna-image-mcp](https://github.com/EzkielynaGroup/ezkielyna-image-mcp) · [ezkielyna-audio-mcp](https://github.com/EzkielynaGroup/ezkielyna-audio-mcp) · [n8n-nodes-ezkielyna](https://github.com/EzkielynaGroup/n8n-nodes-ezkielyna) |

More: [all repositories](https://github.com/EzkielynaGroup) · [awesome-mcp-indonesia](https://github.com/EzkielynaGroup/awesome-mcp-indonesia) · [awesome-ai-indonesia](https://github.com/EzkielynaGroup/awesome-ai-indonesia)
<!-- /ezk:toolkit -->
