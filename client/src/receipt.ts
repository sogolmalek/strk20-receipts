/**
 * Client side of PaymentReceipt (contracts/src/receipt.cairo):
 * commitment + message hash (mirror the Cairo exactly), calldata for the virtual
 * `prove_payment` call, and the zero-fee INVOKE v3 that snip36 proves from `--tx-json`.
 */
import { sign as starkSign } from "@scure/starknet";
import { Felt, P, hex, poseidon, shortString, snKeccak, toFelt, pedersenHash } from "./felt.js";

export type AmountClaim = { kind: "exact" | "atLeast"; value: bigint };

/** Everything a verifier needs. Safe to share: contains no key. */
export type Opening = {
  version: "strk20-receipt-opening/0";
  receipt_contract: string;
  pool: string;
  token: string;
  sender: string;
  recipient: string;
  claim: { kind: AmountClaim["kind"]; value: string };
  reference: string;
  blinding: string;
  commitment: string;
};

/** Private inputs for the virtual call. NEVER share: contains the channel key. */
export type PrivateNote = {
  channel_key: string;
  token: string;
  sender: string;
  recipient: string;
  note_index: number;
  amount: string;
};

const RECEIPT_TAG = shortString("STRK20_RECEIPT:V0");
const CLAIM_KIND = { exact: 0n, atLeast: 1n } as const;

/** Accepts a hex/decimal felt or a <=31-char ASCII short string (e.g. "INV-042"). */
export function referenceFelt(ref: string): Felt {
  return /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(ref) ? toFelt(ref) : shortString(ref);
}

export function commitment(f: {
  pool: Felt; token: Felt; sender: Felt; recipient: Felt; claim: AmountClaim; reference: Felt; blinding: Felt;
}): Felt {
  return poseidon([
    RECEIPT_TAG, f.pool, f.token, f.sender, f.recipient,
    CLAIM_KIND[f.claim.kind], f.claim.value, f.reference, f.blinding,
  ]);
}

/** poseidon(from, to = 0, payload_len = 2, class_hash, commitment) — as in the SNIP-36 proof facts. */
export function messageHash(from: Felt, classHash: Felt, c: Felt): Felt {
  return poseidon([from, 0n, 2n, classHash, c]);
}

export function openingCommitment(o: Opening): Felt {
  return commitment({
    pool: toFelt(o.pool), token: toFelt(o.token), sender: toFelt(o.sender), recipient: toFelt(o.recipient),
    claim: { kind: o.claim.kind, value: BigInt(o.claim.value) },
    reference: toFelt(o.reference), blinding: toFelt(o.blinding),
  });
}

/** Storage slot of `registered[commitment]` in PaymentReceipt. */
export function registeredSlot(c: Felt): Felt {
  return pedersenHash(snKeccak("registered"), c) % (2n ** 251n - 256n);
}

/** Calldata of prove_payment(ck, token, sender, recipient, note_index, claim, reference, blinding). */
export function provePaymentCalldata(n: PrivateNote, claim: AmountClaim, reference: Felt, blinding: Felt): Felt[] {
  if (claim.value < 0n || claim.value >= 2n ** 128n) throw new Error("claim value must fit u128");
  return [
    toFelt(n.channel_key), toFelt(n.token), toFelt(n.sender), toFelt(n.recipient),
    BigInt(n.note_index), CLAIM_KIND[claim.kind], claim.value, reference, blinding,
  ];
}

/** OZ / Cairo-1 account __execute__ calldata for a single call. */
export function executeCalldata(to: Felt, entrypoint: string, args: Felt[]): Felt[] {
  return [1n, to, snKeccak(entrypoint), BigInt(args.length), ...args];
}

// ---------------------------------------------------------------------------
// INVOKE v3 hash, mirroring snip36-core/src/signing.rs compute_invoke_v3_tx_hash
// ---------------------------------------------------------------------------

export type Bound = { max_amount: bigint; max_price_per_unit: bigint };
export type ResourceBounds = { l1_gas: Bound; l2_gas: Bound; l1_data_gas: Bound };

/** snip36 ResourceBounds::zero_fee() — virtual txs pay no fee but need gas headroom. */
export const ZERO_FEE: ResourceBounds = {
  l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
  l2_gas: { max_amount: 0x7000000n, max_price_per_unit: 0n },
  l1_data_gas: { max_amount: 0x1b0n, max_price_per_unit: 0n },
};

const resourceName = (s: string) => shortString(s);
const concatResource = (b: Bound, name: string) =>
  ((resourceName(name) << 192n) | (b.max_amount << 128n) | b.max_price_per_unit) % P;

export function invokeV3Hash(p: {
  sender: Felt; calldata: Felt[]; chainId: string; nonce: Felt; tip?: Felt; bounds?: ResourceBounds;
  proofFacts?: Felt[];
}): Felt {
  const b = p.bounds ?? ZERO_FEE;
  const tipRb = poseidon([p.tip ?? 0n, concatResource(b.l1_gas, "L1_GAS"), concatResource(b.l2_gas, "L2_GAS"),
    concatResource(b.l1_data_gas, "L1_DATA")]);
  const elems = [
    shortString("invoke"), 3n, p.sender, tipRb, poseidon([]), shortString(p.chainId), p.nonce,
    0n /* da modes L1/L1 */, poseidon([]), poseidon(p.calldata),
  ];
  if (p.proofFacts && p.proofFacts.length) elems.push(poseidon(p.proofFacts));
  return poseidon(elems);
}

export function signHash(hash: Felt, privateKey: Felt): { r: Felt; s: Felt } {
  const sig = starkSign(hex(hash), hex(privateKey));
  return { r: sig.r, s: sig.s };
}

/** The transaction object snip36 `prove virtual-os --tx-json` expects (same shape as its coinflip e2e). */
export function virtualTxJson(p: {
  sender: Felt; calldata: Felt[]; chainId: string; nonce: Felt; privateKey: Felt;
}) {
  const h = invokeV3Hash({ sender: p.sender, calldata: p.calldata, chainId: p.chainId, nonce: p.nonce });
  const { r, s } = signHash(h, p.privateKey);
  const rb = (b: Bound) => ({ max_amount: hex(b.max_amount), max_price_per_unit: hex(b.max_price_per_unit) });
  return {
    hash: h,
    tx: {
      type: "INVOKE",
      version: "0x3",
      sender_address: hex(p.sender),
      calldata: p.calldata.map(hex),
      nonce: hex(p.nonce),
      resource_bounds: { l1_gas: rb(ZERO_FEE.l1_gas), l2_gas: rb(ZERO_FEE.l2_gas), l1_data_gas: rb(ZERO_FEE.l1_data_gas) },
      tip: "0x0",
      paymaster_data: [],
      account_deployment_data: [],
      nonce_data_availability_mode: "L1",
      fee_data_availability_mode: "L1",
      signature: [hex(r), hex(s)],
    },
  };
}
