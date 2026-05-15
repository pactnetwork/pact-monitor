// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUsdc} from "./MockUsdc.sol";

/// @notice Rate-limited faucet so judges and demo users can self-serve mUSDC.
/// One drip per address per `cooldown` seconds, fixed `dripAmount` per drip.
/// The faucet must be the `MockUsdc.owner` (or have a mint allowance) to dispense.
contract MockUsdcFaucet {
    MockUsdc public immutable token;
    uint256  public immutable dripAmount;        // in mUSDC base units (6 decimals)
    uint256  public immutable cooldown;          // seconds between drips per address

    mapping(address => uint256) public lastDripAt;

    error CooldownActive(uint256 remaining);

    event Drip(address indexed recipient, uint256 amount);

    constructor(MockUsdc _token, uint256 _dripAmount, uint256 _cooldown) {
        token       = _token;
        dripAmount  = _dripAmount;
        cooldown    = _cooldown;
    }

    function drip() external {
        uint256 last = lastDripAt[msg.sender];
        if (block.timestamp < last + cooldown) {
            revert CooldownActive(last + cooldown - block.timestamp);
        }
        lastDripAt[msg.sender] = block.timestamp;
        token.mint(msg.sender, dripAmount);
        emit Drip(msg.sender, dripAmount);
    }
}
