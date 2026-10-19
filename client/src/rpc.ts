import { Felt, hex } from "./felt.js";
import { StorageProofResponse } from "./state.js";

let id = 0;
export async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message} ${JSON.stringify(body.error.data ?? "")}`);
  return body.result as T;
}

export type BlockId = "latest" | { block_number: number } | { block_hash: string };

export async function blockHeader(url: string, block: number | BlockId = "latest") {
  const block_id = typeof block === "number" ? { block_number: block } : block;
  const b = await rpc<{ block_number: number; block_hash: string; new_root: string }>(url, "starknet_getBlockWithTxHashes", { block_id });
  return { number: b.block_number, hash: b.block_hash, newRoot: BigInt(b.new_root) };
}

export async function storageProof(url: string, block: BlockId, contract: Felt, keys: Felt[]): Promise<StorageProofResponse> {
  return rpc<StorageProofResponse>(url, "starknet_getStorageProof", {
    block_id: block,
    class_hashes: [],
    contract_addresses: [hex(contract)],
    contracts_storage_keys: [{ contract_address: hex(contract), storage_keys: keys.map(hex) }],
  });
}

export async function storageAt(url: string, block: BlockId, contract: Felt, key: Felt): Promise<Felt> {
  return BigInt(await rpc<string>(url, "starknet_getStorageAt", {
    contract_address: hex(contract), key: hex(key), block_id: block,
  }));
}
