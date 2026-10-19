/**
 * Shared setup for the end-to-end scripts. Reads ../.env (same variable names snip36 uses),
 * builds a starknet.js account and, when needed, a Privacy SDK session.
 *
 * Secrets: STARKNET_PRIVATE_KEY is read from .env only. It is never printed or written anywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Account, RpcProvider, constants, ec, hash } from "starknet";

/** Per-network defaults. Anything set in the env file overrides them. */
export const NETWORKS = {
  SN_MAIN: {
    POOL: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
    // OHTTP proving/discovery services used by STRK20 wallets (operated by Ready/Argent). No API key.
    PROVING_URL: "https://cloud.argent-api.com/v1/privacy/proving",
    DISCOVERY_URL: "https://cloud.argent-api.com/v1/privacy/discovery",
    PROVING_OHTTP: "true",
    DISCOVERY_OHTTP: "true",
  },
  SN_SEPOLIA: {
    POOL: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
    // StarkWare's Sepolia services, as used by StarkWare's PriPay (server.js defaults), plain HTTP JSON.
    PROVING_URL: "https://transaction-prover.alpha-sepolia.sw-dev.io",
    DISCOVERY_URL: "https://discovery-service.alpha-sepolia.sw-dev.io",
    PROVING_OHTTP: "false",
    DISCOVERY_OHTTP: "false",
  },
} as const;

export type Env = {
  rpcUrl: string; chainId: "SN_MAIN" | "SN_SEPOLIA"; address: string; privateKey: string;
  pool: string; receipt?: string; sdkPath?: string; provingUrl: string; discoveryUrl: string; proveLag: number;
  provingOhttp: boolean; discoveryOhttp: boolean; file: string;
};

/** Env file: `--env <path>` (e.g. ../.env.sender), else ../../.env relative to this folder. */
export function envFile(): string {
  const i = process.argv.indexOf("--env");
  return i >= 0 ? resolve(process.argv[i + 1]) : resolve(import.meta.dirname, "../../.env");
}

export function loadEnv(file = envFile()): Env {
  const fileVars: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) fileVars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const chainId = (fileVars.STARKNET_CHAIN_ID ?? "SN_MAIN") as Env["chainId"];
  if (!(chainId in NETWORKS)) throw new Error(`STARKNET_CHAIN_ID must be SN_MAIN or SN_SEPOLIA, got ${chainId}`);
  const vars: Record<string, string> = { ...NETWORKS[chainId], PROVE_LAG: "15", ...fileVars };
  const need = (k: string) => { if (!vars[k]) throw new Error(`missing ${k} in ${file}`); return vars[k]; };
  for (const k of ["STARKNET_ACCOUNT_ADDRESS", "POOL", "RECEIPT_CONTRACT"]) {
    if (vars[k] && !/^0x[0-9a-fA-F]{1,64}$/.test(vars[k])) throw new Error(`${k} in ${file} is not a hex address: ${vars[k]}`);
  }
  return {
    file,
    rpcUrl: need("STARKNET_RPC_URL"),
    chainId,
    address: need("STARKNET_ACCOUNT_ADDRESS"),
    privateKey: need("STARKNET_PRIVATE_KEY"),
    pool: vars.POOL,
    receipt: vars.RECEIPT_CONTRACT || undefined,
    sdkPath: vars.PRIVACY_SDK || undefined,
    provingUrl: vars.PROVING_URL,
    discoveryUrl: vars.DISCOVERY_URL,
    // Prove against head - PROVE_LAG: the sequencer rejects a base block newer than ~10 blocks.
    proveLag: Number(vars.PROVE_LAG),
    provingOhttp: vars.PROVING_OHTTP === "true",
    discoveryOhttp: vars.DISCOVERY_OHTTP === "true",
  };
}

export function connect(env: Env) {
  const provider = new RpcProvider({ nodeUrl: env.rpcUrl });
  const account = new Account({ provider, address: env.address, signer: env.privateKey, cairoVersion: "1" });
  return { provider, account };
}

/** Canonical pool viewing key for a test account: poseidon([pk]) mod (n/2), never 0. */
export function viewingKey(privateKey: string): bigint {
  const max = ec.starkCurve.CURVE.n / 2n;
  const v = BigInt(hash.computePoseidonHashOnElements([privateKey])) % max;
  return v === 0n ? 1n : v;
}

/** Loads the locally built Privacy SDK (not on npm): PRIVACY_SDK=<starknet-privacy>/sdk */
export async function loadSdk(env: Env) {
  if (!env.sdkPath) throw new Error("Set PRIVACY_SDK to a built starknet-privacy/sdk (npm ci && npm run build).");
  const base = resolve(env.sdkPath, "dist");
  const imp = (p: string) => import(pathToFileURL(resolve(base, p)).href);
  const [main, testing, abi] = await Promise.all([imp("index.js"), imp("testing/index.js"), imp("internal/abi.js")]);
  return { ...main, ContractDiscoveryProvider: testing.ContractDiscoveryProvider, PrivacyPoolABI: abi.PrivacyPoolABI };
}

/**
 * Privacy SDK session. Discovery defaults to reading the pool directly over RPC (the viewing key never
 * leaves this machine). `indexer: true` uses the hosted discovery service over OHTTP instead.
 * Proving pool actions (register) uses the hosted proving service over OHTTP: it sees this account's
 * viewing key, which is acceptable for a dedicated test account only.
 */
export async function session(env: Env, opts: { indexer?: boolean } = {}) {
  const sdk = await loadSdk(env);
  const { provider, account } = connect(env);
  const head = await provider.getBlockNumber();
  const proveAt = head - env.proveLag;
  const { Contract } = await import("starknet");
  const discovery = opts.indexer
    ? new sdk.IndexerDiscoveryProvider(env.discoveryUrl, env.pool, env.discoveryOhttp ? { ohttp: true } : undefined)
    : new sdk.ContractDiscoveryProvider(
        new Contract({ abi: sdk.PrivacyPoolABI, address: env.pool, providerOrAccount: provider }),
        { rateLimit: { maxConcurrent: 4, minDelay: 50 } },
      );
  const transfers = sdk.createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey(env.privateKey) },
    provingProvider: {
      url: env.provingUrl,
      chainId: env.chainId === "SN_MAIN" ? constants.StarknetChainId.SN_MAIN : constants.StarknetChainId.SN_SEPOLIA,
      ...(env.provingOhttp ? { ohttp: true } : {}),
      nodeUrl: env.rpcUrl,
      blockIdentifier: proveAt,
    },
    discoveryProvider: discovery,
    poolContractAddress: env.pool,
  });
  return { sdk, provider, account, transfers, head, proveAt };
}

export const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
export const flag = (name: string) => process.argv.includes(`--${name}`);
export const hexOf = (v: bigint | number | string) => "0x" + BigInt(v).toString(16);
