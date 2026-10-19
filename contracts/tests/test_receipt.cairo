//! Spike tests: the receipt contract against the REAL STRK20 pool contract (privacy::privacy::Privacy),
//! with pool storage seeded at the exact slots and values from StarkWare's Cairo reference vectors
//! (starknet-privacy sdk/tests/fixtures/cairo-reference-data.json).
use core::num::traits::Zero;
use payment_receipt::receipt::{
    AmountClaim, IPaymentReceiptDispatcher, IPaymentReceiptDispatcherTrait, PaymentFact, ProofFacts,
    hashing,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, MessageToL1SpyAssertionsTrait, declare,
    get_class_hash, spy_messages_to_l1, start_cheat_block_number, start_cheat_proof_facts, store,
};
use starknet::ContractAddress;

// --- Cairo reference vectors -------------------------------------------------------------
const CK: felt252 = 0xdef;
const SENDER: felt252 = 0x123;
const RECIPIENT: felt252 = 0x456;
const RECIPIENT_PK: felt252 = 0xabc;
const TOKEN: felt252 = 0x1234;
const INDEX: usize = 5;
const AMOUNT: u128 = 1000;
const PACKED_NOTE: felt252 = 0x5678e860f260ec796ecdd862d35616ea6f28; // outputs.encNoteAmount
// slots (fixture "slots")
const SLOT_RECIPIENT_PK: felt252 = 0x703dc5fd86f5987705cf14bd6c50c0e55120f37a0ecac2d8895ccd7e909e62f;
const SLOT_CHANNEL_EXISTS: felt252 =
    0x4f06b03b13f7c07258b1511863de37c23aaeb1788ab31033485214777a2fbee;
const SLOT_SUBCHANNEL_EXISTS: felt252 =
    0x3751517ee3ad8e8c32d34b55e6c4997d36ccb713a20a95256b42a3dc387331d;
const SLOT_NOTE: felt252 = 0x5d4262aaab99930ce4823d3409f1c043542f144522081296890bcf6b92a025d;
// fixture outputs (computed by the pool's own Cairo code)
const REF_CHANNEL_MARKER: felt252 =
    0x750d461a5bf2f1abcd22c04af817e946d1a81e69402c2e0fc24663e70194a2c;
const REF_SUBCHANNEL_MARKER: felt252 =
    0x777b17d81fbb126303906d8076aa8dadaec72a6a25a3e31b51946216edeed7c;
const REF_NOTE_ID: felt252 = 0x6b098ad0b0b4b1881a77f962eb0650de748f24efcabd5a64ac941e9a05777e8;

const VALIDITY: u64 = 450;
const BLINDING: felt252 = 0xb11d;
const REFERENCE: felt252 = 'INVOICE-2026-042';

fn addr(v: felt252) -> ContractAddress {
    v.try_into().unwrap()
}

/// Deploys the real pool + the receipt contract, and seeds one encrypted note in the pool.
fn setup() -> (ContractAddress, IPaymentReceiptDispatcher) {
    let pool_class = declare("Privacy").unwrap().contract_class();
    let (pool, _) = pool_class
        .deploy(@array![0x999, 0x111, 0x222, VALIDITY.into()])
        .unwrap(); // governance_admin, auditor_pk, screener_pk, proof_validity_blocks
    store(pool, SLOT_RECIPIENT_PK, [RECIPIENT_PK].span());
    store(pool, SLOT_CHANNEL_EXISTS, [1].span());
    store(pool, SLOT_SUBCHANNEL_EXISTS, [1].span());
    store(pool, SLOT_NOTE, [PACKED_NOTE, 0].span()); // Note { packed_value, token: 0 }

    let receipt_class = declare("PaymentReceipt").unwrap().contract_class();
    let (receipt, _) = receipt_class.deploy(@array![pool.into(), VALIDITY.into()]).unwrap();
    (pool, IPaymentReceiptDispatcher { contract_address: receipt })
}

fn fact(pool: ContractAddress, claim: AmountClaim) -> PaymentFact {
    PaymentFact {
        pool, token: addr(TOKEN), sender: addr(SENDER), recipient: addr(RECIPIENT), claim,
        reference: REFERENCE,
    }
}

fn prove(r: IPaymentReceiptDispatcher, sender: felt252, index: usize, claim: AmountClaim) -> felt252 {
    r
        .prove_payment(
            CK, addr(TOKEN), addr(sender), addr(RECIPIENT), index, claim, REFERENCE, BLINDING,
        )
}

// --- derivations ---------------------------------------------------------------------------

#[test]
fn hashing_matches_pool_reference_vectors() {
    assert_eq!(
        hashing::channel_marker(CK, addr(SENDER), addr(RECIPIENT), RECIPIENT_PK), REF_CHANNEL_MARKER,
    );
    assert_eq!(
        hashing::subchannel_marker(CK, addr(RECIPIENT), RECIPIENT_PK, addr(TOKEN)),
        REF_SUBCHANNEL_MARKER,
    );
    assert_eq!(hashing::note_id(CK, addr(TOKEN), INDEX), REF_NOTE_ID);
    let (salt, amount) = hashing::decrypt(PACKED_NOTE, CK, addr(TOKEN), INDEX);
    assert_eq!(salt, 0x5678);
    assert_eq!(amount, AMOUNT);
}

// --- PROVE: the virtual-block function, run against the real pool ----------------------------

#[test]
fn prove_exact_amount_emits_only_the_commitment() {
    let (pool, r) = setup();
    let mut spy = spy_messages_to_l1();
    let c = prove(r, SENDER, INDEX, AmountClaim::Exact(AMOUNT));

    assert_eq!(c, hashing::commitment(@fact(pool, AmountClaim::Exact(AMOUNT)), BLINDING));
    let class_hash: felt252 = get_class_hash(r.contract_address).into();
    spy
        .assert_sent(
            @array![
                (
                    r.contract_address,
                    snforge_std::MessageToL1 {
                        to_address: Zero::zero(), payload: array![class_hash, c],
                    },
                ),
            ],
        );
}

#[test]
fn prove_threshold_claim() {
    let (_, r) = setup();
    prove(r, SENDER, INDEX, AmountClaim::AtLeast(500));
    prove(r, SENDER, INDEX, AmountClaim::AtLeast(1000));
}

#[test]
#[should_panic(expected: 'RECEIPT: claim does not hold')]
fn prove_rejects_false_threshold() {
    let (_, r) = setup();
    prove(r, SENDER, INDEX, AmountClaim::AtLeast(1001));
}

#[test]
#[should_panic(expected: 'RECEIPT: claim does not hold')]
fn prove_rejects_wrong_exact_amount() {
    let (_, r) = setup();
    prove(r, SENDER, INDEX, AmountClaim::Exact(999));
}

#[test]
#[should_panic(expected: 'RECEIPT: channel not found')]
fn prove_rejects_wrong_sender() {
    let (_, r) = setup();
    prove(r, 0x777, INDEX, AmountClaim::Exact(AMOUNT));
}

#[test]
#[should_panic(expected: 'RECEIPT: note not found')]
fn prove_rejects_missing_note() {
    let (_, r) = setup();
    prove(r, SENDER, INDEX + 1, AmountClaim::AtLeast(0));
}

#[test]
#[should_panic(expected: 'RECEIPT: channel not found')]
fn prove_rejects_wrong_channel_key() {
    let (_, r) = setup();
    r
        .prove_payment(
            CK + 1, addr(TOKEN), addr(SENDER), addr(RECIPIENT), INDEX, AmountClaim::AtLeast(0),
            REFERENCE, BLINDING,
        );
}

#[test]
#[should_panic(expected: 'RECEIPT: subchannel not found')]
fn prove_rejects_wrong_token() {
    let (_, r) = setup();
    r
        .prove_payment(
            CK, addr(0x9999), addr(SENDER), addr(RECIPIENT), INDEX, AmountClaim::AtLeast(0),
            REFERENCE, BLINDING,
        );
}

// --- REGISTER: real tx carrying proof facts ----------------------------------------------------

fn facts_for(r: IPaymentReceiptDispatcher, commitment: felt252, base_block: u64) -> Array<felt252> {
    let class_hash: felt252 = get_class_hash(r.contract_address).into();
    let msg = hashing::message_hash(r.contract_address, class_hash, commitment);
    let facts = ProofFacts {
        proof_version: 0,
        program_variant: 'VIRTUAL_SNOS',
        virtual_program_hash: 0,
        starknet_os_output_version: 'VIRTUAL_SNOS0',
        base_block_number: base_block,
        base_block_hash: 0,
        starknet_os_config_hash: 0,
        message_to_l1_hashes: [msg].span(),
    };
    let mut out = array![];
    facts.serialize(ref out);
    out
}

#[test]
fn register_records_commitment_with_valid_proof_facts() {
    let (_, r) = setup();
    let c = prove(r, SENDER, INDEX, AmountClaim::Exact(AMOUNT));
    start_cheat_block_number(r.contract_address, 1000);
    start_cheat_proof_facts(r.contract_address, facts_for(r, c, 990).span());
    r.register_receipt(c);
    assert_eq!(r.registered_at(c), 1000);
    assert_eq!(r.registered_at(c + 1), 0);
}

#[test]
#[should_panic(expected: 'RECEIPT: proof msg mismatch')]
fn register_rejects_commitment_not_in_proof() {
    let (_, r) = setup();
    let c = prove(r, SENDER, INDEX, AmountClaim::Exact(AMOUNT));
    start_cheat_block_number(r.contract_address, 1000);
    start_cheat_proof_facts(r.contract_address, facts_for(r, c, 990).span());
    r.register_receipt(c + 1); // claims a different fact than was proven
}

#[test]
#[should_panic(expected: 'RECEIPT: proof expired')]
fn register_rejects_expired_proof() {
    let (_, r) = setup();
    let c = prove(r, SENDER, INDEX, AmountClaim::Exact(AMOUNT));
    start_cheat_block_number(r.contract_address, 2000);
    start_cheat_proof_facts(r.contract_address, facts_for(r, c, 1000).span());
    r.register_receipt(c);
}

#[test]
#[should_panic(expected: 'RECEIPT: empty proof facts')]
fn register_rejects_tx_without_proof() {
    let (_, r) = setup();
    r.register_receipt(0x1234);
}

#[test]
#[should_panic(expected: 'RECEIPT: proof msg mismatch')]
fn register_rejects_message_from_another_contract() {
    // A proof whose message came from a different contract (e.g. an attacker's look-alike) must
    // not register here, even with the same payload.
    let (_, r) = setup();
    let c = prove(r, SENDER, INDEX, AmountClaim::Exact(AMOUNT));
    let class_hash: felt252 = get_class_hash(r.contract_address).into();
    let forged = hashing::message_hash(addr(0xbad), class_hash, c);
    let facts = ProofFacts {
        proof_version: 0, program_variant: 'VIRTUAL_SNOS', virtual_program_hash: 0,
        starknet_os_output_version: 'VIRTUAL_SNOS0', base_block_number: 990, base_block_hash: 0,
        starknet_os_config_hash: 0, message_to_l1_hashes: [forged].span(),
    };
    let mut out = array![];
    facts.serialize(ref out);
    start_cheat_block_number(r.contract_address, 1000);
    start_cheat_proof_facts(r.contract_address, out.span());
    r.register_receipt(c);
}

// --- VERIFY: what a verifier does with the opening -------------------------------------------

#[test]
fn verifier_recomputes_commitment_from_opening_without_any_key() {
    let (pool, r) = setup();
    let c = prove(r, SENDER, INDEX, AmountClaim::AtLeast(800));
    start_cheat_block_number(r.contract_address, 1000);
    start_cheat_proof_facts(r.contract_address, facts_for(r, c, 990).span());
    r.register_receipt(c);

    // Verifier gets: fact (pool, token, sender, recipient, "at least 800", reference) + blinding.
    let opened = hashing::commitment(@fact(pool, AmountClaim::AtLeast(800)), BLINDING);
    assert(r.registered_at(opened) != 0, 'opening must be registered');
    // A tampered opening (claims more) is not registered.
    let tampered = hashing::commitment(@fact(pool, AmountClaim::AtLeast(5000)), BLINDING);
    assert_eq!(r.registered_at(tampered), 0);
}

// --- cross-language vectors (must equal client/test/receipt.test.ts) ------------------------

#[test]
fn commitment_and_message_hash_match_client_vectors() {
    let f = PaymentFact {
        pool: addr(0x111), token: addr(0x1234), sender: addr(0x123), recipient: addr(0x456),
        claim: AmountClaim::AtLeast(800), reference: 'INVOICE-2026-042',
    };
    let c = hashing::commitment(@f, 0xb11d);
    assert_eq!(c, 0x65da3266b91c0fd7f5b1453ebcaddc38ab380ae65197c6e81688b4263da59fa);
    assert_eq!(
        hashing::message_hash(addr(0x999), 0x777, c),
        0x9a5a4d7b18a746154196c324c14eca7fa2749ae52417c9f52b1614597333f4,
    );
}

// --- MockPool (free Sepolia rehearsal) behaves exactly like the real pool for receipts -------

use payment_receipt::mock_pool::{IMockPoolAdminDispatcher, IMockPoolAdminDispatcherTrait};
use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};

fn setup_mock() -> (ContractAddress, IPaymentReceiptDispatcher) {
    let admin = addr(0xad);
    let (pool, _) = declare("MockPool").unwrap().contract_class().deploy(@array![admin.into()]).unwrap();
    let m = IMockPoolAdminDispatcher { contract_address: pool };
    start_cheat_caller_address(pool, admin);
    m.set_public_key(addr(RECIPIENT), RECIPIENT_PK);
    m.set_channel(REF_CHANNEL_MARKER);
    m.set_subchannel(REF_SUBCHANNEL_MARKER);
    m.set_note(REF_NOTE_ID, PACKED_NOTE);
    stop_cheat_caller_address(pool);
    let (receipt, _) = declare("PaymentReceipt")
        .unwrap()
        .contract_class()
        .deploy(@array![pool.into(), VALIDITY.into()])
        .unwrap();
    (pool, IPaymentReceiptDispatcher { contract_address: receipt })
}

#[test]
fn mock_pool_gives_same_result_as_real_pool() {
    let (pool, r) = setup_mock();
    let c = prove(r, SENDER, INDEX, AmountClaim::Exact(AMOUNT));
    assert_eq!(c, hashing::commitment(@fact(pool, AmountClaim::Exact(AMOUNT)), BLINDING));
    start_cheat_block_number(r.contract_address, 1000);
    start_cheat_proof_facts(r.contract_address, facts_for(r, c, 990).span());
    r.register_receipt(c);
    assert_eq!(r.registered_at(c), 1000);
}

#[test]
#[should_panic(expected: 'RECEIPT: channel not found')]
fn mock_pool_still_rejects_wrong_sender() {
    let (_, r) = setup_mock();
    prove(r, 0x777, INDEX, AmountClaim::Exact(AMOUNT));
}

#[test]
#[should_panic(expected: 'MOCK: only admin')]
fn mock_pool_setters_are_admin_only() {
    let (pool, _) = setup_mock();
    IMockPoolAdminDispatcher { contract_address: pool }.set_note(1, 2);
}
