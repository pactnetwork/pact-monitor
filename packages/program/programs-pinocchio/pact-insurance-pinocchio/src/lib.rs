#![allow(unexpected_cfgs)]

pub mod discriminator;
pub mod entrypoint;
pub mod error;

#[cfg(feature = "bpf-entrypoint")]
pinocchio::entrypoint!(entrypoint::process_instruction);

solana_address::declare_id!("2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3");
