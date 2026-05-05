use solana_address::Address;

pub const USDC_MAINNET: Address = Address::new_from_array([
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49,
    177, 187, 228, 194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
]);
pub const USDC_DEVNET: Address = Address::new_from_array([
    59, 68, 44, 179, 145, 33, 87, 241, 58, 147, 61, 1, 52, 40, 45, 3,
    43, 95, 254, 205, 1, 162, 219, 241, 183, 121, 6, 8, 223, 0, 46, 167,
]);

pub const MAX_BATCH_SIZE: usize = 50;
pub const WITHDRAWAL_COOLDOWN_SECS: i64 = 86_400;
pub const MAX_DEPOSIT_LAMPORTS: u64 = 25_000_000;
pub const MIN_PREMIUM_LAMPORTS: u64 = 100;
