/**
 * Step 3: build the SNIP-36 virtual transaction that calls PaymentReceipt.prove_payment.
 * It is signed but NEVER broadcast: snip36 proves it from the JSON file.
 *
 *   npx tsx scripts/03-make-virtual-tx.ts --note private-note.json --claim atLeast:1000000000000000000 \
 *       --reference INV-2026-001 [--block N]
 *
 * Writes:
 *   out/receipt_tx.json  -> snip36 prove virtual-os --tx-json (contains the channel key in calldata: private)
 *   out/opening.json     -> what you give the verifier (no key)
 *   out/meta.json        -> base block + expected commitment, used by step 4
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { arg, connect, hexOf, loadEnv } from "./lib.js";
import {
  AmountClaim, Opening, PrivateNote, commitment, executeCalldata, provePaymentCalldata, referenceFelt, virtualTxJson,
} from "../src/receipt.js";
import { P, hex, toFelt } from "../src/felt.js";

const env = loadEnv();
if (!env.receipt) throw new Error("Set RECEIPT_CONTRACT in .env (address of your deployed PaymentReceipt).");
const note = JSON.parse(readFileSync(arg("note") ?? "private-note.json", "utf8")) as PrivateNote;

const [kind, value] = (arg("claim") ?? `exact:${note.amount}`).split(":");
if (kind !== "exact" && kind !== "atLeast") throw new Error("--claim must be exact:<amount> or atLeast:<amount>");
const claim: AmountClaim = { kind, value: BigInt(value) };
if (kind === "exact" && claim.value !== BigInt(note.amount)) console.warn("warning: exact claim differs from the note amount; proving will fail");
if (kind === "atLeast" && claim.value > BigInt(note.amount)) console.warn("warning: threshold above the note amount; proving will fail");

const reference = referenceFelt(arg("reference") ?? "0");
const blinding = BigInt("0x" + randomBytes(31).toString("hex")) % P;

const { provider } = connect(env);
const head = await provider.getBlockNumber();
const block = arg("block") ? Number(arg("block")) : head - env.proveLag;
// The virtual tx is validated against the BASE block's state, so use the nonce at that block.
const nonce = BigInt(await provider.getNonceForAddress(env.address, block));

const calldata = executeCalldata(toFelt(env.receipt), "prove_payment", provePaymentCalldata(note, claim, reference, blinding));
const { hash, tx } = virtualTxJson({ sender: toFelt(env.address), calldata, chainId: env.chainId, nonce, privateKey: toFelt(env.privateKey) });

const c = commitment({
  pool: toFelt(env.pool), token: toFelt(note.token), sender: toFelt(note.sender), recipient: toFelt(note.recipient),
  claim, reference, blinding,
});
const opening: Opening = {
  version: "strk20-receipt-opening/0",
  receipt_contract: hexOf(env.receipt), pool: hexOf(env.pool), token: note.token, sender: note.sender,
  recipient: note.recipient, claim: { kind, value: claim.value.toString() }, reference: hex(reference),
  blinding: hex(blinding), commitment: hex(c),
};

mkdirSync("out", { recursive: true });
writeFileSync("out/receipt_tx.json", JSON.stringify(tx, null, 2) + "\n", { mode: 0o600 });
writeFileSync("out/opening.json", JSON.stringify(opening, null, 2) + "\n");
writeFileSync("out/meta.json", JSON.stringify({ base_block: block, tx_hash: hex(hash), commitment: hex(c) }, null, 2) + "\n");

console.log(`Base block: ${block} (head ${head})   nonce at base block: ${nonce}`);
console.log(`Commitment: ${hex(c)}`);
console.log("\nNext, prove it (local prover; the channel key stays on this machine):");
console.log(`  snip36 prove virtual-os --block-number ${block} --tx-json out/receipt_tx.json \\`);
console.log(`    --rpc-url "$STARKNET_RPC_URL" --output out/receipt.proof`);
console.log("Then submit within the validity window (proof_validity_blocks after the base block):");
console.log("  npx tsx scripts/04-register-receipt.ts");
