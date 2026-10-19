/**
 * Live mainnet runs.
 *
 *   probe:   npx tsx src/cli.ts probe   --rpc <URL> [--root-rpc <URL2>] [--block N]
 *            Verifies public pool storage (auditor key, fee, proof window) against the block's
 *            state root, and cross-checks each value with plain starknet_getStorageAt.
 *
 *   receipt: npx tsx src/cli.ts receipt --rpc <URL> [--root-rpc <URL2>] --file receipt.json
 *            Verifies a counterparty-scoped STRK20 payment receipt and prints the amount.
 *
 * Trust: the state root comes from --root-rpc (defaults to --rpc). Proof data from --rpc is
 * trusted ONLY through the hash chain to that root. Anchoring the root to Ethereum L1 is a
 * separate milestone (not in this PoC).
 */
import { readFileSync } from "node:fs";
import { hex, snKeccak, toFelt } from "./felt.js";
import { blockHeader, storageAt, storageProof } from "./rpc.js";
import { verifyContractStorage } from "./state.js";
import { ReceiptV0, receiptStorageKeys, verifyReceipt } from "./strk20.js";

const MAINNET_POOL = 0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812an;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const rpcUrl = opt("rpc");
const rootRpc = opt("root-rpc") ?? rpcUrl;
if (!rpcUrl || !["probe", "receipt"].includes(cmd)) {
  console.error("usage: cli.ts probe|receipt --rpc URL [--root-rpc URL] [--block N] [--file receipt.json]");
  process.exit(2);
}

/**
 * Many public nodes keep storage tries only for the latest block, so the proof is requested
 * first (at --block, else "latest") and the trusted header is fetched by the block hash the
 * proof names, from --root-rpc.
 */
async function provedAndTrusted(contract: bigint, keys: bigint[]) {
  const blockArg = opt("block");
  const proof = await storageProof(rpcUrl!, blockArg ? { block_number: Number(blockArg) } : "latest", contract, keys);
  const h = await blockHeader(rootRpc!, { block_hash: proof.global_roots.block_hash });
  console.log(`block ${h.number}  hash ${h.hash}\nstate root (from ${rootRpc === rpcUrl ? "same RPC" : "independent root RPC"}): ${hex(h.newRoot)}`);
  return { proof, h };
}

async function probe() {
  const names = ["auditor_public_key", "screener_public_key", "fee_amount", "proof_validity_blocks"];
  const keys = names.map(snKeccak);
  const { proof, h } = await provedAndTrusted(MAINNET_POOL, keys);
  const reads = verifyContractStorage(proof, h.newRoot, MAINNET_POOL, keys);
  console.log(`\nverified pool storage (pool ${hex(MAINNET_POOL)}):`);
  for (const [i, r] of reads.entries()) {
    const plain = await storageAt(rpcUrl!, { block_hash: h.hash }, MAINNET_POOL, r.key);
    console.log(`  ${names[i].padEnd(22)} ${hex(r.value).padEnd(68)} getStorageAt agrees: ${plain === r.value}`);
  }
  console.log("\nOK: every value above is bound by Merkle proofs to the block state root.");
}

async function receipt() {
  const file = opt("file");
  if (!file) throw new Error("--file required");
  const r = JSON.parse(readFileSync(file, "utf8")) as ReceiptV0;
  const { proof, h } = await provedAndTrusted(toFelt(r.pool), receiptStorageKeys(r));
  const v = verifyReceipt(r, proof, h.newRoot);
  for (const c of v.checks) console.log(`  [${c.ok ? "ok" : "FAIL"}] ${c.name}`);
  console.log(`\nVERIFIED: ${r.sender} paid ${r.recipient} amount ${v.amount} (raw units) of token ${r.token}, note #${r.note_index}`);
}

(cmd === "probe" ? probe() : receipt()).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
