/**
 * Verifier for Starknet's binary Merkle-Patricia trie proofs, as returned by
 * `starknet_getStorageProof` (JSON-RPC spec v0.8+).
 *
 *   binary node:  H(left, right)
 *   edge node:    H(child, path) + length   (mod P)
 *   key height:   251 bits, walked from the most significant bit
 *
 * Every node's hash is recomputed; the RPC-supplied `node_hash` is never trusted.
 */
import { Felt, HashFn, P, hex, toFelt } from "./felt.js";

export const TRIE_HEIGHT = 251;

export type BinaryNode = { left: string; right: string };
export type EdgeNode = { child: string; path: string; length: number };
export type NodeHashToNode = { node_hash: string; node: BinaryNode | EdgeNode };

const isEdge = (n: BinaryNode | EdgeNode): n is EdgeNode => "child" in n;

export function nodeHash(node: BinaryNode | EdgeNode, h: HashFn): Felt {
  if (isEdge(node)) {
    return (h(toFelt(node.child), toFelt(node.path)) + BigInt(node.length)) % P;
  }
  return h(toFelt(node.left), toFelt(node.right));
}

/** Index proof nodes by their *recomputed* hash. Rejects any node whose claimed hash is wrong. */
export function indexNodes(nodes: NodeHashToNode[], h: HashFn): Map<Felt, BinaryNode | EdgeNode> {
  const m = new Map<Felt, BinaryNode | EdgeNode>();
  for (const { node_hash, node } of nodes) {
    const computed = nodeHash(node, h);
    if (computed !== toFelt(node_hash)) {
      throw new Error(`proof node hash mismatch: claimed ${node_hash}, computed ${hex(computed)}`);
    }
    m.set(computed, node);
  }
  return m;
}

/**
 * Walk from `root` to `key`. Returns the leaf value, or 0n when the proof shows
 * the key is absent (non-membership via a diverging edge). Throws if the proof
 * is incomplete or inconsistent.
 */
export function verifyProof(root: Felt, key: Felt, nodes: NodeHashToNode[], h: HashFn): Felt {
  if (key >= 2n ** BigInt(TRIE_HEIGHT)) throw new Error(`key exceeds trie height: ${hex(key)}`);
  if (root === 0n) return 0n; // empty trie
  const byHash = indexNodes(nodes, h);
  let current = root;
  let height = TRIE_HEIGHT;
  while (height > 0) {
    const node = byHash.get(current);
    if (!node) throw new Error(`proof missing node ${hex(current)} at height ${height}`);
    if (isEdge(node)) {
      const len = node.length;
      if (len < 1 || len > height) throw new Error(`invalid edge length ${len} at height ${height}`);
      const expected = (key >> BigInt(height - len)) & ((1n << BigInt(len)) - 1n);
      if (expected !== toFelt(node.path)) return 0n; // key not in trie
      current = toFelt(node.child);
      height -= len;
    } else {
      const bit = (key >> BigInt(height - 1)) & 1n;
      current = toFelt(bit === 0n ? node.left : node.right);
      height -= 1;
    }
  }
  return current;
}

/** Root of a trie given only its nodes: the single node hash not referenced as a child. */
export function findRoot(nodes: NodeHashToNode[], h: HashFn): Felt {
  const byHash = indexNodes(nodes, h);
  const children = new Set<Felt>();
  for (const n of byHash.values()) {
    if (isEdge(n)) children.add(toFelt(n.child));
    else { children.add(toFelt(n.left)); children.add(toFelt(n.right)); }
  }
  const roots = [...byHash.keys()].filter((k) => !children.has(k));
  if (roots.length !== 1) throw new Error(`cannot determine unique root (${roots.length} candidates)`);
  return roots[0];
}

// ---------------------------------------------------------------------------
// Trie builder (test/mock use only): builds a trie from key->value entries and
// returns its root plus the proof nodes for any key, in RPC format.
// ---------------------------------------------------------------------------

export class TestTrie {
  readonly root: Felt;
  private nodes = new Map<Felt, BinaryNode | EdgeNode>();

  constructor(entries: Map<Felt, Felt>, private h: HashFn) {
    const keys = [...entries.entries()].filter(([, v]) => v !== 0n).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    this.root = keys.length === 0 ? 0n : this.build(keys, TRIE_HEIGHT);
  }

  private put(node: BinaryNode | EdgeNode): Felt {
    const hh = nodeHash(node, this.h);
    this.nodes.set(hh, node);
    return hh;
  }

  /** Builds the subtrie for `items` whose keys agree on all bits above `height`. */
  private build(items: [Felt, Felt][], height: number): Felt {
    if (height === 0) return items[0][1];
    const bitsOf = (k: Felt, from: number, len: number) => (k >> BigInt(from - len)) & ((1n << BigInt(len)) - 1n);
    // longest common prefix of the remaining `height` bits
    let common = 0;
    while (common < height && items.every(([k]) => bitsOf(k, height, common + 1) === bitsOf(items[0][0], height, common + 1))) common++;
    if (common > 0) {
      const child = this.build(items, height - common);
      return this.put({ child: hex(child), path: hex(bitsOf(items[0][0], height, common)), length: common });
    }
    const left = items.filter(([k]) => ((k >> BigInt(height - 1)) & 1n) === 0n);
    const right = items.filter(([k]) => ((k >> BigInt(height - 1)) & 1n) === 1n);
    const l = this.build(left, height - 1);
    const r = this.build(right, height - 1);
    return this.put({ left: hex(l), right: hex(r) });
  }

  /** Proof nodes along the path to `key` (works for absent keys too). */
  proof(key: Felt): NodeHashToNode[] {
    const out: NodeHashToNode[] = [];
    let current = this.root;
    let height = TRIE_HEIGHT;
    while (height > 0 && current !== 0n) {
      const node = this.nodes.get(current);
      if (!node) break;
      out.push({ node_hash: hex(current), node });
      if (isEdge(node)) {
        const expected = (key >> BigInt(height - node.length)) & ((1n << BigInt(node.length)) - 1n);
        if (expected !== toFelt(node.path)) break;
        current = toFelt(node.child);
        height -= node.length;
      } else {
        current = toFelt(((key >> BigInt(height - 1)) & 1n) === 0n ? node.left : node.right);
        height -= 1;
      }
    }
    return out;
  }
}
