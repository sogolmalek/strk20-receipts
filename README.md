# strk20-receipts

**Prove one STRK20 private payment to someone without giving them a key.**

STRK20 makes payments private. When an accountant, landlord, grantor or auditor needs proof of a
payment, today's options are to hand over a viewing key (everything, forever) or a channel key
(the whole relationship with that counterparty, forever). `strk20-receipts` proves a single fact
instead, such as "S paid R at least 1,000 USDC, reference INV-042", using a SNIP-36 virtual block.
The verifier receives an opening of a commitment, never a key.

```
holder (local)                         Starknet                         verifier
──────────────                         ────────                         ────────
prove_payment(ck, …)  ── SNIP-36 ──►   register_receipt(commitment)
 · reads the pool at the base block     · checks proof_facts
 · decrypts the note, checks claim      · stores commitment            opening ──► recompute commitment
 · emits [class_hash, commitment]                                       storage proof ──► registered? ✔
```

## Repository

| Path | What |
|---|---|
| `contracts/` | `PaymentReceipt` Cairo contract, a test-only `MockPool`, and 19 snforge tests (most against StarkWare's real `Privacy` pool contract) |
| `client/src/` | Commitment, calldata and INVOKE v3 signing for virtual txs; a Starknet storage-proof verifier |
| `client/test/` | 24 tests, including live mainnet proof data and cross-language vectors (Cairo, snip36 Rust) |
| `client/scripts/` | End-to-end flow on mainnet: account, deploy, register, find notes, build virtual tx, register receipt, verify |
| `RUNBOOK.md` | Step-by-step commands for the end-to-end run on mainnet |
| `RUNBOOK-SEPOLIA.md` | Free rehearsal on Sepolia: a MockPool path (SNIP-36 only) and a real-pool path |
| `.github/workflows/sepolia-receipt.yml` | Sepolia path B in CI: real stwo proof, on-chain registration, verification, tamper check |

## Status

- Contract logic: done and tested against the real pool contract (claims exact / at-least; rejects
  wrong sender, key, token, missing note, false claim; registration rejects missing, expired or
  foreign proofs).
- Virtual OS compatibility: the syscalls used (`call_contract`, `storage_read`, `get_class_hash_at`,
  `send_message_to_l1`) are in the virtual OS syscall table.
- Client: commitment and message hash match the Cairo contract; the INVOKE v3 hash and signature match
  snip36's Rust implementation exactly.
- Storage-proof verifier: checked against a recorded Pathfinder proof and live mainnet pool storage.
- **Not yet done:** a real stwo proof of `prove_payment` submitted on mainnet (see `RUNBOOK.md`).

## Security notes

- Same trust assumptions as the STRK20 pool's own `validate_proof`: the protocol verifies the proof
  against the virtual OS program and a canonical base block.
- SNIP-36 phase 1 gives de-facto (not formal ZK) privacy, and the prover sees its inputs. Proving must
  run locally (`snip36` prebuilt prover), never on a hosted prover, because the input includes the
  channel key.
- On chain, the commitment and the registering account are public. The fact is not.
- A receipt proves that a payment exists. It cannot prove that no other payments exist.

## Build and test

```bash
cd contracts && scarb build && snforge test     # scarb 2.18.0, starknet-foundry 0.63.0
cd ../client && npm install && npm test         # Node >= 24 for the end-to-end scripts
```

Apache-2.0.
