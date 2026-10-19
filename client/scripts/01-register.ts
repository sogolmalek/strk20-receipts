/**
 * Step 1: register this account's viewing key in the STRK20 pool so it can RECEIVE private payments.
 *
 *   npx tsx scripts/01-register.ts          # prove only (dry run, costs nothing, validates server-side)
 *   npx tsx scripts/01-register.ts --send   # prove and submit (pays the pool fee + gas)
 */
import { flag, loadEnv, session } from "./lib.js";

const env = loadEnv();
const s = await session(env);

const pk = await s.provider.callContract({ contractAddress: env.pool, entrypoint: "get_public_key", calldata: [env.address] });
if (BigInt(pk[0]) !== 0n) {
  console.log(`Already registered (public key ${pk[0]}). Nothing to do.`);
  process.exit(0);
}

console.log(`Proving registration against block ${s.proveAt} (head ${s.head})...`);
const proved = await s.transfers.build().register().execute();
console.log(`Proved. Calldata felts: ${proved.callAndProof.call.calldata.length}`);

if (!flag("send")) {
  console.log("Dry run: nothing sent. Re-run with --send to submit.");
  process.exit(0);
}
const sent = await s.account.execute([proved.callAndProof.call], {
  proofFacts: proved.callAndProof.proof.proofFacts,
  proof: proved.callAndProof.proof.data,
});
console.log(`Submitted: ${sent.transaction_hash}`);
await s.provider.waitForTransaction(sent.transaction_hash, { retryInterval: 3000 });
console.log("Registered. Give this address to the sender:", env.address);
