"""Extract the recorded Pathfinder starknet_getStorageProof response from Juno's
rpc/v10/storage_test.go (TestStorageProof_VerifyPathfinderResponse) into JSON.

Usage: python3 -I extract_juno_fixture.py <path/to/storage_test.go> <out.json>
"""
import json
import re
import sys

src = open(sys.argv[1]).read()
start = src.index("func TestStorageProof_VerifyPathfinderResponse")
end = src.index("func TestStorageProof_StorageRoots")
block = src[start:end]

felt = r'"(0x[0-9a-fA-F]+)"'

nodes = []
node_re = re.compile(
    r"Node: &rpc\.(BinaryNode|EdgeNode)\{(.*?)\},\s*Hash: felt\.NewUnsafeFromString\[felt\.Felt\]\(\s*" + felt,
    re.S,
)
for kind, body, h in node_re.findall(block):
    if kind == "BinaryNode":
        left, right = re.findall(felt, body)
        nodes.append({"node_hash": h, "node": {"left": left, "right": right}})
    else:
        child = re.search(r"Child: felt\.NewUnsafeFromString\[felt\.Felt\]\(\s*" + felt, body, re.S).group(1)
        length = int(re.search(r"Length:\s*(\d+)", body).group(1))
        path = re.search(r"Path:\s*" + felt, body).group(1)
        nodes.append({"node_hash": h, "node": {"child": child, "length": length, "path": path}})

def grab(name):
    return re.search(name + r": felt\.NewUnsafeFromString\[felt\.Felt\]\(\s*" + felt, block, re.S).group(1)

checks = []
for addr_var, leaf_var in (("firstContractAddr", "firstContractLeaf"), ("secondContractAddr", "secondContractLeaf")):
    addr = re.search(addr_var + r" := felt\.NewUnsafeFromString\[felt\.Felt\]\(\s*" + felt, block, re.S).group(1)
    leaf = re.search(leaf_var + r" := felt\.NewUnsafeFromString\[felt\.Felt\]\(\s*" + felt, block, re.S).group(1)
    checks.append({"contract_address": addr, "expected_leaf": leaf})

out = {
    "_source": "NethermindEth/juno rpc/v10/storage_test.go TestStorageProof_VerifyPathfinderResponse (Pathfinder response, Sepolia block 10434)",
    "global_roots": {
        "block_hash": grab("BlockHash"),
        "classes_tree_root": grab("ClassesTreeRoot"),
        "contracts_tree_root": grab("ContractsTreeRoot"),
    },
    "contracts_proof_nodes": nodes,
    "checks": checks,
    # Mainnet block 2 roots from TestStorageProof_StorageRoots (global root composition check)
    "mainnet_block_2": {
        "global_root": "0x3ceee867d50b5926bb88c0ec7e0b9c20ae6b537e74aac44b8fcf6bb6da138d9",
        "classes_root": "0x0",
        "contracts_root": "0x3ceee867d50b5926bb88c0ec7e0b9c20ae6b537e74aac44b8fcf6bb6da138d9",
    },
}
json.dump(out, open(sys.argv[2], "w"), indent=2)
print(f"nodes={len(nodes)} checks={len(checks)}")
