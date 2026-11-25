// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Parte del Hedera Schedule Service (contrato de sistema 0x16b, HIP-755) que usa el notario.
interface IHRC755v2 {
    /// Añade la clave del contrato que llama (ContractID) a las firmas de la transacción programada.
    /// Devuelve un código de respuesta de Hedera; 22 = SUCCESS.
    function authorizeSchedule(address schedule) external returns (int64 responseCode);
}

/// @title VaultNotary2: co-firmante con dos carriles para una bóveda de Hedera (prueba de concepto)
///
/// Regla de la bóveda: NINGUNA LLAVE SOLA MUEVE DINERO RÁPIDO. La cuenta bóveda es una cuenta
/// nativa de Hedera cuya clave es:
///
///     1 de 3:
///       - TODAS [ llave del móvil , ContractID(este contrato) ]   -> carril de retirada (lento)
///       - TODAS [ llave del kit   , ContractID(este contrato) ]   -> carril de recuperación (más lento)
///       - TODAS [ llave del móvil , llave del kit ]                -> las dos juntas: inmediato
///
/// Una transacción directa nunca activa un ContractID, así que con una sola llave solo se puede
/// actuar mediante una transacción programada que este contrato autoriza cuando
///   1) la ha anunciado la cuenta de esa llave por SU carril,
///   2) ha pasado el retardo de ese carril, y
///   3) nadie la ha bloqueado.
///
/// Quién puede bloquear:
///   - carril de retirada (móvil):   el móvil, el kit y el guardián;
///   - carril de recuperación (kit): el kit y el móvil. El guardián NO: así un guardián caído o
///     malicioso nunca puede impedir que recuperes la bóveda con tu kit.
///
/// freeze(carril) es el botón de pánico de la otra parte: anula de golpe todo lo pendiente de ese
/// carril y lo cierra durante un periodo. Evita tener que bloquear una a una muchas peticiones.
///
/// El contrato no custodia fondos y su autorización no sirve de nada sin la firma nativa de la
/// llave correspondiente sobre esa misma transacción programada. No tiene dueño, ni funciones de
/// administración, ni se puede actualizar. Cambiar de móvil o de kit = bóveda con notario nuevo.
contract VaultNotary2 {
    address internal constant HSS = address(0x16b);
    int64 internal constant HEDERA_SUCCESS = 22;
    int64 internal constant HEDERA_UNKNOWN = 21;
    uint64 public constant MAX_DELAY = 60 days; // una transacción programada vive como mucho 62 días

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
        uint32 epoch; // época del carril cuando se anunció; freeze() la avanza y deja esta petición anulada
        uint64 requestedAt;
        uint64 executableAt;
    }

    /// Cuenta del móvil (tal como la ve msg.sender). Solo ella abre el carril de retirada.
    address public immutable device;
    /// Cuenta de la llave del kit de rescate. Solo ella abre el carril de recuperación.
    address public immutable rescue;
    /// Guardián: puede bloquear retiradas, nada más. address(0) si no hay.
    address public immutable guardian;
    /// Segundos entre request() y approve().
    uint64 public immutable withdrawDelay;
    /// Segundos entre requestRecovery() y approve(). Nunca menor que withdrawDelay.
    uint64 public immutable recoveryDelay;

    /// Estado por transacción programada (dirección EVM del schedule).
    mapping(address => Request) public requests;
    /// Época actual de cada carril.
    mapping(Lane => uint32) public epochOf;
    /// Hasta cuándo está cerrado cada carril a peticiones nuevas.
    mapping(Lane => uint64) public lockedUntil;

    event NotaryCreated(address indexed device, address indexed rescue, address guardian, uint64 withdrawDelay, uint64 recoveryDelay);
    event Requested(address indexed schedule, Lane lane, uint64 requestedAt, uint64 executableAt);
    event Vetoed(address indexed schedule, address indexed by);
    event Approved(address indexed schedule, uint64 approvedAt);
    event Frozen(Lane indexed lane, address indexed by, uint64 until);

    error ZeroAddress();
    error SameAddress();
    error InvalidDelay(uint64 withdrawDelay, uint64 recoveryDelay);
    error InvalidLane();
    error NotDevice(address caller);
    error NotRescue(address caller);
    error NotAllowed(address caller);
    error BadStatus(Status current);
    error Superseded();
    error LaneLocked(Lane lane, uint64 until);
    error TooEarly(uint64 executableAt, uint64 nowTs);
    error AuthorizeFailed(int64 responseCode);

    constructor(address device_, address rescue_, address guardian_, uint64 withdrawDelay_, uint64 recoveryDelay_) {
        if (device_ == address(0) || rescue_ == address(0)) revert ZeroAddress();
        if (device_ == rescue_ || guardian_ == device_ || guardian_ == rescue_) revert SameAddress();
        if (withdrawDelay_ == 0 || recoveryDelay_ < withdrawDelay_ || recoveryDelay_ > MAX_DELAY) {
            revert InvalidDelay(withdrawDelay_, recoveryDelay_);
        }
        device = device_;
        rescue = rescue_;
        guardian = guardian_;
        withdrawDelay = withdrawDelay_;
        recoveryDelay = recoveryDelay_;
        emit NotaryCreated(device_, rescue_, guardian_, withdrawDelay_, recoveryDelay_);
    }

    /// El móvil anuncia una transacción programada. Empieza a contar el retardo de retirada.
    function request(address schedule) external {
        if (msg.sender != device) revert NotDevice(msg.sender);
        _open(schedule, Lane.Withdraw, withdrawDelay);
    }

    /// El kit anuncia una transacción programada. Empieza a contar el retardo de recuperación.
    function requestRecovery(address schedule) external {
        if (msg.sender != rescue) revert NotRescue(msg.sender);
        _open(schedule, Lane.Recovery, recoveryDelay);
    }

    /// Bloquea una petición concreta. Puede hacerlo quien la abrió o quien vigila ese carril.
    /// Es definitivo: para reintentar hay que crear otra transacción programada.
    function veto(address schedule) external {
        Request storage r = requests[schedule];
        if (r.status != Status.Requested) revert BadStatus(r.status);
        if (!_opens(r.lane, msg.sender) && !_watches(r.lane, msg.sender)) revert NotAllowed(msg.sender);
        r.status = Status.Vetoed;
        emit Vetoed(schedule, msg.sender);
    }

    /// Botón de pánico de quien vigila un carril: anula todo lo pendiente en él y lo cierra a
    /// peticiones nuevas durante un periodo igual a su retardo. Se puede repetir.
    function freeze(Lane lane) external {
        if (lane == Lane.None) revert InvalidLane();
        if (!_watches(lane, msg.sender)) revert NotAllowed(msg.sender);
        uint64 until = uint64(block.timestamp) + (lane == Lane.Withdraw ? withdrawDelay : recoveryDelay);
        epochOf[lane] += 1;
        lockedUntil[lane] = until;
        emit Frozen(lane, msg.sender, until);
    }

    /// Pasado el retardo y sin bloqueo, cualquiera puede pedir al notario que aporte su firma.
    /// Si la llave del carril ya firmó la transacción programada, Hedera la ejecuta en ese momento.
    function approve(address schedule) external {
        Request storage r = requests[schedule];
        if (r.status != Status.Requested) revert BadStatus(r.status);
        if (r.epoch != epochOf[r.lane]) revert Superseded();
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < r.executableAt) revert TooEarly(r.executableAt, nowTs);

        // Estado antes de la llamada externa: la transacción programada puede ejecutarse dentro
        // de authorizeSchedule y, si es una llamada a contrato, intentar reentrar aquí.
        r.status = Status.Approved;

        (bool ok, bytes memory out) = HSS.call(abi.encodeCall(IHRC755v2.authorizeSchedule, (schedule)));
        int64 rc = (ok && out.length >= 32) ? abi.decode(out, (int64)) : HEDERA_UNKNOWN;
        // Si Hedera rechaza la firma (schedule caducado, borrado, inexistente...) se revierte todo
        // y la petición sigue en Requested.
        if (rc != HEDERA_SUCCESS) revert AuthorizeFailed(rc);

        emit Approved(schedule, nowTs);
    }

    /// Estado efectivo de una petición: una anulada por freeze() cuenta como bloqueada.
    function statusOf(address schedule) external view returns (Status) {
        Request storage r = requests[schedule];
        if (r.status == Status.Requested && r.epoch != epochOf[r.lane]) return Status.Vetoed;
        return r.status;
    }

    function _open(address schedule, Lane lane, uint64 delay) private {
        if (schedule == address(0)) revert ZeroAddress();
        uint64 nowTs = uint64(block.timestamp);
        uint64 locked = lockedUntil[lane];
        if (nowTs < locked) revert LaneLocked(lane, locked);
        Request storage r = requests[schedule];
        if (r.status != Status.None) revert BadStatus(r.status);
        r.lane = lane;
        r.status = Status.Requested;
        r.epoch = epochOf[lane];
        r.requestedAt = nowTs;
        r.executableAt = nowTs + delay;
        emit Requested(schedule, lane, nowTs, r.executableAt);
    }

    /// ¿Abre `who` peticiones en este carril?
    function _opens(Lane lane, address who) private view returns (bool) {
        return lane == Lane.Withdraw ? who == device : who == rescue;
    }

    /// ¿Vigila `who` este carril (es la otra parte)?
    function _watches(Lane lane, address who) private view returns (bool) {
        if (lane == Lane.Withdraw) return who == rescue || (guardian != address(0) && who == guardian);
        return who == device;
    }
}
