# Publishing notes (owner)

**GitHub description (<= 120 chars):**
Offline MCP server for QRIS: parse, validate CRC, turn static QRIS into dynamic with amount, render SVG. No API key.

**Topics (12):** mcp, model-context-protocol, mcp-server, qris, emvco, qr-code, indonesia, payments, crc16, claude, cursor, opencode

**Homepage:** https://www.npmjs.com/package/mcp-qris (after npm publish)

**Owner actions**
1. Create `EzkielynaGroup/mcp-qris` (public), push `main`.
2. `npm publish` (name `mcp-qris` was free on npm on 11 Nov 2026; re-check with `npm view mcp-qris`).
3. Publish `server.json` to the official MCP registry (`mcp-publisher publish`), after npm.
4. Optional: list on awesome-mcp-servers / Smithery under Finance / Payments.

**Before announcing:** the QRIS-specific labels (NMID in 51.02, merchant criteria) come from public provider docs, not the
ASPI specification (not public). If someone with the ASPI spec reports a difference, fix the labels; CRC/structure logic follows EMVCo.
Keep the safety wording (no money moves, never use someone else's QRIS) in any post about this tool.
