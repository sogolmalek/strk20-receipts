/**
 * Step 0b: declare + deploy PaymentReceipt (after `scarb build` in ../../contracts).
 *
 *   npx tsx scripts/00-deploy-receipt.ts [--validity 450]
 *
 * Constructor: (pool, proof_validity_blocks). Prints the address to put in .env as RECEIPT_CONTRACT.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { arg, connect, loadEnv } from "./lib.js";

const env = loadEnv();
const { provider, account } = connect(env);
const dir = resolve(import.meta.dirname, "../../contracts/target/dev");
const sierra = JSON.parse(readFileSync(resolve(dir, "payment_receipt_PaymentReceipt.contract_class.json"), "utf8"));
const casm = JSON.parse(readFileSync(resolve(dir, "payment_receipt_PaymentReceipt.compiled_contract_class.json"), "utf8"));
const validity = arg("validity") ?? "450";

const res = await account.declareAndDeploy({ contract: sierra, casm, constructorCalldata: [env.pool, validity] });
await provider.waitForTransaction(res.deploy.transaction_hash, { retryInterval: 3000 });
console.log("class hash:", res.declare.class_hash);
console.log("RECEIPT_CONTRACT=" + res.deploy.contract_address);
