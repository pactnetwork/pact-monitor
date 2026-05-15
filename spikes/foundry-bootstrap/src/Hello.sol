// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract Hello {
    string public message;
    address public immutable deployer;
    uint256 public immutable deployedAt;

    constructor(string memory _message) {
        message    = _message;
        deployer   = msg.sender;
        deployedAt = block.timestamp;
    }

    function setMessage(string calldata _message) external {
        require(msg.sender == deployer, "not deployer");
        message = _message;
    }
}
