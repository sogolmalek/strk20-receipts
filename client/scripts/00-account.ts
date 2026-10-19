/**
 * Step 0a: a dedicated test account (OZ class pinned by snip36 for SNIP-36 virtual blocks).
 *
 *   npx tsx scripts/00-account.ts --new       # writes a fresh key into ../.env, prints the address to fund
 *   npx tsx scripts/00-account.ts --deploy    # after funding: deploys the account
 *   add --env ../.env.sender to work on a second account file (Sepolia sender)
 *
 * The private key is written to ../.env (mode 600) and never printed.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account, RpcProvider, ec, hash, stark } from "starknet";
import { envFile, flag } from "./lib.js";

/** OZ account class used by snip36's own mainnet/sepolia runs (scripts/deploy_mainnet_account.py). */
const OZ_CLASS_HASH = "0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564";
const envPath = envFile();

const read = () => existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const get = (k: string) => read().match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();

if (flag("new")) {
  if (get("STARKNET_PRIVATE_KEY")) throw new Error(".env already has STARKNET_PRIVATE_KEY; refusing to overwrite it.");
  const pk = stark.randomAddress();
  const pub = ec.starkCurve.getStarkKey(pk);
  const address = hash.calculateContractAddressFromHash(pub, OZ_CLASS_HASH, [pub], 0);
  if (!existsSync(envPath)) writeFileSync(envPath, "");
  appendFileSync(envPath, `STARKNET_PRIVATE_KEY=${pk}\nSTARKNET_ACCOUNT_ADDRESS=${address}\n`);
  chmodSync(envPath, 0o600);
  console.log(`New account (not deployed yet): ${address}`);
  console.log("Send it some STRK (about 20 is plenty for the whole flow), then run with --deploy.");
} else if (flag("deploy")) {
  const rpc = get("STARKNET_RPC_URL"); const pk = get("STARKNET_PRIVATE_KEY"); const address = get("STARKNET_ACCOUNT_ADDRESS");
  if (!rpc || !pk || !address) throw new Error("need STARKNET_RPC_URL, STARKNET_PRIVATE_KEY, STARKNET_ACCOUNT_ADDRESS in .env");
  const provider = new RpcProvider({ nodeUrl: rpc });
  try {
    await provider.getClassHashAt(address);
    console.log("Already deployed:", address);
    process.exit(0);
  } catch { /* not deployed yet */ }
  const pub = ec.starkCurve.getStarkKey(pk);
  const account = new Account({ provider, address, signer: pk, cairoVersion: "1" });
  const res = await account.deployAccount({ classHash: OZ_CLASS_HASH, constructorCalldata: [pub], addressSalt: pub, contractAddress: address });
  console.log("deploy_account tx:", res.transaction_hash);
  await provider.waitForTransaction(res.transaction_hash, { retryInterval: 3000 });
  console.log("Deployed:", address);
} else {
  console.log("usage: 00-account.ts --new | --deploy");
}
