// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Hello}           from "../src/Hello.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);

        Hello hello = new Hello("hello 0g");

        vm.stopBroadcast();

        console.log("Hello deployed at:", address(hello));
        console.log("Chain id:",          block.chainid);
    }
}
