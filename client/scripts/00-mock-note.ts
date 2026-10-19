/**
 * Path B helper: write private-note.json for the reference note that 00-deploy-mock-pool.ts seeds.
 * The note is StarkWare's public Cairo reference vector (channel key 0xdef, amount 1000), so this
 * file holds no secret. Used by CI, where the MockPool already exists.
 *
 *   npx tsx scripts/00-mock-note.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hexOf } from "./lib.js";

const ref = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/cairo-reference-data.json"), "utf8"));
writeFileSync("private-note.json", JSON.stringify({
  channel_key: hexOf(BigInt(ref.inputs.channelKey)), token: hexOf(BigInt(ref.inputs.token)),
  sender: hexOf(BigInt(ref.inputs.sender)), recipient: hexOf(BigInt(ref.inputs.recipient)),
  note_index: Number(ref.inputs.index), amount: String(ref.outputs.decNoteAmount),
}, null, 2) + "\n");
console.log("Wrote private-note.json (public reference note, amount 1000).");
