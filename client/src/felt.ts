import { pedersen, poseidonHashMany, keccak } from "@scure/starknet";

/** Stark field prime. */
export const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
export const TWO_128 = 2n ** 128n;

export type Felt = bigint;
export type HashFn = (a: Felt, b: Felt) => Felt;

export const toFelt = (v: string | number | bigint): Felt => {
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n || n >= P) throw new Error(`value out of field range: ${v}`);
  return n;
};

export const hex = (v: Felt): string => "0x" + v.toString(16);

/** Cairo short string literal -> felt (<= 31 ASCII chars). */
export const shortString = (s: string): Felt => {
  if (s.length > 31) throw new Error(`short string too long: ${s}`);
  let n = 0n;
  for (const ch of s) n = (n << 8n) | BigInt(ch.charCodeAt(0));
  return n;
};

export const pedersenHash: HashFn = (a, b) => BigInt(pedersen(a, b));
export const poseidonPair: HashFn = (a, b) => poseidonHashMany([a, b]);
export const poseidon = (xs: Felt[]): Felt => poseidonHashMany(xs);

/** Starknet keccak (sn_keccak): keccak256 masked to 250 bits. */
export const snKeccak = (name: string): Felt => keccak(new TextEncoder().encode(name));
