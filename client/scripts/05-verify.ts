/**
 * Step 5 (the verifier's side): check an opening without any key and without trusting the RPC.
 *
 *   npx tsx scripts/05-verify.ts --opening out/opening.json --rpc <URL>
 *
 * 1. recomputes the commitment from the opening;
 * 2. reads PaymentReceipt.registered[commitment] with a Merkle storage proof, verified against the
 *    block state root (trie -> contract leaf -> global root).
 * Trust that remains: the block header's state root comes from the RPC (L1 anchoring is a milestone).
 */
import { readFileSync } from "node:fs";
import { arg } from "./lib.js";
import { Opening, openingCommitment, registeredSlot } from "../src/receipt.js";
import { hex, toFelt } from "../src/felt.js";
import { blockHeader, storageProof } from "../src/rpc.js";
import { verifyContractStorage } from "../src/state.js";

const rpc = arg("rpc") ?? process.env.STARKNET_RPC_URL;
if (!rpc) throw new Error("--rpc required");
const o = JSON.parse(readFileSync(arg("opening") ?? "out/opening.json", "utf8")) as Opening;

const c = openingCommitment(o);
if (c !== toFelt(o.commitment)) throw new Error("opening does not match its stated commitment");
console.log(`commitment recomputed: ${hex(c)}`);

const contract = toFelt(o.receipt_contract);
const slot = registeredSlot(c);
const proof = await storageProof(rpc, "latest", contract, [slot]);
const h = await blockHeader(rpc, { block_hash: proof.global_roots.block_hash });
const [read] = verifyContractStorage(proof, h.newRoot, contract, [slot]);

const claim = o.claim.kind === "exact" ? `exactly ${o.claim.value}` : `at least ${o.claim.value}`;
if (read.value === 0n) {
  console.log(`NOT REGISTERED (verified absent at block ${h.number})`);
  process.exit(1);
}
console.log(`VERIFIED at block ${h.number}: ${o.sender} paid ${o.recipient} ${claim} of token ${o.token}`);
console.log(`  reference ${o.reference}; registered at block ${read.value}; storage proof checked against state root ${hex(h.newRoot)}`);
