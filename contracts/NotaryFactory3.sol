// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {VaultNotary3} from "./VaultNotary3.sol";

/// @title Fábrica de notarios v3 de H10X Wallet
/// @notice Crea un VaultNotary3 con los datos que le pasa quien llama. Lo único que cambia respecto a crear el notario
///         directamente es quién lo crea: el notario resultante es el mismo código con los mismos datos, y la app lo
///         comprueba byte a byte antes de atar una bóveda a él.
/// @dev Sin dueño, sin estado, sin proxy, sin delegatecall, sin selfdestruct y sin recibir HBAR: su código no puede
///      cambiar y no tiene ningún poder sobre los notarios que crea ni sobre las bóvedas que los usan. Se despliega sin
///      clave de administrador.
contract NotaryFactory3 {
    event NotaryCreated(address indexed notary, address indexed device, address indexed rescue);

    function create(
        address device_,
        address rescue_,
        address guardian_,
        address tiebreaker_,
        uint64 withdrawDelay_,
        uint64 recoveryDelay_
    ) external returns (address notary) {
        notary = address(new VaultNotary3(device_, rescue_, guardian_, tiebreaker_, withdrawDelay_, recoveryDelay_));
        emit NotaryCreated(notary, device_, rescue_);
    }
}
