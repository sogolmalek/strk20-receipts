/**
 * Verified contract-storage reads against a Starknet global state root, from a
 * `starknet_getStorageProof` response.
 *
 *   contract leaf  = pedersen(pedersen(pedersen(class_hash, storage_root), nonce), 0)
 *   global root    = poseidon("STARKNET_STATE_V0", contracts_root, classes_root)
 *                    (= contracts_root when classes_root == 0, pre-0.11 blocks)
 *   contracts trie, storage tries: Pedersen;  classes trie: Poseidon
 */
import { Felt, hex, pedersenHash, poseidon, shortString, toFelt } from "./felt.js";
import { NodeHashToNode, findRoot, verifyProof } from "./trie.js";

export function globalStateRoot(contractsRoot: Felt, classesRoot: Felt): Felt {
  if (classesRoot === 0n) return contractsRoot;
  return poseidon([shortString("STARKNET_STATE_V0"), contractsRoot, classesRoot]);
}

export function contractLeafHash(classHash: Felt, storageRoot: Felt, nonce: Felt): Felt {
  const h1 = pedersenHash(classHash, storageRoot);
  const h2 = pedersenHash(h1, nonce);
  return pedersenHash(h2, 0n);
}

export type StorageProofResponse = {
  classes_proof: NodeHashToNode[];
  contracts_proof: {
    nodes: NodeHashToNode[];
    contract_leaves_data: { nonce: string; class_hash: string; storage_root?: string }[];
  };
  contracts_storage_proofs: NodeHashToNode[][];
  global_roots: { contracts_tree_root: string; classes_tree_root: string; block_hash: string };
};

export type VerifiedRead = { key: Felt; value: Felt };

/**
 * Verifies `keys` of a single `contract` against `trustedStateRoot`.
 * The response must come from getStorageProof(block, [], [contract], [{contract, keys}]).
 * Nothing in the response is trusted except through the hash chain to `trustedStateRoot`.
 */
export function verifyContractStorage(
  resp: StorageProofResponse,
  trustedStateRoot: Felt,
  contract: Felt,
  keys: Felt[],
): VerifiedRead[] {
  const contractsRoot = toFelt(resp.global_roots.contracts_tree_root);
  const classesRoot = toFelt(resp.global_roots.classes_tree_root);
  const computedGlobal = globalStateRoot(contractsRoot, classesRoot);
  if (computedGlobal !== trustedStateRoot) {
    throw new Error(`global root mismatch: proof gives ${hex(computedGlobal)}, trusted root is ${hex(trustedStateRoot)}`);
  }

  // 1. contract leaf inside the contracts trie
  const leafInTrie = verifyProof(contractsRoot, contract, resp.contracts_proof.nodes, pedersenHash);
  if (leafInTrie === 0n) throw new Error(`contract ${hex(contract)} not present in state`);
  const leafData = resp.contracts_proof.contract_leaves_data[0];
  if (!leafData) throw new Error("missing contract_leaves_data");

  const storageNodes = resp.contracts_storage_proofs[0] ?? [];
  const storageRoot = leafData.storage_root !== undefined
    ? toFelt(leafData.storage_root)
    : storageNodes.length ? findRoot(storageNodes, pedersenHash) : 0n;

  const expectedLeaf = contractLeafHash(toFelt(leafData.class_hash), storageRoot, toFelt(leafData.nonce));
  if (expectedLeaf !== leafInTrie) {
    throw new Error(`contract leaf mismatch: trie has ${hex(leafInTrie)}, leaf data hashes to ${hex(expectedLeaf)}`);
  }

  // 2. each storage key inside the contract's storage trie
  return keys.map((key) => ({ key, value: verifyProof(storageRoot, key, storageNodes, pedersenHash) }));
}
