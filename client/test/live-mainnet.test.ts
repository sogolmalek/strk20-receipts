/**
 * Live Starknet MAINNET data (block 16,605,409), fetched from PublicNode (RPC 0.10.3):
 * a getStorageProof for the canonical STRK20 privacy pool and the block header.
 * Checks the full chain: storage leaf -> pool storage root -> contract leaf (class hash,
 * nonce) -> contracts root -> Poseidon global root == header new_root.
 * Also the first real-data check of the Poseidon global-root formula with a non-zero classes root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hex, snKeccak, toFelt } from "../src/felt.js";
import { globalStateRoot, verifyContractStorage } from "../src/state.js";

const live = JSON.parse(readFileSync(new URL("../fixtures/live-mainnet-16605409.json", import.meta.url), "utf8"));
const key = snKeccak("proof_validity_blocks");

test("mainnet: Poseidon global root from proof equals block header new_root", () => {
  const g = live.proof.global_roots;
  assert.equal(hex(globalStateRoot(toFelt(g.contracts_tree_root), toFelt(g.classes_tree_root))), live.new_root);
});

test("mainnet: STRK20 pool proof_validity_blocks verifies to 450, matching getStorageAt", () => {
  const [r] = verifyContractStorage(live.proof, toFelt(live.new_root), toFelt(live.pool), [key]);
  assert.equal(r.value, 450n);
  assert.equal(r.value, toFelt(live.getStorageAt[3]));
});

test("mainnet: tampered storage value and wrong trusted root are both rejected", () => {
  const bad = structuredClone(live);
  bad.proof.contracts_storage_proofs[0].at(-1).node.child = "0x1c3";
  assert.throws(() => verifyContractStorage(bad.proof, toFelt(live.new_root), toFelt(live.pool), [key]), /hash mismatch/);
  assert.throws(() => verifyContractStorage(live.proof, toFelt(live.new_root) + 1n, toFelt(live.pool), [key]), /global root mismatch/);
});

test("mainnet: wrong class hash in leaf data is rejected (contract leaf binding)", () => {
  const bad = structuredClone(live);
  bad.proof.contracts_proof.contract_leaves_data[0].class_hash = "0x1";
  assert.throws(() => verifyContractStorage(bad.proof, toFelt(live.new_root), toFelt(live.pool), [key]), /contract leaf mismatch/);
});
