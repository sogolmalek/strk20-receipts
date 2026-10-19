/**
 * STRK20 derivations checked against StarkWare's Cairo-generated reference vectors
 * (starknet-privacy sdk/tests/fixtures/cairo-reference-data.json), then an end-to-end
 * receipt verification over a mock pool state with real trie proofs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hex, pedersenHash, poseidonPair, toFelt, TWO_128 } from "../src/felt.js";
import {
  channelMarker, subchannelMarker, noteId, encAmountHash, slots, unpackNote, decryptAmount,
  ReceiptV0, verifyReceipt,
} from "../src/strk20.js";
import { TestTrie } from "../src/trie.js";
import { contractLeafHash, globalStateRoot, StorageProofResponse } from "../src/state.js";

const ref = JSON.parse(readFileSync(new URL("../fixtures/cairo-reference-data.json", import.meta.url), "utf8"));
const I = ref.inputs, O = ref.outputs, S = ref.slots;
const ck = toFelt(I.channelKey), sender = toFelt(I.sender), recipient = toFelt(I.recipient);
const pk = toFelt(I.recipientPublicKey), token = toFelt(I.token), idx = I.index as number, salt = toFelt(I.salt);

test("Cairo vectors: channel marker, subchannel marker, note id, enc amount pad", () => {
  assert.equal(hex(channelMarker(ck, sender, recipient, pk)), O.channelMarker);
  assert.equal(hex(subchannelMarker(ck, recipient, pk, token)), O.subchannelMarker);
  assert.equal(hex(noteId(ck, token, idx)), O.noteId);
  assert.equal(hex(encAmountHash(ck, token, idx, salt)), O.encAmountHash);
});

test("Cairo vectors: storage slots", () => {
  assert.equal(hex(slots.publicKey(recipient)), S.recipientPublicKeyAddress);
  assert.equal(hex(slots.channelExists(channelMarker(ck, sender, recipient, pk))), S.channelExistsAddress);
  assert.equal(hex(slots.subchannelExists(subchannelMarker(ck, recipient, pk, token))), S.subchannelExistsAddress);
  assert.equal(hex(slots.note(noteId(ck, token, idx))), S.notesAddress);
});

test("Cairo vectors: packed note decrypts to 1000 with the per-note pad only", () => {
  const { salt: s, encAmount } = unpackNote(toFelt(O.encNoteAmount));
  assert.equal(s, salt);
  assert.equal(decryptAmount(encAmount, ck, token, idx, s), BigInt(O.decNoteAmount));
  // Per-note disclosure: the pad alone (no channel key) recovers this note's amount.
  const pad = toFelt(O.encAmountHash) % TWO_128;
  assert.equal((encAmount - pad + TWO_128) % TWO_128, 1000n);
});

// ---------------------------------------------------------------------------
// End-to-end: mock pool storage -> storage trie -> contracts trie -> global root
// ---------------------------------------------------------------------------
const POOL = 0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812an; // mainnet pool address
const POOL_CLASS = 0x1234567n, NONCE = 0n;

function mockState(extra: Map<bigint, bigint> = new Map()) {
  const nid = noteId(ck, token, idx);
  const storage = new Map<bigint, bigint>([
    [slots.publicKey(recipient), pk],
    [slots.channelExists(channelMarker(ck, sender, recipient, pk)), 1n],
    [slots.subchannelExists(subchannelMarker(ck, recipient, pk, token)), 1n],
    [slots.note(nid), toFelt(O.encNoteAmount)],
    // unrelated noise so the tries have real structure
    ...Array.from({ length: 50 }, (_, i) => [pedersenHash(0xbeefn, BigInt(i)) % (2n ** 251n - 256n), BigInt(i + 1)] as [bigint, bigint]),
    ...extra,
  ]);
  const storageTrie = new TestTrie(storage, pedersenHash);
  const leaf = contractLeafHash(POOL_CLASS, storageTrie.root, NONCE);
  const contracts = new Map<bigint, bigint>([[POOL, leaf], [0x111n, 0x222n], [0x333n, 0x444n]]);
  const contractsTrie = new TestTrie(contracts, pedersenHash);
  const classesRoot = new TestTrie(new Map([[0x77n, 0x88n]]), poseidonPair).root;
  const stateRoot = globalStateRoot(contractsTrie.root, classesRoot);

  const respond = (keys: bigint[]): StorageProofResponse => ({
    classes_proof: [],
    contracts_proof: {
      nodes: contractsTrie.proof(POOL),
      contract_leaves_data: [{ nonce: hex(NONCE), class_hash: hex(POOL_CLASS), storage_root: hex(storageTrie.root) }],
    },
    contracts_storage_proofs: [keys.flatMap((k) => storageTrie.proof(k))],
    global_roots: { contracts_tree_root: hex(contractsTrie.root), classes_tree_root: hex(classesRoot), block_hash: "0x0" },
  });
  return { stateRoot, respond };
}

const receipt: ReceiptV0 = {
  version: "strk20-receipt/0",
  pool: hex(POOL), token: hex(token), sender: hex(sender), recipient: hex(recipient),
  recipient_public_key: hex(pk), channel_key: hex(ck), note_index: idx, block_number: 0,
};

import { receiptStorageKeys } from "../src/strk20.js";

test("E2E: valid receipt verifies and decrypts to 1000", () => {
  const { stateRoot, respond } = mockState();
  const v = verifyReceipt(receipt, respond(receiptStorageKeys(receipt)), stateRoot);
  assert.equal(v.amount, 1000n);
  assert.ok(v.checks.every((c) => c.ok));
});

test("E2E: wrong sender (claiming someone else paid) is rejected", () => {
  const { stateRoot, respond } = mockState();
  const forged = { ...receipt, sender: "0x999" };
  assert.throws(() => verifyReceipt(forged, respond(receiptStorageKeys(forged)), stateRoot), /channel_exists/);
});

test("E2E: wrong recipient public key is rejected", () => {
  const { stateRoot, respond } = mockState();
  const forged = { ...receipt, recipient_public_key: "0xabd" };
  assert.throws(() => verifyReceipt(forged, respond(receiptStorageKeys(forged)), stateRoot), /public_key/);
});

test("E2E: non-existent note index is rejected", () => {
  const { stateRoot, respond } = mockState();
  const forged = { ...receipt, note_index: 6 };
  assert.throws(() => verifyReceipt(forged, respond(receiptStorageKeys(forged)), stateRoot), /packed_value/);
});

test("E2E: proof from a different state (lying RPC) is rejected", () => {
  const honest = mockState();
  const evil = mockState(new Map([[12345n, 1n]])); // RPC serves a different state
  assert.throws(() => verifyReceipt(receipt, evil.respond(receiptStorageKeys(receipt)), honest.stateRoot), /global root mismatch/);
});

test("E2E: RPC that edits a storage value inside an otherwise valid proof is rejected", () => {
  const { stateRoot, respond } = mockState();
  const resp = respond(receiptStorageKeys(receipt));
  // Replace the edge node carrying the note value with one claiming 2000 (re-encrypted), keeping claimed hash
  const target = toFelt(O.encNoteAmount);
  const node = resp.contracts_storage_proofs[0].find((n) => "child" in n.node && toFelt((n.node as { child: string }).child) === target);
  assert.ok(node, "edge to note value present");
  (node!.node as { child: string }).child = hex(target + 1000n);
  assert.throws(() => verifyReceipt(receipt, resp, stateRoot), /hash mismatch/);
});
