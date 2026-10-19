/**
 * Sepolia rehearsal, path B (no StarkWare services needed): deploy the TEST-ONLY MockPool and seed
 * it with StarkWare's Cairo reference note (amount 1000). Then run steps 00-deploy-receipt, 03, 04, 05
 * with POOL set to the mock. This proves the real SNIP-36 path (virtual OS, stwo prover,
 * proof_facts check on chain) without touching the real pool.
 *
 *   npx tsx scripts/00-deploy-mock-pool.ts
 *
 * Prints POOL=0x… for .env and writes private-note.json for the seeded note.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect, hexOf, loadEnv } from "./lib.js";
import { channelMarker, subchannelMarker, noteId } from "../src/strk20.js";

const env = loadEnv();
if (env.chainId !== "SN_SEPOLIA") throw new Error("MockPool is for Sepolia rehearsals only (set STARKNET_CHAIN_ID=SN_SEPOLIA).");
const { provider, account } = connect(env);

// StarkWare's Cairo reference vectors (starknet-privacy sdk/tests/fixtures/cairo-reference-data.json)
const ref = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/cairo-reference-data.json"), "utf8"));
const ck = BigInt(ref.inputs.channelKey), sender = BigInt(ref.inputs.sender), recipient = BigInt(ref.inputs.recipient);
const pk = BigInt(ref.inputs.recipientPublicKey), token = BigInt(ref.inputs.token), index = Number(ref.inputs.index);
const packed = BigInt(ref.outputs.encNoteAmount);

const dir = resolve(import.meta.dirname, "../../contracts/target/dev");
const sierra = JSON.parse(readFileSync(resolve(dir, "payment_receipt_MockPool.contract_class.json"), "utf8"));
const casm = JSON.parse(readFileSync(resolve(dir, "payment_receipt_MockPool.compiled_contract_class.json"), "utf8"));

const res = await account.declareAndDeploy({ contract: sierra, casm, constructorCalldata: [env.address] });
await provider.waitForTransaction(res.deploy.transaction_hash, { retryInterval: 3000 });
const pool = res.deploy.contract_address;
console.log("MockPool deployed:", pool);

const seed = await account.execute([
  { contractAddress: pool, entrypoint: "set_public_key", calldata: [hexOf(recipient), hexOf(pk)] },
  { contractAddress: pool, entrypoint: "set_channel", calldata: [hexOf(channelMarker(ck, sender, recipient, pk))] },
  { contractAddress: pool, entrypoint: "set_subchannel", calldata: [hexOf(subchannelMarker(ck, recipient, pk, token))] },
  { contractAddress: pool, entrypoint: "set_note", calldata: [hexOf(noteId(ck, token, index)), hexOf(packed)] },
]);
await provider.waitForTransaction(seed.transaction_hash, { retryInterval: 3000 });
console.log("Seeded reference note, tx:", seed.transaction_hash);

writeFileSync("private-note.json", JSON.stringify({
  channel_key: hexOf(ck), token: hexOf(token), sender: hexOf(sender), recipient: hexOf(recipient),
  note_index: index, amount: String(ref.outputs.decNoteAmount),
}, null, 2) + "\n", { mode: 0o600 });
console.log("Wrote private-note.json (reference note: amount 1000).");
console.log(`\nPut this in the env file, then deploy the receipt contract against it:\nPOOL=${pool}`);
