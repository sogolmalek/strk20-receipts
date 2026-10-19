/**
 * STRK20 privacy-pool derivations (mirrors starknet-privacy packages/privacy/src/hashes.cairo
 * and the pool's storage layout) plus a counterparty-scoped payment receipt verifier.
 */
import { Felt, TWO_128, hex, pedersenHash, poseidon, shortString, snKeccak, toFelt } from "./felt.js";
import { StorageProofResponse, verifyContractStorage } from "./state.js";

const TAG = {
  CHANNEL_MARKER: shortString("CHANNEL_MARKER_TAG:V1"),
  SUBCHANNEL_MARKER: shortString("SUBCHANNEL_MARKER_TAG:V1"),
  NOTE_ID: shortString("NOTE_ID_TAG:V1"),
  ENC_AMOUNT: shortString("ENC_AMOUNT_TAG:V1"),
};

export const channelMarker = (ck: Felt, sender: Felt, recipient: Felt, recipientPk: Felt) =>
  poseidon([TAG.CHANNEL_MARKER, ck, sender, recipient, recipientPk]);
export const subchannelMarker = (ck: Felt, recipient: Felt, recipientPk: Felt, token: Felt) =>
  poseidon([TAG.SUBCHANNEL_MARKER, ck, recipient, recipientPk, token]);
export const noteId = (ck: Felt, token: Felt, index: number) =>
  poseidon([TAG.NOTE_ID, ck, token, BigInt(index), 0n]);
export const encAmountHash = (ck: Felt, token: Felt, index: number, salt: Felt) =>
  poseidon([TAG.ENC_AMOUNT, ck, token, BigInt(index), 0n, salt]);

/** Cairo storage addresses live below 2^251 - 256. */
const ADDR_BOUND = 2n ** 251n - 256n;

/** Address of `name[key]` for a Cairo `Map` storage variable: pedersen(sn_keccak(name), key) mod (2^251 - 256). */
export const mapSlot = (name: string, key: Felt) => pedersenHash(snKeccak(name), key) % ADDR_BOUND;

export const slots = {
  publicKey: (user: Felt) => mapSlot("public_key", user),
  channelExists: (marker: Felt) => mapSlot("channel_exists", marker),
  subchannelExists: (marker: Felt) => mapSlot("subchannel_exists", marker),
  /** Note struct base slot: packed_value at +0, token at +1. */
  note: (id: Felt) => mapSlot("notes", id),
};

/** packed_value = salt * 2^128 + enc_amount */
export function unpackNote(packed: Felt): { salt: Felt; encAmount: Felt } {
  return { salt: packed / TWO_128, encAmount: packed % TWO_128 };
}

export function decryptAmount(encAmount: Felt, ck: Felt, token: Felt, index: number, salt: Felt): Felt {
  const pad = encAmountHash(ck, token, index, salt) % TWO_128;
  return (((encAmount - pad) % TWO_128) + TWO_128) % TWO_128;
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * Counterparty-scoped receipt (tier 1). Reveals the channel key of ONE
 * sender->recipient relationship for ONE token; nothing about other counterparties.
 * Either party can produce it (sender derives ck; recipient decrypts it with the viewing key).
 */
export type ReceiptV0 = {
  version: "strk20-receipt/0";
  pool: string;
  token: string;
  sender: string;
  recipient: string;
  recipient_public_key: string;
  channel_key: string;
  note_index: number;
  block_number: number;
};

export type ReceiptVerdict = {
  amount: bigint;
  salt: bigint;
  checks: { name: string; slot: string; value: string; ok: boolean }[];
};

export function receiptStorageKeys(r: ReceiptV0): Felt[] {
  const ck = toFelt(r.channel_key), token = toFelt(r.token);
  const sender = toFelt(r.sender), recipient = toFelt(r.recipient), pk = toFelt(r.recipient_public_key);
  const base = slots.note(noteId(ck, token, r.note_index));
  return [
    slots.publicKey(recipient),
    slots.channelExists(channelMarker(ck, sender, recipient, pk)),
    slots.subchannelExists(subchannelMarker(ck, recipient, pk, token)),
    base,
    base + 1n,
  ];
}

/**
 * Verifies a receipt against a storage proof for the pool, anchored at `trustedStateRoot`.
 * Throws if any binding fails; returns the decrypted amount.
 */
export function verifyReceipt(r: ReceiptV0, proof: StorageProofResponse, trustedStateRoot: Felt): ReceiptVerdict {
  const keys = receiptStorageKeys(r);
  const reads = verifyContractStorage(proof, trustedStateRoot, toFelt(r.pool), keys);
  const [pkRead, chRead, subRead, packedRead, tokenRead] = reads;

  const checks = [
    { name: "public_key[recipient] == recipient_public_key", read: pkRead, ok: pkRead.value === toFelt(r.recipient_public_key) },
    { name: "channel_exists[marker(ck, sender, recipient, pk)]", read: chRead, ok: chRead.value === 1n },
    { name: "subchannel_exists[marker(ck, recipient, pk, token)]", read: subRead, ok: subRead.value === 1n },
    { name: "notes[note_id].packed_value present", read: packedRead, ok: packedRead.value !== 0n },
    { name: "notes[note_id].token == 0 (encrypted note)", read: tokenRead, ok: tokenRead.value === 0n },
  ].map((c) => ({ name: c.name, slot: hex(c.read.key), value: hex(c.read.value), ok: c.ok }));

  const { salt, encAmount } = unpackNote(packedRead.value);
  checks.push({ name: "salt >= 2 (encrypted, not open note)", slot: hex(packedRead.key), value: hex(salt), ok: salt >= 2n });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) throw Object.assign(new Error(`receipt rejected: ${failed.map((f) => f.name).join("; ")}`), { checks });

  const amount = decryptAmount(encAmount, toFelt(r.channel_key), toFelt(r.token), r.note_index, salt);
  return { amount, salt, checks };
}
