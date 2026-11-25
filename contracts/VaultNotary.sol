// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Parte del Hedera Schedule Service (contrato de sistema 0x16b, HIP-755) que usa el notario.
interface IHRC755 {
    /// Añade la clave del contrato que llama (ContractID) a las firmas de la transacción programada.
    /// Devuelve un código de respuesta de Hedera; 22 = SUCCESS.
    function authorizeSchedule(address schedule) external returns (int64 responseCode);
}

/// @title VaultNotary: co-firmante con retardo y veto para una bóveda de Hedera (prueba de concepto)
///
/// La cuenta bóveda es una cuenta NATIVA de Hedera cuya clave es:
///
///     1 de 2:
///       - ruta normal : TODAS [ umbral de dispositivos , ContractID(este contrato) ]
///       - ruta rescate: umbral de llaves frías
///
/// Una transacción directa nunca puede satisfacer un ContractID, así que la ruta normal obliga
/// a pasar por una transacción programada: los dispositivos la firman de forma nativa y este
/// contrato aporta su "firma" con authorizeSchedule, pero solo cuando
///   1) el quórum de dispositivos lo ha pedido (request),
///   2) ha pasado el retardo, y
///   3) ningún vigilante la ha vetado.
///
/// El contrato no custodia fondos y no puede moverlos por sí solo: su autorización no sirve de
/// nada sin las firmas nativas de los dispositivos sobre esa misma transacción programada.
/// No tiene dueño, ni funciones de administración, ni se puede actualizar.
contract VaultNotary {
    address internal constant HSS = address(0x16b);
    int64 internal constant HEDERA_SUCCESS = 22;
    int64 internal constant HEDERA_UNKNOWN = 21;
    uint64 public constant MAX_DELAY = 60 days; // una transacción programada vive como mucho 62 días

    enum Status {
        None,
        Requested,
        Vetoed,
        Approved
    }

    struct Request {
        Status status;
        uint64 requestedAt;
        uint64 executableAt;
    }

    /// Cuenta cuya clave es el umbral de dispositivos. Solo ella puede abrir una petición, de modo
    /// que el reloj del retardo no arranca sin el quórum. Sin esto, cualquiera podría dejar
    /// "pre-autorizada" una transacción programada y ejecutarla al instante el día que robase las llaves.
    address public immutable quorum;

    /// Segundos que deben pasar entre request() y approve().
    uint64 public immutable delay;

    /// Cuentas que pueden vetar con una sola firma (cada dispositivo, un vigilante, etc.).
    mapping(address => bool) public isVetoer;

    /// Estado por transacción programada (dirección EVM del schedule).
    mapping(address => Request) public requests;

    event NotaryCreated(address indexed quorum, uint64 delay, address[] vetoers);
    event Requested(address indexed schedule, uint64 requestedAt, uint64 executableAt);
    event Vetoed(address indexed schedule, address indexed by);
    event Approved(address indexed schedule, uint64 approvedAt);

    error ZeroAddress();
    error InvalidDelay(uint64 delay);
    error NoVetoers();
    error NotQuorum(address caller);
    error NotVetoer(address caller);
    error BadStatus(Status current);
    error TooEarly(uint64 executableAt, uint64 nowTs);
    error AuthorizeFailed(int64 responseCode);

    constructor(address quorum_, address[] memory vetoers_, uint64 delay_) {
        if (quorum_ == address(0)) revert ZeroAddress();
        if (delay_ == 0 || delay_ > MAX_DELAY) revert InvalidDelay(delay_);
        if (vetoers_.length == 0) revert NoVetoers();
        quorum = quorum_;
        delay = delay_;
        for (uint256 i = 0; i < vetoers_.length; i++) {
            if (vetoers_[i] == address(0)) revert ZeroAddress();
            isVetoer[vetoers_[i]] = true;
        }
        emit NotaryCreated(quorum_, delay_, vetoers_);
    }

    /// El quórum anuncia una transacción programada. Empieza a contar el retardo.
    function request(address schedule) external {
        if (msg.sender != quorum) revert NotQuorum(msg.sender);
        if (schedule == address(0)) revert ZeroAddress();
        Request storage r = requests[schedule];
        if (r.status != Status.None) revert BadStatus(r.status);
        uint64 nowTs = uint64(block.timestamp);
        r.status = Status.Requested;
        r.requestedAt = nowTs;
        r.executableAt = nowTs + delay;
        emit Requested(schedule, nowTs, r.executableAt);
    }

    /// Cualquier vetador bloquea una transacción programada, anunciada o todavía no.
    /// El veto es definitivo: para reintentar hay que crear otra transacción programada.
    function veto(address schedule) external {
        if (!isVetoer[msg.sender]) revert NotVetoer(msg.sender);
        Request storage r = requests[schedule];
        if (r.status != Status.None && r.status != Status.Requested) revert BadStatus(r.status);
        r.status = Status.Vetoed;
        emit Vetoed(schedule, msg.sender);
    }

    /// Pasado el retardo y sin veto, cualquiera puede pedir al notario que aporte su firma.
    /// Si los dispositivos ya firmaron la transacción programada, Hedera la ejecuta en ese momento.
    function approve(address schedule) external {
        Request storage r = requests[schedule];
        if (r.status != Status.Requested) revert BadStatus(r.status);
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < r.executableAt) revert TooEarly(r.executableAt, nowTs);

        // Estado antes de la llamada externa: la transacción programada puede ejecutarse dentro
        // de authorizeSchedule y, si es una llamada a contrato, intentar reentrar aquí.
        r.status = Status.Approved;

        (bool ok, bytes memory out) = HSS.call(abi.encodeCall(IHRC755.authorizeSchedule, (schedule)));
        int64 rc = (ok && out.length >= 32) ? abi.decode(out, (int64)) : HEDERA_UNKNOWN;
        // Si Hedera rechaza la firma (schedule caducado, borrado, inexistente...) se revierte todo
        // y la petición sigue en Requested.
        if (rc != HEDERA_SUCCESS) revert AuthorizeFailed(rc);

        emit Approved(schedule, nowTs);
    }
}
