/**
 * Trie + state-root verification against REAL chain data recorded in Juno's test suite
 * (a Pathfinder starknet_getStorageProof response on Sepolia, and mainnet block 2 roots).
 * These are independent of this codebase, so passing them shows the verifier matches
 * two production Starknet clients.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pedersenHash, poseidonPair, toFelt, hex } from "../src/felt.js";
import { verifyProof, TestTrie, NodeHashToNode } from "../src/trie.js";
import { globalStateRoot } from "../src/state.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/pathfinder-sepolia-10434.json", import.meta.url), "utf8"));
const root = toFelt(fx.global_roots.contracts_tree_root);
const nodes: NodeHashToNode[] = fx.contracts_proof_nodes;

test("real Pathfinder proof: both contract leaves verify to the contracts root (Sepolia 10434)", () => {
  for (const c of fx.checks) {
    const leaf = verifyProof(root, toFelt(c.contract_address), nodes, pedersenHash);
    assert.equal(hex(leaf), c.expected_leaf);
  }
});

test("real proof: tampering any node is rejected", () => {
  const tampered = structuredClone(nodes);
  const n = tampered[3].node as { left: string };
  n.left = "0x1";
  assert.throws(() => verifyProof(root, toFelt(fx.checks[0].contract_address), tampered, pedersenHash), /hash mismatch/);
});

test("real proof: wrong root is rejected (no path from it)", () => {
  assert.throws(() => verifyProof(root + 1n, toFelt(fx.checks[0].contract_address), nodes, pedersenHash), /missing node/);
});

test("real proof: a key that diverges from an edge yields non-membership (0)", () => {
  // Flip one bit inside the first contract's edge path (below the top 12 bits): proof must show absence.
  const addr = toFelt(fx.checks[0].contract_address) ^ (1n << 20n);
  assert.equal(verifyProof(root, addr, nodes, pedersenHash), 0n);
});

test("mainnet block 2: global root composition (classes root 0 => contracts root)", () => {
  const b = fx.mainnet_block_2;
  assert.equal(hex(globalStateRoot(toFelt(b.contracts_root), toFelt(b.classes_root))), b.global_root);
});

test("TestTrie builder round-trips membership and non-membership (Pedersen and Poseidon)", () => {
  for (const h of [pedersenHash, poseidonPair]) {
    const entries = new Map<bigint, bigint>();
    for (let i = 1n; i <= 40n; i++) entries.set((i * 0x9e3779b97f4a7c15n) % 2n ** 251n, i * 7n);
    const t = new TestTrie(entries, h);
    for (const [k, v] of entries) assert.equal(verifyProof(t.root, k, t.proof(k), h), v);
    assert.equal(verifyProof(t.root, 123456789n, t.proof(123456789n), h), 0n);
  }
});
