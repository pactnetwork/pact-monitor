// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20}   from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Demo stablecoin for Pact-0G. 6 decimals matching real USDC.
/// Mint is owner-gated. Deployer transfers ownership to `MockUsdcFaucet`
/// after deploy so the faucet can drip mUSDC to anyone with cooldown.
contract MockUsdc is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Mock USDC", "mUSDC") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
