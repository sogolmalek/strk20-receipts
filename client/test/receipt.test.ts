/**
 * Cross-language vectors:
 *  - commitment / message hash  == contracts/tests/test_receipt.cairo (commitment_and_message_hash_match_client_vectors)
 *  - INVOKE v3 hash + signature == snip36-core compute_invoke_v3_tx_hash + sign (Rust), run with the same inputs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitment, messageHash, invokeV3Hash, signHash, referenceFelt, executeCalldata,
  provePaymentCalldata, openingCommitment, Opening, registeredSlot } from "../src/receipt.js";
import { hex, snKeccak } from "../src/felt.js";

const C = 0x65da3266b91c0fd7f5b1453ebcaddc38ab380ae65197c6e81688b4263da59fan;

test("commitment and message hash equal the Cairo contract's", () => {
  const c = commitment({ pool: 0x111n, token: 0x1234n, sender: 0x123n, recipient: 0x456n,
    claim: { kind: "atLeast", value: 800n }, reference: referenceFelt("INVOICE-2026-042"), blinding: 0xb11dn });
  assert.equal(c, C);
  assert.equal(hex(messageHash(0x999n, 0x777n, c)), "0x9a5a4d7b18a746154196c324c14eca7fa2749ae52417c9f52b1614597333f4");
});

test("opening JSON recomputes to the same commitment; any edited field changes it", () => {
  const o: Opening = { version: "strk20-receipt-opening/0", receipt_contract: "0x1", pool: "0x111", token: "0x1234",
    sender: "0x123", recipient: "0x456", claim: { kind: "atLeast", value: "800" },
    reference: hex(referenceFelt("INVOICE-2026-042")), blinding: "0xb11d", commitment: hex(C) };
  assert.equal(openingCommitment(o), C);
  assert.notEqual(openingCommitment({ ...o, claim: { kind: "atLeast", value: "801" } }), C);
  assert.notEqual(openingCommitment({ ...o, claim: { kind: "exact", value: "800" } }), C);
  assert.notEqual(openingCommitment({ ...o, sender: "0x124" }), C);
});

test("INVOKE v3 hash and signature equal snip36's Rust implementation", () => {
  const h = invokeV3Hash({ sender: 0x0123456789abcdefn, calldata: [1n, 0xabcn, 0x2b5cn, 3n, 0xdefn, 0x1234n, 5n],
    chainId: "SN_MAIN", nonce: 7n });
  assert.equal(hex(h), "0x18a8ba9aae70c46a58b424b4bb9e7376ea8480ad23b42c43de95d260fac4708");
  const s = signHash(h, 0x1234567890abcdefn);
  assert.equal(hex(s.r), "0x289ed48ad11cdb641d76b7ed7b4f0bad9236822a6b347b6a43066483e5ccf7d");
  assert.equal(hex(s.s), "0x391982a5da0ecd98b3c1333012582e33f0e21bb2eb22a5bccce628def56689f");
});

test("prove_payment calldata layout matches the Cairo signature", () => {
  const args = provePaymentCalldata({ channel_key: "0xdef", token: "0x1234", sender: "0x123", recipient: "0x456",
    note_index: 5, amount: "1000" }, { kind: "exact", value: 1000n }, 7n, 9n);
  assert.deepEqual(args, [0xdefn, 0x1234n, 0x123n, 0x456n, 5n, 0n, 1000n, 7n, 9n]);
  const exec = executeCalldata(0xabcn, "prove_payment", args);
  assert.deepEqual(exec.slice(0, 4), [1n, 0xabcn, snKeccak("prove_payment"), 9n]);
  assert.throws(() => provePaymentCalldata({ channel_key: "0x1", token: "0x1", sender: "0x1", recipient: "0x1",
    note_index: 0, amount: "0" }, { kind: "exact", value: 2n ** 128n }, 0n, 0n));
});

test("registered slot is a valid storage address", () => {
  assert.ok(registeredSlot(C) < 2n ** 251n - 256n);
});
