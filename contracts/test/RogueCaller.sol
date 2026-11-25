// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Contrato TRAMPA para las pruebas de ataque. Intenta que el Schedule Service de Hedera crea que
/// el notario ha autorizado una transacción programada sin que haya pasado el retardo:
///   1) authorizeDirect:  llama él mismo a authorizeSchedule;
///   2) forgeAndApprove: se escribe a sí mismo una petición "ya vencida" y ejecuta el código del
///      notario con delegatecall, de modo que approve() pasa sus comprobaciones.
/// En los dos casos quien "firma" es este contrato, no el notario, así que la bóveda no se mueve.
contract RogueCaller {
    enum Lane {
        None,
        Withdraw,
        Recovery
    }

    enum Status {
        None,
        Requested,
        Vetoed,
        Approved
    }

    struct Request {
        Lane lane;
        Status status;
        uint32 epoch;
        uint64 requestedAt;
        uint64 executableAt;
    }

    /// Misma posición de almacenamiento (0) que `requests` en VaultNotary2.
    mapping(address => Request) public requests;

    event Tried(string what, bool ok, bytes data);

    function authorizeDirect(address schedule) external returns (bool ok, bytes memory out) {
        (ok, out) = address(0x16b).call(abi.encodeWithSignature("authorizeSchedule(address)", schedule));
        emit Tried("authorizeDirect", ok, out);
    }

    function forgeAndApprove(address notary, address schedule) external returns (bool ok, bytes memory out) {
        requests[schedule] = Request(Lane.Recovery, Status.Requested, 0, 0, 0);
        (ok, out) = notary.delegatecall(abi.encodeWithSignature("approve(address)", schedule));
        emit Tried("forgeAndApprove", ok, out);
    }
}
