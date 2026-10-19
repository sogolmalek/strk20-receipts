/**
 * Step 4: check the prover output, then register the commitment on chain with the proof attached.
 *
 *   npx tsx scripts/04-register-receipt.ts            # checks only, prints the snip36 submit command
 *   npx tsx scripts/04-register-receipt.ts --send     # submits via starknet.js (proof-carrying invoke)
 *
 * Expects out/receipt.proof, out/receipt.proof_facts, out/receipt.raw_messages.json from snip36.
 */
import { existsSync, readFileSync } from "node:fs";
import { flag, connect, hexOf, loadEnv } from "./lib.js";
import { messageHash } from "../src/receipt.js";
import { hex, snKeccak, toFelt } from "../src/felt.js";

const env = loadEnv();
if (!env.receipt) throw new Error("Set RECEIPT_CONTRACT in .env");
const meta = JSON.parse(readFileSync("out/meta.json", "utf8"));
const commitment = toFelt(meta.commitment);
const receipt = toFelt(env.receipt);
const { provider, account } = connect(env);

const proof = readFileSync("out/receipt.proof", "utf8").trim();
const proofFacts: string[] = JSON.parse(readFileSync("out/receipt.proof_facts", "utf8"));

// 1. The virtual tx must have emitted exactly our message: from the receipt contract, payload [class_hash, commitment].
const classHash = toFelt(await provider.getClassHashAt(hexOf(receipt)));
if (existsSync("out/receipt.raw_messages.json")) {
  const msgs = JSON.parse(readFileSync("out/receipt.raw_messages.json", "utf8")).l2_to_l1_messages as
    { from_address: string; to_address: string; payload: string[] }[];
  const ok = msgs.length === 1 && toFelt(msgs[0].from_address) === receipt &&
    msgs[0].payload.length === 2 && toFelt(msgs[0].payload[0]) === classHash && toFelt(msgs[0].payload[1]) === commitment;
  if (!ok) throw new Error(`unexpected L2->L1 messages from the virtual tx: ${JSON.stringify(msgs)}`);
  console.log("OK  virtual tx emitted exactly [class_hash, commitment] from the receipt contract");
} else {
  console.warn("no raw_messages.json found; skipping the message check");
}

// 2. Proof facts must commit to that message hash (same check the contract will do).
const expected = messageHash(receipt, classHash, commitment);
if (!proofFacts.map((x) => toFelt(x)).includes(expected)) throw new Error(`proof_facts do not contain message hash ${hex(expected)}`);
console.log("OK  proof_facts contain the expected message hash");

const head = await provider.getBlockNumber();
console.log(`Base block ${meta.base_block}, head ${head} (${head - meta.base_block} blocks since base)`);

const call = { contractAddress: hexOf(receipt), entrypoint: "register_receipt", calldata: [hex(commitment)] };
if (!flag("send")) {
  console.log("\nChecks passed. Submit with either:");
  console.log("  npx tsx scripts/04-register-receipt.ts --send");
  console.log(`  snip36 submit --proof out/receipt.proof --proof-facts out/receipt.proof_facts \\`);
  console.log(`    --calldata "0x1,${hexOf(receipt)},${hex(snKeccak("register_receipt"))},0x1,${hex(commitment)}" --contract-address ${hexOf(receipt)}`);
  process.exit(0);
}
const sent = await account.execute([call], { proofFacts, proof });
console.log(`Submitted: ${sent.transaction_hash}`);
await provider.waitForTransaction(sent.transaction_hash, { retryInterval: 3000 });
const reg = await provider.callContract({ contractAddress: hexOf(receipt), entrypoint: "registered_at", calldata: [hex(commitment)] });
console.log(`registered_at(commitment) = ${BigInt(reg[0])}`);
