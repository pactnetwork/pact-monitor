// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/token/ERC20/ERC20.sol";

/// @notice Demo stablecoin for Pact-0G. 6 decimals matching real USDC.
/// Mint is owner-gated; for end-user funding use MockUsdcFaucet instead.
contract MockUsdc is ERC20 {
    address public immutable owner;

    error NotOwner();

    constructor() ERC20("Mock USDC", "mUSDC") {
        owner = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _mint(to, amount);
    }
}
