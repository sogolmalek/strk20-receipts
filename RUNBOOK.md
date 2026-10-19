# Runbook: first receipt on mainnet

Goal: one real payment, one SNIP-36 proof of it, one registered receipt, verified from the opening.
Spend: small amounts of STRK (pool fee per shielded action, gas, a declare and a deploy).
Use a dedicated test account. Its private key lives only in `.env` on your machine.

## 0. Tools (once)

```bash
# Cairo toolchain: scarb 2.18.0 + starknet-foundry 0.63.0
curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.sh | sh

# SNIP-36 prover (prebuilt for macOS arm64 / Linux)
curl -fsSL https://github.com/starknet-innovation/snip-36-prover-backend/releases/latest/download/install.sh | sh
snip36 setup --prebuilt
snip36 doctor                     # must pass

# STRK20 Privacy SDK (not on npm): build it once
git clone https://github.com/starkware-libs/starknet-privacy && cd starknet-privacy
git checkout caab04dc990aca75f190c8b9f97c60dd0e4f1b28
cd sdk && npm ci && npm run build && cd ../..
```

Node >= 24 is required by the SDK.

## 1. This repo

```bash
cp .env.example .env              # set STARKNET_RPC_URL and PRIVACY_SDK=<path>/starknet-privacy/sdk
cd contracts && scarb build && snforge test && cd ..
cd client && npm install && npm test
```

## 2. Test account

```bash
npx tsx scripts/00-account.ts --new       # writes key to ../.env, prints the address
# send ~20 STRK to that address from your own wallet
npx tsx scripts/00-account.ts --deploy
```

## 3. Deploy the receipt contract

```bash
npx tsx scripts/00-deploy-receipt.ts      # prints RECEIPT_CONTRACT=0x…  → put it in ../.env
```

## 4. Make the account a STRK20 recipient

```bash
npx tsx scripts/01-register.ts            # dry run: proves and validates, sends nothing
npx tsx scripts/01-register.ts --send
```

Registration is proved by the hosted proving service over OHTTP. It sees this test account's viewing
key, which is why the account is dedicated to this test.

## 5. Get paid privately

From your own STRK20-enabled wallet (Ready or Xverse): shield a small amount and send it **privately**
to the test account address. Wait a few minutes for it to be indexed.

```bash
npx tsx scripts/02-find-notes.ts                          # lists received notes
npx tsx scripts/02-find-notes.ts --pick 0 --out private-note.json
```

`private-note.json` contains the channel key. Do not share it.

## 6. Build the virtual transaction

```bash
npx tsx scripts/03-make-virtual-tx.ts --note private-note.json \
  --claim atLeast:<amount-in-base-units> --reference INV-2026-001
```

It prints the base block and writes `out/receipt_tx.json` (private), `out/opening.json`
(for the verifier) and `out/meta.json`.

## 7. Prove locally

```bash
snip36 prove virtual-os --block-number <BASE_BLOCK> --tx-json out/receipt_tx.json \
  --rpc-url "$STARKNET_RPC_URL" --output out/receipt.proof
```

Do not pass `--prover-url`: the input contains the channel key, so proving stays on this machine.
Outputs: `out/receipt.proof`, `out/receipt.proof_facts`, `out/receipt.raw_messages.json`.

## 8. Register the receipt

Within `proof_validity_blocks` (450) of the base block:

```bash
npx tsx scripts/04-register-receipt.ts            # checks message + proof facts, prints commands
npx tsx scripts/04-register-receipt.ts --send     # submits register_receipt with the proof
```

If the starknet.js submission is rejected, use the `snip36 submit …` command the script prints.

## 9. Verify as a third party

```bash
npx tsx scripts/05-verify.ts --opening out/opening.json --rpc "$STARKNET_RPC_URL"
```

Keep the transaction hashes from steps 3, 8 and the verifier output: they go in the grant application.

## If something fails

Send the full command output (never the `.env` or `private-note.json`). Likely spots:
- the RPC lacks a method the prover or SDK needs → try another provider;
- `PRIVATE_KEY_NOT_CANONICAL` or `INDEX_NOT_SEQUENTIAL` from the proving service → wait and retry;
- virtual OS rejects the account → re-create the account with step 2 (it uses snip36's account class).
