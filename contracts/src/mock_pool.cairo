//! TEST-ONLY stand-in for the STRK20 pool's four read views, for a free Sepolia rehearsal of the
//! SNIP-36 proving path. PaymentReceipt reads the pool only through these views
//! (`get_public_key`, `channel_exists`, `subchannel_exists`, `get_note`), so a receipt proven
//! against MockPool exercises the real virtual OS, the real stwo prover and the real proof_facts
//! check. It does NOT exercise how notes get into the real pool. Never use it for real receipts.

#[starknet::interface]
pub trait IMockPoolAdmin<T> {
    fn set_public_key(ref self: T, user: starknet::ContractAddress, public_key: felt252);
    fn set_channel(ref self: T, channel_marker: felt252);
    fn set_subchannel(ref self: T, subchannel_marker: felt252);
    fn set_note(ref self: T, note_id: felt252, packed_value: felt252);
}

#[starknet::contract]
pub mod MockPool {
    use privacy::objects::Note;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::IMockPoolAdmin;

    #[storage]
    struct Storage {
        admin: ContractAddress,
        public_key: Map<ContractAddress, felt252>,
        channel_exists: Map<felt252, bool>,
        subchannel_exists: Map<felt252, bool>,
        notes: Map<felt252, felt252>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, admin: ContractAddress) {
        self.admin.write(admin);
    }

    // Same selectors and return types as privacy::interface::IViews.
    #[external(v0)]
    fn get_public_key(self: @ContractState, user_addr: ContractAddress) -> felt252 {
        self.public_key.read(user_addr)
    }

    #[external(v0)]
    fn channel_exists(self: @ContractState, channel_marker: felt252) -> bool {
        self.channel_exists.read(channel_marker)
    }

    #[external(v0)]
    fn subchannel_exists(self: @ContractState, subchannel_marker: felt252) -> bool {
        self.subchannel_exists.read(subchannel_marker)
    }

    #[external(v0)]
    fn get_note(self: @ContractState, note_id: felt252) -> Note {
        Note { packed_value: self.notes.read(note_id), token: 0.try_into().unwrap() }
    }

    #[abi(embed_v0)]
    impl AdminImpl of IMockPoolAdmin<ContractState> {
        fn set_public_key(ref self: ContractState, user: ContractAddress, public_key: felt252) {
            self.only_admin();
            self.public_key.write(user, public_key);
        }
        fn set_channel(ref self: ContractState, channel_marker: felt252) {
            self.only_admin();
            self.channel_exists.write(channel_marker, true);
        }
        fn set_subchannel(ref self: ContractState, subchannel_marker: felt252) {
            self.only_admin();
            self.subchannel_exists.write(subchannel_marker, true);
        }
        fn set_note(ref self: ContractState, note_id: felt252, packed_value: felt252) {
            self.only_admin();
            self.notes.write(note_id, packed_value);
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        fn only_admin(self: @ContractState) {
            assert(get_caller_address() == self.admin.read(), 'MOCK: only admin');
        }
    }
}
