// 0.9.4: imágenes de NFT en Arweave y pasarelas de IPFS, flujo nuevo del kit (como CKBull), nodo de staking al crear
// la bóveda, nombre de la wallet y la cantidad arriba en la lista de activos. Sin red: lo de la app se comprueba
// sobre su código.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPFS_GATEWAYS, fetchNftMetadata, gatewayUrl, isPrivateUrl, nftMetadataSource } from "@boveda/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const b64 = (s) => Buffer.from(s).toString("base64");

// El Founders Pass de H10X: metadata en IPFS e imagen en un subdominio de Arweave.
const FP_META = "ipfs://bafybeie52n6dnwhh7uw2qsibynnx45rnbp4oed4vasrcp5efxx67bgjpca/1.json";
const FP_IMAGE = "https://zjcwezaj67enoxgc2ayqxuby2zguaqgnx5cuybnfrhhsokt3yf2a.arweave.net/ykViZAn3yNdcwtAxC9A41k1AQM2_RUwFpYnPJyp7wXQ";

test("NFT: un subdominio de arweave.net es Arweave (se carga solo) y se pasa a https://arweave.net/<tx>", () => {
  assert.equal(gatewayUrl(FP_IMAGE), "https://arweave.net/ykViZAn3yNdcwtAxC9A41k1AQM2_RUwFpYnPJyp7wXQ");
  assert.equal(gatewayUrl(`${FP_IMAGE}?ext=png`), "https://arweave.net/ykViZAn3yNdcwtAxC9A41k1AQM2_RUwFpYnPJyp7wXQ?ext=png");
  assert.equal(isPrivateUrl(FP_IMAGE), true);
  assert.equal(isPrivateUrl(gatewayUrl(FP_IMAGE)), true);
  // Lo que se parece pero no es Arweave sigue siendo de terceros.
  assert.equal(isPrivateUrl("https://zjcwezaj67enoxgc2ayqxuby2zguaqgnx5cuybnfrhhsokt3yf2a.arweave.net.evil.io/ykViZAn3yNdcwtAxC9A41k1AQM2_RUwFpYnPJyp7wXQ"), false);
  assert.equal(isPrivateUrl("https://evil.io/x.arweave.net/ykViZAn3yNdcwtAxC9A41k1AQM2_RUwFpYnPJyp7wXQ"), false);
  assert.equal(isPrivateUrl("https://short.arweave.net/ykViZAn3yNdcwtAxC9A41k1AQM2_RUwFpYnPJyp7wXQ"), false, "el subdominio de Arweave tiene 52 letras");
  assert.equal(gatewayUrl("https://short.arweave.net/x"), "https://short.arweave.net/x", "otros https se quedan como están");
  // Todas las pasarelas son https y la metadata del Founders Pass es de IPFS (no externa).
  assert.ok(IPFS_GATEWAYS.length >= 4 && IPFS_GATEWAYS.every((g) => /^https:\/\/[a-z0-9.-]+\/ipfs\/$/.test(g)));
  assert.equal(nftMetadataSource(b64(FP_META))?.external, false);
});

test("NFT: el Founders Pass enseña su imagen de Arweave sin pedir permiso", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ name: "H10X Founders Pass", image: FP_IMAGE }), { status: 200 });
  const m = await fetchNftMetadata(b64(FP_META), { fetchImpl: /** @type {any} */ (fetchImpl) });
  assert.equal(m?.name, "H10X Founders Pass");
  assert.equal(m?.image, "https://arweave.net/ykViZAn3yNdcwtAxC9A41k1AQM2_RUwFpYnPJyp7wXQ");
  assert.equal(m?.imageExternal, false, "la cuadrícula la carga sola");
});

test("NFT: si la primera pasarela tarda, se pide a la siguiente y vale la primera que conteste", async () => {
  const asked = [];
  const fetchImpl = async (url, opts) => {
    asked.push(url);
    if (url.startsWith(IPFS_GATEWAYS[0])) {
      // No contesta nunca (hasta que se cancela).
      return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("abortado"))));
    }
    return new Response(JSON.stringify({ name: "ok", image: "ipfs://bafybeie52n6dnwhh7uw2qsibynnx45rnbp4oed4vasrcp5efxx67bgjpca/1.png" }), { status: 200 });
  };
  const m = await fetchNftMetadata(b64(FP_META), { fetchImpl: /** @type {any} */ (fetchImpl), staggerMs: 20 });
  assert.equal(m?.name, "ok");
  assert.ok(m?.image?.startsWith(IPFS_GATEWAYS[1]), "la imagen sale de la pasarela que contestó");
  assert.equal(asked.length, 2, "no se molesta a más pasarelas de las necesarias");

  // Una pasarela que falla (404) da paso a la siguiente sin esperar.
  const order = [];
  const failing = async (url) => (order.push(url), url.startsWith(IPFS_GATEWAYS[0]) ? new Response("no", { status: 404 }) : new Response(JSON.stringify({ name: "dos" }), { status: 200 }));
  const t0 = Date.now();
  assert.equal((await fetchNftMetadata(b64(FP_META), { fetchImpl: /** @type {any} */ (failing), staggerMs: 5000 }))?.name, "dos");
  assert.ok(Date.now() - t0 < 1000, "sin esperar los 5 s");

  // Ninguna contesta: null al acabar el tiempo.
  const dead = async (_url, opts) => new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("abortado"))));
  assert.equal(await fetchNftMetadata(b64(FP_META), { fetchImpl: /** @type {any} */ (dead), staggerMs: 5, timeoutMs: 80 }), null);
});

test("NFT en la app: un fallo no se recuerda y la ficha tiene «Reintentar»", () => {
  const src = read("app/src/screens/Nfts.tsx");
  assert.match(src, /if \(!m\) cache\.delete\(k\);/);
  assert.match(src, /setAttempt\(\(a\) => a \+ 1\)/);
  assert.match(src, /useEffect\(\(\) => setFailed\(false\), \[uri\]\);/);
});

test("kit como en CKBull: primero las palabras y su comprobación en orden; la bóveda se crea después con ese kit", () => {
  const onb = read("app/src/screens/Onboarding.tsx");
  const cv = onb.slice(onb.indexOf("export function CreateVault"), onb.indexOf("export function VaultReady"));
  // Pasos: ajustes → palabras → orden → creando.
  assert.match(cv, /type CreateStep = "settings" \| "words" \| "order" \| "creating"|useState<CreateStep>\("settings"\)/);
  assert.match(cv, /const w = await newKitWords\(\);/);
  assert.match(cv, /<KitOrder words=\{words\} picked=\{picked\} onPicked=\{setPicked\} order=\{order\} \/>/);
  // Se puede volver a ver las palabras sin perder lo hecho (el progreso vive en CreateVault).
  assert.match(cv, /title=\{t\("Ver las palabras", "See the words"\)\}[^]*onPress=\{\(\) => setScreen\("words"\)\}/);
  assert.match(cv, /disabled=\{!allPicked\} onPress=\{create\}/);
  // La bóveda se crea con el kit comprobado, el nodo y el nombre.
  assert.match(cv, /setupVault\(\{[^}]*words, stakedNodeId: node, name \}\)/);
  // La comprobación: una palabra que no toca no se pone; vale una repetida.
  const order = onb.slice(onb.indexOf("export function KitOrder"), onb.indexOf("const KIT_WARNING"));
  assert.match(order, /if \(words\[idx\] === words\[next\]\)/);
  assert.match(order, /haptic\.error\(\);\s+setMiss\(next\);/);
  // RecoveryKit (v1→v2 y kits de antes) usa la misma comprobación; ya no se escriben 3 palabras.
  assert.doesNotMatch(onb, /pickPositions/);
  assert.match(onb.slice(onb.indexOf("export function RecoveryKit")), /<KitOrder /);
  // Tras crearla, el número de la bóveda y la contraseña.
  assert.match(read("app/App.tsx"), /route\.name === "vaultReady"\) return <VaultReady/);
});

test("el kit comprobado no se guarda en el móvil y la bóveda queda con el kit confirmado", () => {
  const w = read("app/src/wallet.tsx");
  const sv = w.slice(w.indexOf("const setupVault = useCallback"), w.indexOf("const migrateToV2 = useCallback"));
  assert.match(sv, /const kitPending = checked \? false : await keepPendingKit\(/);
  assert.match(sv, /recoveryConfirmed: !!checked/);
  assert.match(sv, /checked\.length !== 24/);
  const c2 = w.slice(w.indexOf("const createV2 = useCallback"), w.indexOf("const newKitWords = useCallback"));
  assert.match(c2, /const mnemonic = words \? await Mnemonic\.fromWords\(words\) : await Mnemonic\.generate\(\);/);
});

test("capturas: permitidas solo donde se enseña el kit al crearlo, con aviso; donde se escribe el kit, bloqueadas", () => {
  const h = read("app/src/helpers.ts");
  assert.match(h, /export function useProtectSecrets\(\{ allowScreenshots = false \}/);
  assert.match(h, /if \(!allowScreenshots\) void ScreenCapture\.preventScreenCaptureAsync\("hvault-palabras"\)/);
  assert.match(h, /enableAppSwitcherProtectionAsync\(0\.9\)/, "el selector de apps lo difumina siempre");
  const onb = read("app/src/screens/Onboarding.tsx");
  assert.match(onb, /useProtectSecrets\(\{ allowScreenshots: screen === "words" \|\| screen === "order" \}\)/);
  assert.match(onb, /export function RecoveryKit[^]*?useProtectSecrets\(\{ allowScreenshots: true \}\)/);
  assert.doesNotMatch(onb, /Nunca hagas captura/);
  // Donde se escriben las 24 palabras (rescate, evacuar, recuperar…), sigue sin poderse capturar.
  const actions = read("app/src/screens/Actions.tsx");
  assert.doesNotMatch(actions, /allowScreenshots/);
  assert.ok((actions.match(/useProtectSecrets\(\);/g) ?? []).length >= 5);
});

test("staking al crear: se elige el nodo (o ninguno) y la Cartera hace staking en el mismo al momento", () => {
  const onb = read("app/src/screens/Onboarding.tsx");
  assert.match(onb, /function NodePicker/);
  assert.match(onb, /\{ value: "none", label: t\("Sin staking", "No staking"\) \}/);
  assert.match(onb, /const \[node, setNode\] = useState<NodeChoice>\("auto"\);/);
  const w = read("app/src/wallet.tsx");
  const c2 = w.slice(w.indexOf("const createV2 = useCallback"), w.indexOf("const newKitWords = useCallback"));
  assert.match(c2, /node === "auto"\s+\? await mirror\s+\.nodes\(\)\s+\.then\(pickStakingNode\)/);
  assert.match(c2, /if \(stakePocketToo && stakedNodeId != null\) \{\s+await new AccountUpdateTransaction\(\)\s+\.setAccountId\(accountId\)\s+\.setStakedNodeId\(stakedNodeId\)/);
  // Solo al crear (no al pasar de la v1 a la v2).
  assert.match(w, /checked \?\? null, stakedNodeId, true\);/);
  assert.match(w, /await createV2\(p, guardian, withdrawDelay, recoveryDelay, 0n, onStep, password\);/);
});

test("nombre de la wallet: se pone al crearla, se ve en Inicio y se cambia en Ajustes", () => {
  assert.match(read("app/src/storage.ts"), /name\?: string;/);
  const w = read("app/src/wallet.tsx");
  assert.match(w, /const clean = name\.replace\(\/\\s\+\/g, " "\)\.trim\(\)\.slice\(0, 32\);/);
  assert.match(read("app/src/screens/Onboarding.tsx"), /label=\{t\("Nombre de la wallet", "Wallet name"\)\}/);
  assert.match(read("app/src/screens/Home.tsx"), /label=\{profile\.name \? `\$\{profile\.name\} · /);
  assert.match(read("app/src/screens/Actions.tsx"), /await renameWallet\(naming\);/);
});

test("lista de activos: la cantidad arriba y los dólares debajo (como en HashPack)", () => {
  const a = read("app/src/components/Assets.tsx");
  const row = a.slice(a.indexOf("export function AssetRow"), a.indexOf("if (!onPress) return body;"));
  const qty = row.indexOf("{qty}");
  const value = row.indexOf("{h.value != null ? format(h.value) : \"—\"}");
  assert.ok(qty > 0 && value > qty, "primero la cantidad, después el valor");
  assert.match(row, /styles\.assetValue[^>]*>\s*\{qty\}/);
});

test("versión 0.9.4 o posterior", () => {
  const v = /"version": "(\d+)\.(\d+)\.(\d+)"/.exec(read("app/app.json"));
  assert.ok(v, "app.json sin versión");
  const [maj, min, pat] = v.slice(1).map(Number);
  assert.ok(maj > 0 || min > 9 || (min === 9 && pat >= 4), `versión ${v[0]}`);
});
