//! STRK20 payment receipts proven with SNIP-36.
//!
//! Flow
//! 1. PROVE (virtual block, off-chain): the holder runs `prove_payment` with the channel key as a
//!    private input. It reads the STRK20 pool at the base block, checks that a note of
//!    `sender -> recipient` for `token` exists, decrypts its amount, checks the claim, and emits
//!    ONE L2->L1 message whose payload is `[class_hash, commitment]`.
//!    Nothing about the channel key, note index or salt leaves the virtual block.
//! 2. REGISTER (real tx, carries the SNIP-36 proof): `register_receipt(commitment)` checks the
//!    proof facts (program variant, output version, recency, and that the only proven message is
//!    exactly this contract's message for `commitment`) and records the commitment.
//! 3. VERIFY (anyone, off-chain): the holder gives the verifier the opening of the commitment
//!    (the fact + a blinding value). The verifier recomputes the commitment and checks it is
//!    registered. The verifier never receives a key.

use starknet::ContractAddress;

/// What the receipt asserts about the note's amount.
#[derive(Drop, Copy, Serde, PartialEq, Debug)]
pub enum AmountClaim {
    /// Reveals the exact amount.
    Exact: u128,
    /// Reveals only a lower bound: amount >= value.
    AtLeast: u128,
}

/// The public statement a receipt proves. Only its commitment goes on chain.
#[derive(Drop, Copy, Serde, PartialEq, Debug)]
pub struct PaymentFact {
    pub pool: ContractAddress,
    pub token: ContractAddress,
    pub sender: ContractAddress,
    pub recipient: ContractAddress,
    pub claim: AmountClaim,
    /// Free-form reference chosen by the holder (invoice id, payroll period, verifier nonce).
    pub reference: felt252,
}

/// Same layout as the STRK20 pool's `ProofFacts` (privacy::utils::ProofFacts).
#[derive(Drop, Serde, Debug, Copy)]
pub struct ProofFacts {
    pub proof_version: felt252,
    pub program_variant: felt252,
    pub virtual_program_hash: felt252,
    pub starknet_os_output_version: felt252,
    pub base_block_number: u64,
    pub base_block_hash: felt252,
    pub starknet_os_config_hash: felt252,
    pub message_to_l1_hashes: Span<felt252>,
}

#[starknet::interface]
pub trait IPaymentReceipt<T> {
    /// Virtual-block entry point. The channel key is a private input.
    fn prove_payment(
        self: @T,
        channel_key: felt252,
        token: ContractAddress,
        sender: ContractAddress,
        recipient: ContractAddress,
        note_index: usize,
        claim: AmountClaim,
        reference: felt252,
        blinding: felt252,
    ) -> felt252;
    /// Real transaction carrying the SNIP-36 proof.
    fn register_receipt(ref self: T, commitment: felt252);
    /// Block at which a commitment was registered, 0 if never.
    fn registered_at(self: @T, commitment: felt252) -> u64;
    fn pool(self: @T) -> ContractAddress;
}

pub mod errors {
    pub const UNREGISTERED_RECIPIENT: felt252 = 'RECEIPT: recipient no pk';
    pub const NO_CHANNEL: felt252 = 'RECEIPT: channel not found';
    pub const NO_SUBCHANNEL: felt252 = 'RECEIPT: subchannel not found';
    pub const NO_NOTE: felt252 = 'RECEIPT: note not found';
    pub const NOT_ENCRYPTED: felt252 = 'RECEIPT: not an encrypted note';
    pub const CLAIM_FALSE: felt252 = 'RECEIPT: claim does not hold';
    pub const EMPTY_PROOF_FACTS: felt252 = 'RECEIPT: empty proof facts';
    pub const BAD_PROOF_FACTS: felt252 = 'RECEIPT: bad proof facts';
    pub const BAD_VARIANT: felt252 = 'RECEIPT: bad program variant';
    pub const BAD_OUTPUT_VERSION: felt252 = 'RECEIPT: bad output version';
    pub const BASE_BLOCK_NOT_PAST: felt252 = 'RECEIPT: base block not past';
    pub const PROOF_EXPIRED: felt252 = 'RECEIPT: proof expired';
    pub const BAD_MESSAGE: felt252 = 'RECEIPT: proof msg mismatch';
}

pub mod hashing {
    use core::num::traits::WrappingSub;
    use core::poseidon::poseidon_hash_span;
    use starknet::ContractAddress;
    use super::{AmountClaim, PaymentFact};

    // Same tags and preimages as privacy::hashes (STRK20 pool).
    pub const CHANNEL_MARKER_TAG: felt252 = 'CHANNEL_MARKER_TAG:V1';
    pub const SUBCHANNEL_MARKER_TAG: felt252 = 'SUBCHANNEL_MARKER_TAG:V1';
    pub const NOTE_ID_TAG: felt252 = 'NOTE_ID_TAG:V1';
    pub const ENC_AMOUNT_TAG: felt252 = 'ENC_AMOUNT_TAG:V1';
    pub const RECEIPT_TAG: felt252 = 'STRK20_RECEIPT:V0';

    pub fn channel_marker(
        ck: felt252, sender: ContractAddress, recipient: ContractAddress, pk: felt252,
    ) -> felt252 {
        poseidon_hash_span([CHANNEL_MARKER_TAG, ck, sender.into(), recipient.into(), pk].span())
    }

    pub fn subchannel_marker(
        ck: felt252, recipient: ContractAddress, pk: felt252, token: ContractAddress,
    ) -> felt252 {
        poseidon_hash_span([SUBCHANNEL_MARKER_TAG, ck, recipient.into(), pk, token.into()].span())
    }

    pub fn note_id(ck: felt252, token: ContractAddress, index: usize) -> felt252 {
        poseidon_hash_span([NOTE_ID_TAG, ck, token.into(), index.into(), 0].span())
    }

    /// Decrypts a packed note `(salt << 128) | enc_amount`. Returns (salt, amount).
    pub fn decrypt(packed: felt252, ck: felt252, token: ContractAddress, index: usize) -> (u128, u128) {
        let packed_u256: u256 = packed.into();
        let salt = packed_u256.high;
        let enc_amount = packed_u256.low;
        let pad: u256 = poseidon_hash_span(
            [ENC_AMOUNT_TAG, ck, token.into(), index.into(), 0, salt.into()].span(),
        )
            .into();
        (salt, enc_amount.wrapping_sub(pad.low))
    }

    pub fn commitment(fact: @PaymentFact, blinding: felt252) -> felt252 {
        let (kind, value) = match *fact.claim {
            AmountClaim::Exact(v) => (0, v),
            AmountClaim::AtLeast(v) => (1, v),
        };
        poseidon_hash_span(
            [
                RECEIPT_TAG, (*fact.pool).into(), (*fact.token).into(), (*fact.sender).into(),
                (*fact.recipient).into(), kind, value.into(), *fact.reference, blinding,
            ]
                .span(),
        )
    }

    /// Hash of the L2->L1 message as committed in SNIP-36 proof facts:
    /// poseidon(from_address, to_address = 0, payload_len, payload...).
    pub fn message_hash(from: ContractAddress, class_hash: felt252, commitment: felt252) -> felt252 {
        poseidon_hash_span([from.into(), 0, 2, class_hash, commitment].span())
    }
}

#[starknet::contract]
pub mod PaymentReceipt {
    use core::num::traits::Zero;
    use privacy::interface::{IViewsDispatcher, IViewsDispatcherTrait};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::{
        get_class_hash_at_syscall, get_execution_info_v3_syscall, send_message_to_l1_syscall,
    };
    use starknet::{ContractAddress, SyscallResultTrait};
    use super::{AmountClaim, IPaymentReceipt, PaymentFact, ProofFacts, errors, hashing};

    pub const VIRTUAL_SNOS: felt252 = 'VIRTUAL_SNOS';
    pub const VIRTUAL_SNOS0: felt252 = 'VIRTUAL_SNOS0';
    /// Encrypted notes use salt > OPEN_NOTE_SALT (= 1).
    const OPEN_NOTE_SALT: u128 = 1;

    #[storage]
    struct Storage {
        pool: ContractAddress,
        proof_validity_blocks: u64,
        registered: Map<felt252, u64>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        ReceiptRegistered: ReceiptRegistered,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ReceiptRegistered {
        #[key]
        pub commitment: felt252,
        pub base_block_number: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool: ContractAddress, proof_validity_blocks: u64) {
        self.pool.write(pool);
        self.proof_validity_blocks.write(proof_validity_blocks);
    }

    #[abi(embed_v0)]
    impl PaymentReceiptImpl of IPaymentReceipt<ContractState> {
        fn prove_payment(
            self: @ContractState,
            channel_key: felt252,
            token: ContractAddress,
            sender: ContractAddress,
            recipient: ContractAddress,
            note_index: usize,
            claim: AmountClaim,
            reference: felt252,
            blinding: felt252,
        ) -> felt252 {
            let pool_address = self.pool.read();
            let pool = IViewsDispatcher { contract_address: pool_address };

            // 1. Bind the channel key to (sender, recipient) and the token, using pool state.
            let pk = pool.get_public_key(recipient);
            assert(pk.is_non_zero(), errors::UNREGISTERED_RECIPIENT);
            assert(
                pool.channel_exists(hashing::channel_marker(channel_key, sender, recipient, pk)),
                errors::NO_CHANNEL,
            );
            assert(
                pool
                    .subchannel_exists(
                        hashing::subchannel_marker(channel_key, recipient, pk, token),
                    ),
                errors::NO_SUBCHANNEL,
            );

            // 2. Read and decrypt the note.
            let note = pool.get_note(hashing::note_id(channel_key, token, note_index));
            assert(note.packed_value.is_non_zero(), errors::NO_NOTE);
            assert(note.token.is_zero(), errors::NOT_ENCRYPTED);
            let (salt, amount) = hashing::decrypt(note.packed_value, channel_key, token, note_index);
            assert(salt > OPEN_NOTE_SALT, errors::NOT_ENCRYPTED);

            // 3. Check the claim.
            let holds = match claim {
                AmountClaim::Exact(v) => amount == v,
                AmountClaim::AtLeast(v) => amount >= v,
            };
            assert(holds, errors::CLAIM_FALSE);

            // 4. Emit only the commitment.
            let fact = PaymentFact { pool: pool_address, token, sender, recipient, claim, reference };
            let commitment = hashing::commitment(@fact, blinding);
            let this = starknet::get_contract_address();
            let class_hash = get_class_hash_at_syscall(this).unwrap_syscall();
            send_message_to_l1_syscall(
                to_address: Zero::zero(), payload: [class_hash.into(), commitment].span(),
            )
                .unwrap_syscall();
            commitment
        }

        fn register_receipt(ref self: ContractState, commitment: felt252) {
            let info = get_execution_info_v3_syscall().unwrap_syscall();
            let mut span = info.tx_info.proof_facts;
            assert(!span.is_empty(), errors::EMPTY_PROOF_FACTS);
            let facts: ProofFacts = Serde::deserialize(ref span).expect(errors::BAD_PROOF_FACTS);
            assert(span.is_empty(), errors::BAD_PROOF_FACTS);

            assert(facts.program_variant == VIRTUAL_SNOS, errors::BAD_VARIANT);
            assert(facts.starknet_os_output_version == VIRTUAL_SNOS0, errors::BAD_OUTPUT_VERSION);
            let current = info.block_info.block_number;
            assert(facts.base_block_number < current, errors::BASE_BLOCK_NOT_PAST);
            assert(
                current <= facts.base_block_number + self.proof_validity_blocks.read(),
                errors::PROOF_EXPIRED,
            );

            let this = info.contract_address;
            let class_hash = get_class_hash_at_syscall(this).unwrap_syscall();
            let expected = hashing::message_hash(this, class_hash.into(), commitment);
            assert(facts.message_to_l1_hashes == [expected].span(), errors::BAD_MESSAGE);

            if self.registered.read(commitment).is_zero() {
                self.registered.write(commitment, current);
                self
                    .emit(
                        ReceiptRegistered {
                            commitment, base_block_number: facts.base_block_number,
                        },
                    );
            }
        }

        fn registered_at(self: @ContractState, commitment: felt252) -> u64 {
            self.registered.read(commitment)
        }

        fn pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }
    }
}
