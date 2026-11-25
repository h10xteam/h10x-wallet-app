// Comprobación suelta (no forma parte de `npm test`): ¿se atascaba el guardián ANTERIOR (hasta la 0.7.0) con
// un aviso del notario cuya dirección no es la de una transacción programada? Depende de cómo responden el
// SDK y el mirror de verdad, y por eso se mira aquí, en el servidor. No firma ni envía nada: solo lee.
//   npm run aviso-ilegible
import { Mirror, NETWORKS, scheduleIdFromAddress, scheduleIdOfAddress } from "@boveda/core";

const network = (process.env.HEDERA_NETWORK ?? "testnet").toLowerCase();
const mirrorUrl = process.env.MIRROR_URL ?? NETWORKS[/** @type {"testnet"} */ (network)]?.mirror;
const mirror = new Mirror(mirrorUrl);
const cases = ["0x00000000ffffffffffffffff0000000000000001", "0x000000000000000000000000ffffffffffffffff", "0xdeadbeef00000000000000000000000000000001"];
const why = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));
let stuck = 0;
console.log(`Red: ${network} · mirror: ${mirrorUrl}\n`);
for (const address of cases) {
  console.log(address);
  let before = "";
  try {
    before = scheduleIdFromAddress(address).toString();
  } catch (e) {
    stuck++;
    console.log(`   antes: el SDK LANZA («${why(e)}») → el guardián anterior se quedaba atascado en este aviso`);
  }
  if (before) {
    try {
      const s = await mirror.schedule(before);
      console.log(`   antes: el SDK da ${before} y el mirror responde ${s ? "una programada" : "«no existe»"} → no se atascaba`);
    } catch (e) {
      stuck++;
      console.log(`   antes: el SDK da ${before} y el mirror FALLA («${why(e)}») → el guardián anterior se quedaba atascado en este aviso`);
    }
  }
  console.log(`   ahora: ${scheduleIdOfAddress(address) ?? "no es una programada: se salta y se avisa al dueño"}`);
}
console.log(
  stuck
    ? `\nRESULTADO: CONFIRMADO en ${stuck} de ${cases.length} direcciones. Quien tuviera la llave del móvil podía dejar ciego al guardián anterior con un solo aviso.`
    : "\nRESULTADO: NO confirmado con este SDK y este mirror. El guardián anterior no se atascaba con estas direcciones; el arreglo queda como protección de más.",
);
