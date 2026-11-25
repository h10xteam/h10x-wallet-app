// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Doble del Hedera Schedule Service para las pruebas locales.
/// Su código se inyecta en la dirección 0x16b de una EVM local, por eso no tiene constructor:
/// el código de respuesta se fija con setRc().
contract MockHSS {
    int64 public rc;
    bool public shouldRevert;
    address public lastSchedule;
    address public lastCaller;
    uint256 public calls;

    function setRc(int64 v) external {
        rc = v;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function authorizeSchedule(address schedule) external returns (int64) {
        require(!shouldRevert, "mock revert");
        lastSchedule = schedule;
        lastCaller = msg.sender;
        calls += 1;
        return rc;
    }
}
