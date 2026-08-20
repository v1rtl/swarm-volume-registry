// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console2} from "forge-std/Script.sol";

import {VolumeRegistry} from "../src/VolumeRegistry.sol";

/// @notice Deployment script for `VolumeRegistry`.
///
///         `script/deploy.py` resolves an explicitly selected profile from
///         `deployments.toml`, validates its chain ID, and passes the three
///         constructor arguments to `run`. Wallet selection is handled by
///         Forge's `--account` option.
contract DeployVolumeRegistry is Script {
    function run(address postageStamp, address bzz, uint64 graceBlocks) external {
        vm.startBroadcast();
        VolumeRegistry reg = new VolumeRegistry(postageStamp, bzz, graceBlocks);
        vm.stopBroadcast();

        console2.log("VolumeRegistry deployed at:", address(reg));
        console2.log("  BZZ token:    ", bzz);
        console2.log("  PostageStamp: ", postageStamp);
        console2.log("  graceBlocks:  ", uint256(graceBlocks));
    }
}
