/**
 * Step 2: list the private notes this account has received, and save one as the private input
 * for a receipt.
 *
 *   npx tsx scripts/02-find-notes.ts                       # list (reads the pool over RPC)
 *   npx tsx scripts/02-find-notes.ts --indexer             # list via hosted discovery (OHTTP)
 *   npx tsx scripts/02-find-notes.ts --pick 0 --out private-note.json
 *
 * private-note.json contains the CHANNEL KEY. Keep it on this machine. Never share it.
 */
import { writeFileSync } from "node:fs";
import { arg, flag, hexOf, loadEnv, session } from "./lib.js";
import type { PrivateNote } from "../src/receipt.js";

const env = loadEnv();
const s = await session(env, { indexer: flag("indexer") });
const { notes } = await s.transfers.discoverNotes();

const rows: PrivateNote[] = [];
for (const [token, list] of notes.entries()) {
  for (const n of list as any[]) {
    if (n.open) continue; // open notes are not encrypted payments
    rows.push({
      channel_key: hexOf(n.witness.channelKey),
      token: hexOf(token),
      sender: hexOf(n.sender),
      recipient: env.address,
      note_index: Number(n.witness.nonce),
      amount: BigInt(n.amount).toString(),
    });
  }
}

if (!rows.length) {
  console.log("No unspent encrypted notes found for", env.address);
  process.exit(0);
}
rows.forEach((r, i) => console.log(`[${i}] from ${r.sender}  token ${r.token}  amount ${r.amount}  note #${r.note_index}`));

const pick = arg("pick");
if (pick !== undefined) {
  const out = arg("out") ?? "private-note.json";
  writeFileSync(out, JSON.stringify(rows[Number(pick)], null, 2) + "\n", { mode: 0o600 });
  console.log(`Saved note [${pick}] to ${out} (contains the channel key; keep it private).`);
}
