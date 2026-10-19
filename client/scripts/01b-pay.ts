/**
 * Sepolia rehearsal, path A (real STRK20 pool): pay the receipt account privately from a SECOND
 * test account. On mainnet you would do this from Ready instead.
 *
 *   npx tsx scripts/01b-pay.ts --env ../.env.sender --to <recipient address> --amount 1000000000000000000
 *   ... add --send to submit (default is a dry run that proves and validates only)
 *
 * The recipient must be registered first (scripts/01-register.ts with its own env file).
 * The first deposit of a fresh sender is register + setup + deposit + transfer in one action.
 */
import { arg, flag, hexOf, loadEnv, session } from "./lib.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const env = loadEnv();
const to = arg("to");
const amount = BigInt(arg("amount") ?? "1000000000000000000"); // 1 STRK
const token = arg("token") ?? STRK;
if (!to) throw new Error("--to <recipient address> required");

const s = await session(env);
const recipientPk = await s.provider.callContract({ contractAddress: env.pool, entrypoint: "get_public_key", calldata: [to] });
if (BigInt(recipientPk[0]) === 0n) throw new Error(`${to} is not registered in the pool yet; run 01-register.ts for it first.`);

// The pool pulls the deposit and its fee with transferFrom: approve generously first (ordinary tx).
const fee = BigInt((await s.provider.callContract({ contractAddress: env.pool, entrypoint: "get_fee_amount", calldata: [] }).catch(() => ["0"]))[0]);
const allowance = amount + fee * 4n + 10n ** 18n;
console.log(`Pool fee per action: ${fee} (raw). Approving ${allowance} of ${token}.`);

console.log(`Proving deposit ${amount} + private transfer to ${to} against block ${s.proveAt}...`);
const proved = await s.transfers
  .build({ autoRegister: true, autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } })
  .with(token, (t: any) => t.deposit({ amount }).transfer({ recipient: to, amount }))
  .surplusTo(env.address)
  .execute();
console.log("Proved. Warnings:", JSON.stringify(proved.warnings ?? []));

if (!flag("send")) {
  console.log("Dry run: nothing sent. Re-run with --send to approve and submit.");
  process.exit(0);
}
const approve = await s.account.execute([{ contractAddress: token, entrypoint: "approve", calldata: [env.pool, hexOf(allowance), "0x0"] }]);
await s.provider.waitForTransaction(approve.transaction_hash, { retryInterval: 3000 });
console.log("Approve tx:", approve.transaction_hash);
const sent = await s.account.execute([proved.callAndProof.call], {
  proofFacts: proved.callAndProof.proof.proofFacts,
  proof: proved.callAndProof.proof.data,
});
console.log("Private payment tx:", sent.transaction_hash);
await s.provider.waitForTransaction(sent.transaction_hash, { retryInterval: 3000 });
console.log("Done. On the recipient side run: npx tsx scripts/02-find-notes.ts");
