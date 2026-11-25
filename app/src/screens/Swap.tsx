// Pestaña Cambiar (0.10.2): HBAR ↔ token y token ↔ token en SaucerSwap desde la Cartera, con lo que sale en la Cartera
// o directo en la bóveda. Dos tarjetas («Pagas» / «Recibes») con su token, el botón para darles la vuelta, teclado
// propio (25 %, 50 %, Máx), selector de token a pantalla completa (lista revisada, tus tokens y «pegar ID» con avisos),
// detalles plegados y la tolerancia en el engranaje. Abajo, el hueco para comprar con tarjeta.
// La lógica está en el núcleo: core/src/swap.js (HBAR ↔ token), core/src/swaproute.js (token ↔ token) y
// core/src/swaptokens.js (lista revisada y comprobaciones). Aquí, solo la pantalla.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  HBAR,
  IMPACT_CONFIRM_PCT,
  IMPACT_WARN_PCT,
  Mirror,
  NETWORKS,
  SLIPPAGE_CHOICES_BPS,
  SWAP_DEFAULT_TOKEN,
  SWAP_FEE_RESERVE_TINYBARS,
  bestRouteQuote,
  bestSwapQuote,
  checkPastedToken,
  checkSwapToken,
  describeRoute,
  findRoutes,
  findSwapPools,
  formatHbar,
  formatUnits,
  onrampHost,
  onrampUrl,
  parseUnits,
  routeSetup,
  swapFromPocket,
  swapMinOut,
  swapSetup,
  swapTokenList,
  swapTokensFromPocket,
  type SwapPool,
  type SwapRoute,
  type SwapTokenEntry,
  type TokenInfo,
} from "@boveda/core";
import { Backdrop, Badge, Button, Card, Group, H2, Icon, P, Row, Screen, SectionTitle, Segmented } from "../ui";
import { colors, radius, space, typeface } from "../theme";
import { HBAR_ASSET, useWallet } from "../wallet";
import { usePrices } from "../prices";
import { TokenLogo } from "../components/Assets";
import { NETWORK, onrampTemplate, stocksEnabled, swapTokenOverride } from "../env";
import { StocksPanel } from "./Stocks";
import { lang, t } from "../i18n";
import { confirm, haptic, open, run, txLink } from "../helpers";

const NET = (NETWORKS as Record<string, { mirror: string } | undefined>)[NETWORK];
const mirror = NET ? new Mirror(NET.mirror, fetch) : null;
/** HBAR que hay que tener en la Cartera para las comisiones de red de un cambio. */
const MIN_FEE_TINYBARS = HBAR;
/** Token por defecto en «Recibes»: el fijado al compilar o el de la red (mainnet: H10X). */
const DEFAULT_TOKEN = swapTokenOverride ?? (NETWORK === "mainnet" || NETWORK === "testnet" ? SWAP_DEFAULT_TOKEN[NETWORK] : "");

type Mode = "buy" | "sell" | "route";
type Check = { ok: boolean; problems: string[]; warnings: string[]; reviewed: boolean };
type Quoted = {
  key: string;
  amountIn: bigint;
  amountOut: bigint | null;
  impactPct: number | null;
  /** «SaucerSwap V2 · 0,3 %» o «SAUCE → HBAR → USDC · V2». */
  route: string;
  /** La segunda mejor, para comparar. */
  other: string | null;
  count: number;
};

export function SwapHome({ footer, onDeposit }: { footer: React.ReactNode; onDeposit: () => void }) {
  const { profile, balances, tokens, withPocket, refresh, pullRefresh, refreshing } = useWallet();
  const { fiat } = usePrices();
  const list = useMemo<SwapTokenEntry[]>(() => swapTokenList(NETWORK, swapTokenOverride), []);
  const [payId, setPayId] = useState<string>(HBAR_ASSET);
  const [getId, setGetId] = useState<string>(DEFAULT_TOKEN || HBAR_ASSET);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState<number>(100);
  const [toVault, setToVault] = useState(false);
  const [picker, setPicker] = useState<"pay" | "get" | null>(null);
  const [settings, setSettings] = useState(false);
  const [details, setDetails] = useState(false);
  const [infos, setInfos] = useState<Record<string, TokenInfo | null>>({});
  const [pools, setPools] = useState<SwapPool[] | null>(null);
  const [routes, setRoutes] = useState<SwapRoute[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ txId: string; text: string; toVault: boolean } | null>(null);
  /** 0.10.2 · Tokens (SaucerSwap) o acciones tokenizadas (SODAX). */
  const [market, setMarket] = useState<"tokens" | "stocks">("tokens");
  const seq = useRef(0);

  const pairKey = `${payId}>${getId}`;
  // El par elegido ahora: lo que llegue tarde de otro par (pools, rutas, datos) no se usa.
  const current = useRef(pairKey);
  current.current = pairKey;

  const mode: Mode | null = payId === getId ? null : payId === HBAR_ASSET ? "buy" : getId === HBAR_ASSET ? "sell" : "route";
  const tokenSide = mode === "buy" ? getId : mode === "sell" ? payId : null;
  const setup = useMemo(() => (mirror && tokenSide ? swapSetup(NETWORK, tokenSide) : null), [tokenSide]);
  const rs = useMemo(() => (mirror && mode === "route" ? routeSetup(NETWORK, payId, getId) : null), [mode, payId, getId]);
  const vaultId = profile?.vault?.accountId ?? null;
  const dest = toVault && vaultId ? vaultId : null;

  // ---- datos de los tokens, pools y rutas ------------------------------------------------------------
  const load = useCallback(async () => {
    if (!mirror || !mode) return;
    const key = pairKey;
    setLoadError(false);
    setPools(null);
    setRoutes(null);
    const ids = [payId, getId].filter((x) => x !== HBAR_ASSET);
    try {
      // Siempre fresco: lo que se comprueba (pausado, comisiones, nombre…) puede haber cambiado.
      const got = await Promise.all(ids.map((id) => mirror.tokenInfo(id, { fresh: true }).catch(() => null)));
      const p = setup ? await findSwapPools(mirror, setup) : null;
      const r = rs ? await findRoutes(mirror, rs) : null;
      if (current.current !== key) return;
      setInfos((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id, i) => [id, got[i]])) }));
      setPools(p);
      setRoutes(r);
    } catch {
      if (current.current === key) setLoadError(true);
    }
  }, [pairKey, setup, rs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [load]);

  const sym = (id: string) => (id === HBAR_ASSET ? "HBAR" : infos[id]?.symbol || list.find((x) => x.id === id)?.symbol || id || "…");
  const decOf = (id: string) => (id === HBAR_ASSET ? 8 : infos[id]?.decimals ?? null);
  const balOf = (id: string) => (id === HBAR_ASSET ? balances.pocket ?? 0n : tokens.pocket.find((x) => x.tokenId === id)?.balance ?? 0n);
  const inDec = decOf(payId) ?? 8;
  const outDec = decOf(getId) ?? 8;
  const amountIn = decOf(payId) != null ? parseUnits(amount.replace(/[.,]$/, ""), inDec) : null;
  const hbar = balances.pocket ?? 0n;
  const payBal = balOf(payId);
  const enough =
    amountIn != null && (payId === HBAR_ASSET ? amountIn + MIN_FEE_TINYBARS <= hbar : amountIn <= payBal && hbar >= MIN_FEE_TINYBARS);

  // Comprobación de cada token del par: los de la lista, con su ficha revisada; los demás, como «pegados».
  const checks: Check[] = [payId, getId]
    .filter((id) => id !== HBAR_ASSET && infos[id] !== undefined)
    .map((id) => {
      const info = infos[id] ?? null;
      const entry = list.find((x) => x.id === id);
      return entry ? { ...checkSwapToken(entry, info), reviewed: !!entry.symbol } : checkPastedToken(NETWORK, info);
    });
  const checked = [payId, getId].every((id) => id === HBAR_ASSET || infos[id] !== undefined);
  const problems = checks.flatMap((c) => c.problems);
  const warnings = checks.flatMap((c) => c.warnings);
  const tokensOk = checked && problems.length === 0;
  const loaded = mode === "route" ? routes !== null : pools !== null;
  const noLiquidity = loaded && (mode === "route" ? routes?.length === 0 : pools?.length === 0);

  // ---- cotización: medio segundo después de teclear y otra vez cada 20 s mientras se mira -------------------
  const key = `${pairKey}:${amountIn ?? ""}`;
  const quote = quoted?.key === key ? quoted : null;
  useEffect(() => {
    if (!mirror || !mode || amountIn == null || !loaded || noLiquidity) {
      setQuoting(false);
      return;
    }
    const id = ++seq.current;
    const go = async () => {
      setQuoting(true);
      let q: Quoted = { key, amountIn, amountOut: null, impactPct: null, route: "", other: null, count: 0 };
      if (mode === "route" && rs && routes) {
        const r = await bestRouteQuote(mirror, rs, routes, amountIn).catch(() => null);
        if (r) {
          const second = r.all[1];
          q = {
            ...q,
            amountOut: r.best.amountOut,
            impactPct: r.impactPct,
            route: describeRoute(r.best.route, sym),
            other: second ? `${describeRoute(second.route, sym)}: ${formatUnits(second.amountOut, outDec, 6)} ${sym(getId)}` : null,
            count: r.all.length,
          };
        }
      } else if (setup && pools) {
        const r = await bestSwapQuote(mirror, setup, pools, mode === "buy" ? "buy" : "sell", amountIn).catch(() => null);
        if (r) {
          const second = r.all.find((x) => x.address !== r.best.address);
          q = {
            ...q,
            amountOut: r.best.amountOut,
            impactPct: r.impactPct,
            route: `SaucerSwap ${r.best.venue} · ${pctText(r.best.fee / 10_000)}`,
            other: second ? `${second.venue}: ${formatUnits(second.amountOut, outDec, 6)} ${sym(getId)}` : null,
            count: r.all.length,
          };
        }
      }
      if (id !== seq.current) return;
      setQuoted(q);
      setQuoting(false);
    };
    const first = setTimeout(go, 500);
    const again = setInterval(go, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [key, loaded, noLiquidity]); // eslint-disable-line react-hooks/exhaustive-deps

  const out = quote?.amountOut ?? null;
  const impact = quote?.impactPct ?? null;
  const minOut = out ? swapMinOut(out, slippage) : null;
  const price = (() => {
    if (!out || amountIn == null) return null;
    const i = Number(amountIn) / 10 ** inDec;
    const o = Number(out) / 10 ** outDec;
    return i > 0 && o > 0 ? o / i : null;
  })();
  const fmtNum = (n: number, d = 4) => n.toLocaleString(lang() === "en" ? "en-US" : "es-ES", { maximumFractionDigits: d });

  // ---- acciones ----------------------------------------------------------------------------------------
  const press = (k: string) => {
    haptic.tap();
    setAmount((a) => {
      if (k === "back") return a.slice(0, -1);
      if (k === ".") return a.includes(".") ? a : a === "" ? "0." : `${a}.`;
      const next = a === "0" ? k : a + k;
      const [whole, frac = ""] = next.split(".");
      if (whole.length > 12 || (next.includes(".") && frac.length > inDec)) return a;
      return next;
    });
  };
  const part = (pct: number) => {
    haptic.tap();
    const base = payId === HBAR_ASSET ? hbar - SWAP_FEE_RESERVE_TINYBARS : payBal;
    if (base <= 0n) return setAmount("");
    const v = pct >= 100 ? base : (base * BigInt(pct)) / 100n;
    setAmount(v > 0n ? formatUnits(v, inDec, inDec, "en").replace(/,/g, "") : "");
  };
  const flip = () => {
    haptic.tap();
    setPayId(getId);
    setGetId(payId);
    setAmount("");
    setQuoted(null);
  };
  const choose = (side: "pay" | "get", id: string) => {
    setPicker(null);
    const other = side === "pay" ? getId : payId;
    // Elegir el que ya está al otro lado les da la vuelta.
    if (id === other) return flip();
    if (side === "pay") setPayId(id);
    else setGetId(id);
    setAmount("");
    setQuoted(null);
  };

  const askUnverified = ({ reason, maxCostTinybars }: { reason: string; maxCostTinybars: bigint }) =>
    confirm(
      t("No se ha podido comprobar el cambio", "The swap couldn't be checked"),
      t(
        `Antes de firmar, la app simula el cambio en el servidor público de Hedera y esta vez falla (${reason || "sin motivo"}). A veces ese simulador falla con cambios que la red sí acepta.\n\nSi lo envías y la red lo rechaza, no se cambia nada y pagas solo la comisión de red: como mucho unos ${formatHbar(maxCostTinybars, 2)} HBAR.\n\nTambién puedes hacerlo en SaucerSwap desde la pestaña dApps.`,
        `Before signing, the app simulates the swap on Hedera's public server, and this time it fails (${reason || "no reason given"}). That simulator sometimes fails on swaps the network does accept.\n\nIf you send it and the network rejects it, nothing is swapped and you only pay the network fee: at most about ${formatHbar(maxCostTinybars, 2)} HBAR.\n\nYou can also do it on SaucerSwap from the dApps tab.`,
      ),
      t("Enviar igualmente", "Send anyway"),
    );

  const canSwap = !!mode && !!out && enough && !busy && !quoting && !!profile?.pocket.accountId && tokensOk;

  const doSwap = () =>
    void run(t("No se pudo hacer el cambio", "Could not swap"), async () => {
      if (!mirror || !mode || !out || amountIn == null || !minOut) return;
      const where = dest ? t("tu bóveda", "your vault") : t("tu Cartera", "your Wallet");
      const summary = t(
        `Pagas ${formatUnits(amountIn, inDec, 8)} ${sym(payId)} y recibes unos ${formatUnits(out, outDec, 6)} ${sym(getId)} (como mínimo ${formatUnits(minOut, outDec, 6)}) en ${where}.\n\nRuta: ${quote?.route ?? ""}. Pagado desde tu Cartera.`,
        `You pay ${formatUnits(amountIn, inDec, 8)} ${sym(payId)} and receive about ${formatUnits(out, outDec, 6)} ${sym(getId)} (at least ${formatUnits(minOut, outDec, 6)}) in ${where}.\n\nRoute: ${quote?.route ?? ""}. Paid from your Wallet.`,
      );
      if (!(await confirm(t("¿Hacer el cambio?", "Swap now?"), summary, t("Cambiar", "Swap")))) return;
      if (impact != null && impact >= IMPACT_CONFIRM_PCT) {
        const sure = await confirm(
          t("Impacto alto en el precio", "High price impact"),
          t(
            `Este cambio mueve el precio un ${fmtNum(impact, 1)} %: recibes bastante menos de lo que vale. Con un importe más pequeño perderías menos.`,
            `This swap moves the price by ${fmtNum(impact, 1)}%: you get much less than it's worth. A smaller amount would lose less.`,
          ),
          t("Cambiar igualmente", "Swap anyway"),
          true,
        );
        if (!sure) return;
      }
      if (checks.some((c) => !c.reviewed)) {
        const sure = await confirm(
          t("Token sin revisar", "Unreviewed token"),
          t(`${warnings.join("\n\n")}\n\n¿Seguro que es el token que quieres?`, `${warnings.join("\n\n")}\n\nAre you sure it's the token you want?`),
          t("Sí, es este", "Yes, it's this one"),
          true,
        );
        if (!sure) return;
      }
      setBusy(true);
      try {
        const res =
          mode === "route"
            ? rs && routes
              ? await withPocket(({ client, accountId }) =>
                  swapTokensFromPocket({ client, accountId, mirror, rs, routes, amountIn, agreedOut: out, slippageBps: slippage, recipientId: dest, onUnverified: askUnverified }),
                )
              : null
            : setup && pools
              ? await withPocket(({ client, accountId }) =>
                  swapFromPocket({
                    client,
                    accountId,
                    mirror,
                    setup,
                    pools,
                    side: mode,
                    amountIn,
                    agreedOut: out,
                    slippageBps: slippage,
                    recipientId: dest,
                    // Ninguna simulación pasa: se pregunta, con lo que costaría si la red lo rechaza.
                    onUnverified: askUnverified,
                  }),
                )
              : null;
        if (!res) return;
        haptic.success();
        const got = res.amountOut ?? out;
        setAmount("");
        setQuoted(null);
        void refresh();
        setDone({
          txId: res.txId,
          toVault: !!dest,
          text: t(
            `${res.amountOut != null ? "Has recibido" : "Recibirás unos"} ${formatUnits(got, outDec, 6)} ${sym(getId)} en ${dest ? "tu bóveda" : "tu Cartera"}.`,
            `${res.amountOut != null ? "You received" : "You'll receive about"} ${formatUnits(got, outDec, 6)} ${sym(getId)} in ${dest ? "your vault" : "your Wallet"}.`,
          ),
        });
      } finally {
        setBusy(false);
      }
    });

  // ---- texto del botón principal ----------------------------------------------------------------------
  const action = (() => {
    if (!mirror) return t("No disponible en esta red", "Not available on this network");
    if (!mode) return t("Elige dos activos distintos", "Pick two different assets");
    if (loadError) return t("No se pudo leer SaucerSwap", "Couldn't read SaucerSwap");
    if (checked && !tokensOk) return t("Este token no se puede cambiar", "This token can't be swapped");
    if (!loaded) return t("Buscando rutas…", "Finding routes…");
    if (noLiquidity) return t("Sin pool en SaucerSwap", "No SaucerSwap pool");
    if (amountIn == null) return t("Escribe un importe", "Enter an amount");
    if (!enough) return hbar < MIN_FEE_TINYBARS ? t("Falta 1 HBAR para comisiones", "Need 1 HBAR for fees") : t(`No tienes tanto ${sym(payId)}`, `Not enough ${sym(payId)}`);
    if (quoting && !out) return t("Cotizando…", "Getting a quote…");
    if (!out) return t("Sin liquidez para ese importe", "No liquidity for that amount");
    return dest ? t("Cambiar y guardar en la bóveda", "Swap into the vault") : t("Cambiar", "Swap");
  })();
  const impactColor = impact != null && impact >= IMPACT_CONFIRM_PCT ? colors.danger : impact != null && impact >= IMPACT_WARN_PCT ? colors.warn : colors.muted;
  const onramp = profile?.pocket.accountId ? onrampUrl(onrampTemplate, { address: profile.pocket.accountId, network: NETWORK }) : null;
  const fiatIn = amountIn != null ? fiat(amountIn, inDec, payId === HBAR_ASSET ? undefined : payId) : null;
  const fiatOut = out != null ? fiat(out, outDec, getId === HBAR_ASSET ? undefined : getId) : null;

  return (
    <Screen
      title={t("Cambiar", "Swap")}
      refreshing={refreshing}
      onRefresh={() => {
        void pullRefresh();
        void load();
      }}
      right={
        <Pressable onPress={() => setSettings(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("Tolerancia", "Slippage")} style={styles.gear}>
          <Icon name="gearshape.fill" size={18} color={colors.muted} />
        </Pressable>
      }
      footer={footer}
    >
      {stocksEnabled ? (
        <View style={{ marginBottom: space.m }}>
          <Segmented
            value={market}
            onChange={(v) => {
              haptic.tap();
              setMarket(v);
            }}
            options={[
              { value: "tokens", label: t("Tokens", "Tokens") },
              { value: "stocks", label: t("Acciones", "Stocks") },
            ]}
          />
        </View>
      ) : null}
      {market === "stocks" && stocksEnabled ? (
        <StocksPanel parts={{ AmountCard, Keypad, Line, SwapDone }} slippage={slippage} onDeposit={onDeposit} />
      ) : (
      <>
      {NETWORK === "testnet" && !swapTokenOverride ? (
        <P muted style={{ fontSize: 13 }}>
          {t("Red de pruebas: tokens de prueba de SaucerSwap.", "Test network: SaucerSwap test tokens.")}
        </P>
      ) : null}

      <View style={styles.cards}>
        <AmountCard
          label={t("Pagas", "You pay")}
          id={payId}
          symbol={sym(payId)}
          onPick={() => setPicker("pay")}
          value={amount || "0"}
          dim={!amount}
          fiatText={fiatIn}
          balance={t(`Saldo: ${formatUnits(payBal, inDec, 4)}`, `Balance: ${formatUnits(payBal, inDec, 4)}`)}
          short={amountIn != null && !enough}
        />
        <Pressable onPress={flip} accessibilityRole="button" accessibilityLabel={t("Dar la vuelta", "Switch")} style={({ pressed }) => [styles.flip, pressed && { transform: [{ rotate: "180deg" }] }]}>
          <Icon name="arrow.up.arrow.down" size={20} color={colors.brass} weight="semibold" />
        </Pressable>
        <AmountCard
          label={dest ? t("Recibes en la bóveda (aprox.)", "You get in the vault (approx.)") : t("Recibes (aprox.)", "You get (approx.)")}
          id={getId}
          symbol={sym(getId)}
          onPick={() => setPicker("get")}
          value={out != null ? formatUnits(out, outDec, 6) : "0"}
          dim={out == null}
          busy={quoting}
          fiatText={fiatOut}
          balance={t(`Saldo: ${formatUnits(balOf(getId), outDec, 4)}`, `Balance: ${formatUnits(balOf(getId), outDec, 4)}`)}
          vault={!!dest}
        />
      </View>

      {vaultId ? (
        <View style={styles.destRow}>
          <Icon name={toVault ? "lock.shield.fill" : "wallet.pass.fill"} size={16} color={toVault ? colors.brass : colors.muted} />
          <Text style={styles.destText}>{t("Recibir en", "Receive in")}</Text>
          <Segmented
            value={toVault ? "vault" : "pocket"}
            onChange={(v) => {
              haptic.tap();
              setToVault(v === "vault");
            }}
            options={[
              { value: "pocket", label: t("Cartera", "Wallet") },
              { value: "vault", label: t("Bóveda", "Vault") },
            ]}
          />
        </View>
      ) : null}

      {problems.length ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{problems.join(" ")}</P>
        </Card>
      ) : warnings.length ? (
        <View style={styles.note}>
          <Icon name="info.circle.fill" size={15} color={colors.warn} />
          <Text style={styles.noteText}>{warnings.join(" ")}</Text>
        </View>
      ) : null}
      {loadError ? <Button title={t("Reintentar", "Retry")} kind="secondary" onPress={() => void load()} /> : null}

      {out != null && quote ? (
        <Pressable onPress={() => setDetails((d) => !d)} accessibilityRole="button" style={styles.details}>
          <Row style={{ justifyContent: "space-between" }}>
            <Text style={styles.detailsHead}>{price ? `1 ${sym(payId)} ≈ ${fmtNum(price, 6)} ${sym(getId)}` : quote.route}</Text>
            <Row gap={6}>
              {impact != null ? <Text style={[styles.detailsHead, { color: impactColor }]}>{`${fmtNum(impact, 2)} %`}</Text> : null}
              <View style={{ transform: [{ rotate: details ? "-90deg" : "90deg" }] }}>
                <Icon name="chevron.right" size={12} color={colors.faint} weight="semibold" />
              </View>
            </Row>
          </Row>
          {details ? (
            <View style={{ marginTop: space.s, gap: 6 }}>
              <Line k={t("Impacto en el precio", "Price impact")} v={impact == null ? "—" : `${fmtNum(impact, 2)} %`} color={impactColor} />
              {minOut ? <Line k={t("Mínimo a recibir", "Minimum received")} v={`${formatUnits(minOut, outDec, 6)} ${sym(getId)}`} /> : null}
              <Line k={t("Tolerancia", "Slippage")} v={pctText(slippage / 100)} />
              <Line k={t("Ruta", "Route")} v={quote.route} />
              {quote.other ? <Line k={t(`La mejor de ${quote.count}`, `Best of ${quote.count}`)} v={quote.other} /> : null}
              <Line k={t("Comisión de H10X Wallet", "H10X Wallet fee")} v={t("ninguna", "none")} />
            </View>
          ) : null}
        </Pressable>
      ) : null}

      <Button title={action} icon={canSwap ? (dest ? "lock.shield.fill" : "arrow.left.arrow.right") : undefined} disabled={!canSwap} busy={busy} onPress={doSwap} />

      <Keypad onKey={press} onPart={part} onClear={() => setAmount("")} />

      <P muted style={{ marginTop: space.m, fontSize: 13 }}>
        {t(
          "El cambio sale de tu Cartera, nunca de la bóveda, y se firma con Face ID. Sin comisión de H10X Wallet: solo la de SaucerSwap y la de la red.",
          "The swap comes from your Wallet, never from the vault, and you sign it with Face ID. No H10X Wallet fee: only SaucerSwap's and the network's.",
        )}
      </P>
      {!dest ? <Button title={t("Guardar en la bóveda", "Store in the vault")} kind="ghost" icon="lock.shield.fill" onPress={onDeposit} /> : null}

      <SectionTitle>{t("Comprar con tarjeta", "Buy with card")}</SectionTitle>
      <Card>
        <Row style={{ justifyContent: "space-between", marginBottom: space.s }}>
          <Row gap={space.s}>
            <Icon name="creditcard" size={18} color={colors.brass} />
            <H2 style={{ marginBottom: 0 }}>{t("Con tu tarjeta", "With your card")}</H2>
          </Row>
          {onramp ? null : <Badge text={t("Próximamente", "Coming soon")} tone="brass" />}
        </Row>
        <P muted style={onramp ? undefined : { marginBottom: 0 }}>
          {t(
            "Compras HBAR con tu tarjeta en un proveedor externo (él hace la verificación y el pago) y te llega a la Cartera. Después, aquí lo cambias por H10X. H10X Wallet nunca ve los datos de tu tarjeta.",
            "You buy HBAR with your card from an external provider (it handles verification and payment) and it arrives in your Wallet. Then you swap it for H10X here. H10X Wallet never sees your card details.",
          )}
        </P>
        {onramp ? <Button title={t(`Comprar HBAR en ${onrampHost(onramp)}`, `Buy HBAR on ${onrampHost(onramp)}`)} kind="secondary" icon="creditcard" onPress={() => open(onramp)} /> : null}
      </Card>
      </>
      )}

      {picker ? (
        <TokenPicker
          side={picker}
          list={list}
          selected={picker === "pay" ? payId : getId}
          pocketTokens={tokens.pocket}
          hbarBalance={hbar}
          onClose={() => setPicker(null)}
          onPick={(id) => choose(picker, id)}
        />
      ) : null}
      {settings ? <SlippageSheet value={slippage} onChange={setSlippage} onClose={() => setSettings(false)} /> : null}
      {done ? <SwapDone text={done.text} toVault={done.toVault} txId={done.txId} onClose={() => setDone(null)} onDeposit={onDeposit} /> : null}
    </Screen>
  );
}

/** «0,3 %» a partir de un porcentaje (0.3). */
const pctText = (n: number) => `${n.toLocaleString(lang() === "en" ? "en-US" : "es-ES", { maximumFractionDigits: 2 })} %`;

function Line({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <Row style={{ justifyContent: "space-between" }}>
      <Text style={styles.lineKey}>{k}</Text>
      <Text style={[styles.lineValue, color ? { color } : null]} numberOfLines={2}>
        {v}
      </Text>
    </Row>
  );
}

/** Tarjeta de importe: etiqueta, cifra grande, pastilla del token, su valor y el saldo. */
function AmountCard(p: {
  label: string;
  id: string;
  symbol: string;
  onPick: () => void;
  value: string;
  dim?: boolean;
  busy?: boolean;
  fiatText: string | null;
  balance: string;
  short?: boolean;
  vault?: boolean;
}) {
  return (
    <View style={[styles.card, p.vault ? { borderColor: colors.brassLine } : null]}>
      <Row style={{ justifyContent: "space-between" }}>
        <Text style={styles.cardLabel}>{p.label}</Text>
        {p.vault ? <Icon name="lock.shield.fill" size={14} color={colors.brass} /> : null}
      </Row>
      <Row style={{ justifyContent: "space-between", alignItems: "center", marginVertical: space.s }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", marginRight: space.s }}>
          <Text style={[styles.amount, p.dim ? { color: colors.faint } : null, p.short ? { color: colors.warn } : null]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
            {p.value}
          </Text>
          {p.busy ? <ActivityIndicator color={colors.brass} style={{ marginLeft: space.s }} /> : null}
        </View>
        <Pressable onPress={p.onPick} accessibilityRole="button" accessibilityLabel={`${p.symbol}, ${t("cambiar token", "change token")}`} style={({ pressed }) => [styles.pill, pressed ? { backgroundColor: colors.surfaceStrong } : null]}>
          <TokenLogo id={p.id} symbol={p.symbol} size={26} />
          <Text style={styles.pillText}>{p.symbol}</Text>
          <View style={{ transform: [{ rotate: "90deg" }] }}>
            <Icon name="chevron.right" size={11} color={colors.muted} weight="semibold" />
          </View>
        </Pressable>
      </Row>
      <Row style={{ justifyContent: "space-between" }}>
        <Text style={styles.cardSmall}>{p.fiatText ?? " "}</Text>
        <Text style={styles.cardSmall}>{p.balance}</Text>
      </Row>
    </View>
  );
}

/** Teclado propio: 25 %, 50 %, Máx y Borrar a la izquierda; cifras, coma y borrar una a la derecha. */
function Keypad({ onKey, onPart, onClear }: { onKey: (k: string) => void; onPart: (pct: number) => void; onClear: () => void }) {
  const decimal = lang() === "en" ? "." : ",";
  const side = [
    { label: "25 %", on: () => onPart(25) },
    { label: "50 %", on: () => onPart(50) },
    { label: t("Máx", "Max"), on: () => onPart(100) },
    { label: t("Borrar", "Clear"), on: onClear },
  ];
  const keys = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    [".", "0", "back"],
  ];
  return (
    <View style={styles.keypad}>
      {keys.map((row, i) => (
        <View key={i} style={styles.keyRow}>
          <Pressable onPress={side[i].on} accessibilityRole="button" style={({ pressed }) => [styles.sideKey, pressed ? styles.pressed : null]}>
            <Text style={styles.sideKeyText}>{side[i].label}</Text>
          </Pressable>
          {row.map((k) => (
            <Pressable
              key={k}
              onPress={() => onKey(k)}
              accessibilityRole="button"
              accessibilityLabel={k === "back" ? t("Borrar una cifra", "Delete one digit") : k === "." ? decimal : k}
              style={({ pressed }) => [styles.key, k === "back" ? styles.backKey : null, pressed ? styles.pressed : null]}
            >
              {k === "back" ? <Icon name="chevron.left" size={20} color={colors.text} weight="semibold" /> : <Text style={styles.keyText}>{k === "." ? decimal : k}</Text>}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

type PocketToken = { tokenId: string; symbol: string; name: string; decimals: number; balance: bigint };

/** Selector de token a pantalla completa: lista revisada, tus tokens sin revisar y «pegar ID» con su comprobación. */
function TokenPicker(p: {
  side: "pay" | "get";
  list: SwapTokenEntry[];
  selected: string;
  pocketTokens: PocketToken[];
  hbarBalance: bigint;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [pasted, setPasted] = useState<{ id: string; info: TokenInfo | null; check: Check } | null>(null);
  const [looking, setLooking] = useState(false);
  const query = q.trim();
  const isId = /^0\.0\.\d{1,10}$/.test(query);
  const reviewedIds = new Set(p.list.map((x) => x.id));
  const bal = (id: string) => p.pocketTokens.find((x) => x.tokenId === id);
  const match = (symbol: string, name: string, id: string) => {
    if (!query) return true;
    if (isId) return id === query;
    return `${symbol} ${name} ${id}`.toLowerCase().includes(query.toLowerCase());
  };

  useEffect(() => {
    if (!isId || reviewedIds.has(query) || !mirror) {
      setPasted(null);
      return;
    }
    let alive = true;
    setLooking(true);
    void mirror
      .tokenInfo(query, { fresh: true })
      .catch(() => null)
      .then((info) => {
        if (!alive) return;
        setPasted({ id: query, info, check: checkPastedToken(NETWORK, info) });
        setLooking(false);
      });
    return () => {
      alive = false;
    };
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPasted = async () => {
    if (!pasted?.info || !pasted.check.ok) return;
    const ok = await confirm(
      t("Token sin revisar", "Unreviewed token"),
      `${pasted.info.name} (${pasted.info.symbol}) · ${pasted.id}\n\n${pasted.check.warnings.join("\n\n")}`,
      t("Usar este token", "Use this token"),
      true,
    );
    if (ok) p.onPick(pasted.id);
  };

  const rows = [{ id: HBAR_ASSET, symbol: "HBAR", name: "Hedera" }, ...p.list.map((x) => ({ id: x.id, symbol: x.symbol || x.id, name: x.name }))].filter((x) =>
    match(x.symbol, x.name, x.id),
  );
  const yours = p.pocketTokens.filter((x) => !reviewedIds.has(x.tokenId) && x.balance > 0n && match(x.symbol, x.name, x.tokenId));

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={p.onClose}>
      <Backdrop>
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{p.side === "pay" ? t("Pagas con", "Pay with") : t("Recibes", "Receive")}</Text>
            <Pressable onPress={p.onClose} hitSlop={12} accessibilityRole="button">
              <Text style={styles.sheetClose}>{t("Cerrar", "Close")}</Text>
            </Pressable>
          </View>
          <View style={styles.search}>
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={t("Buscar o pegar ID (0.0.…)", "Search or paste ID (0.0.…)")}
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
          </View>
          <ScrollView contentContainerStyle={{ padding: space.l, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
            {isId && !reviewedIds.has(query) ? (
              <View style={[styles.pasted, pasted && !pasted.check.ok ? { borderColor: colors.dangerLine } : null]}>
                {looking || !pasted ? (
                  <ActivityIndicator color={colors.brass} />
                ) : !pasted.info ? (
                  <P style={{ marginBottom: 0 }}>{t("No existe ningún token con ese ID.", "No token with that ID.")}</P>
                ) : (
                  <>
                    <Row gap={space.s}>
                      <TokenLogo id={pasted.id} symbol={pasted.info.symbol} size={36} warn={pasted.check.ok ? "warn" : "danger"} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{pasted.info.symbol}</Text>
                        <Text style={styles.rowSub}>{`${pasted.info.name} · ${pasted.id}`}</Text>
                      </View>
                      <Badge text={t("Sin revisar", "Unreviewed")} tone={pasted.check.ok ? "warn" : "danger"} />
                    </Row>
                    <Text style={[styles.rowSub, { marginTop: space.s, color: pasted.check.ok ? colors.warn : colors.danger }]}>
                      {[...pasted.check.problems, ...pasted.check.warnings].join(" ")}
                    </Text>
                    {pasted.check.ok ? <Button title={t("Usar este token", "Use this token")} kind="secondary" onPress={() => void pickPasted()} style={{ marginTop: space.m }} /> : null}
                  </>
                )}
              </View>
            ) : null}

            <Text style={styles.section}>{t("Revisados", "Reviewed")}</Text>
            <Group>
              {rows.map((x) => {
                const b = x.id === HBAR_ASSET ? { balance: p.hbarBalance, decimals: 8 } : bal(x.id);
                return (
                  <Pressable key={x.id} onPress={() => p.onPick(x.id)} accessibilityRole="button" style={({ pressed }) => [styles.tokenRow, pressed ? styles.pressed : null]}>
                    <TokenLogo id={x.id} symbol={x.symbol} size={36} ring={x.id === p.selected ? colors.brass : undefined} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{x.symbol}</Text>
                      <Text style={styles.rowSub}>{x.id === HBAR_ASSET ? x.name : `${x.name} · ${x.id}`}</Text>
                    </View>
                    {b && b.balance > 0n ? <Text style={styles.rowValue}>{formatUnits(b.balance, b.decimals, 4)}</Text> : null}
                    <Icon name="checkmark.seal.fill" size={15} color={colors.brass} />
                  </Pressable>
                );
              })}
            </Group>

            {yours.length ? (
              <>
                <Text style={styles.section}>{t("En tu Cartera, sin revisar", "In your Wallet, unreviewed")}</Text>
                <Group>
                  {yours.map((x) => (
                    <Pressable key={x.tokenId} onPress={() => setQ(x.tokenId)} accessibilityRole="button" style={({ pressed }) => [styles.tokenRow, pressed ? styles.pressed : null]}>
                      <TokenLogo id={x.tokenId} symbol={x.symbol} size={36} warn="warn" />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{x.symbol}</Text>
                        <Text style={styles.rowSub}>{`${x.name} · ${x.tokenId}`}</Text>
                      </View>
                      <Text style={styles.rowValue}>{formatUnits(x.balance, x.decimals, 4)}</Text>
                    </Pressable>
                  ))}
                </Group>
              </>
            ) : null}
            <P muted style={{ marginTop: space.l, fontSize: 13 }}>
              {t(
                "Los revisados tienen pool en SaucerSwap, sin comisiones ni KYC. Cualquier otro se comprueba antes de usarlo, y se bloquea si imita a uno de la lista o a HBAR.",
                "Reviewed tokens have a SaucerSwap pool, no fees and no KYC. Any other is checked before use, and blocked if it imitates a listed token or HBAR.",
              )}
            </P>
          </ScrollView>
        </SafeAreaView>
      </Backdrop>
    </Modal>
  );
}

/** Tolerancia (el engranaje de arriba). */
function SlippageSheet({ value, onChange, onClose }: { value: number; onChange: (v: number) => void; onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.smallSheet} onPress={() => undefined}>
          <H2>{t("Tolerancia", "Slippage")}</H2>
          <P muted>
            {t(
              "Si el precio se mueve más que esto mientras se envía, el cambio no se hace y no pierdes nada.",
              "If the price moves more than this while sending, the swap doesn't go through and you lose nothing.",
            )}
          </P>
          <Segmented
            value={String(value)}
            onChange={(v) => {
              haptic.tap();
              onChange(Number(v));
            }}
            options={SLIPPAGE_CHOICES_BPS.map((b) => ({ value: String(b), label: pctText(b / 100) }))}
          />
          <Button title={t("Listo", "Done")} onPress={onClose} style={{ marginTop: space.l }} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Cambio hecho: el sello entra con un pequeño rebote (la vibración de confirmación ya ha sonado). */
function SwapDone({ text, toVault, txId, onClose, onDeposit, title }: { text: string; toVault: boolean; txId: string; onClose: () => void; onDeposit: () => void; title?: string }) {
  const scale = useRef(new Animated.Value(0.6)).current;
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }),
      Animated.timing(fade, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [scale, fade]);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Animated.View style={[styles.doneCard, { opacity: fade, transform: [{ scale }] }]}>
          <Icon name={toVault ? "lock.shield.fill" : "checkmark.circle.fill"} size={54} color={colors.brass} weight="semibold" />
          <Text style={styles.doneTitle}>{title ?? t("Cambio hecho", "Swap done")}</Text>
          <P center>{text}</P>
          {!toVault ? (
            <P muted center style={{ fontSize: 13 }}>
              {t("Para protegerlo, guárdalo en la bóveda.", "To protect it, store it in the vault.")}
            </P>
          ) : null}
          <Button title={t("Listo", "Done")} onPress={onClose} style={{ alignSelf: "stretch" }} />
          {!toVault ? (
            <Button
              title={t("Guardar en la bóveda", "Store in the vault")}
              kind="ghost"
              icon="lock.shield.fill"
              onPress={() => {
                onClose();
                onDeposit();
              }}
            />
          ) : null}
          <Button title={t("Ver en HashScan", "View on HashScan")} kind="ghost" onPress={() => open(txLink(txId))} />
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  gear: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  cards: { gap: space.s, marginBottom: space.m },
  card: { backgroundColor: colors.surface, borderRadius: radius.l, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: space.l },
  cardLabel: { color: colors.muted, fontSize: 14 },
  cardSmall: { color: colors.muted, fontSize: 13 },
  amount: { color: colors.text, fontSize: 40, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "600", flexShrink: 1 },
  pill: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 6, paddingRight: 12, borderRadius: 999, backgroundColor: colors.surfaceStrong },
  pillText: { color: colors.text, fontSize: 17, fontWeight: "600" },
  flip: {
    alignSelf: "center",
    marginVertical: -space.l - 4,
    zIndex: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.steelTop,
    borderWidth: 1,
    borderColor: colors.brassLine,
  },
  destRow: { flexDirection: "row", alignItems: "center", gap: space.s, marginBottom: space.m },
  destText: { color: colors.muted, fontSize: 14, flex: 1 },
  note: { flexDirection: "row", gap: space.s, alignItems: "flex-start", marginBottom: space.m },
  noteText: { color: colors.muted, fontSize: 13, flex: 1 },
  details: { backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, marginBottom: space.m },
  detailsHead: { color: colors.muted, fontSize: 13 },
  lineKey: { color: colors.muted, fontSize: 13 },
  lineValue: { color: colors.text, fontSize: 13, textAlign: "right", flexShrink: 1, marginLeft: space.m },
  keypad: { marginTop: space.l, gap: space.s },
  keyRow: { flexDirection: "row", gap: space.s },
  sideKey: { flex: 1.15, height: 52, borderRadius: 999, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  sideKeyText: { color: colors.text, fontSize: 16, fontWeight: "500" },
  key: { flex: 1, height: 52, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  backKey: { borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  keyText: { color: colors.text, fontSize: 28, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "500" },
  pressed: { backgroundColor: colors.surfaceStrong },
  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.l, paddingTop: space.l },
  sheetTitle: { color: colors.text, fontSize: 22, fontFamily: typeface.displayBold, fontWeight: typeface.displayBold ? undefined : "700" },
  sheetClose: { color: colors.link, fontSize: 16 },
  search: { marginHorizontal: space.l, marginTop: space.m, borderRadius: radius.m, backgroundColor: colors.surfaceStrong, paddingHorizontal: space.m },
  searchInput: { color: colors.text, fontSize: 16, paddingVertical: 12 },
  section: { color: colors.muted, fontSize: 13, marginTop: space.l, marginBottom: space.s, textTransform: "uppercase", letterSpacing: 0.6 },
  tokenRow: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.m, paddingVertical: 10 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  rowSub: { color: colors.muted, fontSize: 12 },
  rowValue: { color: colors.text, fontSize: 14 },
  pasted: { borderRadius: radius.m, borderWidth: 1, borderColor: colors.warnLine, padding: space.m, backgroundColor: colors.surface },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: space.xl },
  smallSheet: { alignSelf: "stretch", backgroundColor: colors.steelTop, borderRadius: radius.l, padding: space.xl, borderWidth: 1, borderColor: colors.border },
  doneCard: { alignSelf: "stretch", alignItems: "center", gap: space.s, backgroundColor: colors.steelTop, borderRadius: radius.xl, padding: space.xl, borderWidth: 1, borderColor: colors.brassLine },
  doneTitle: { color: colors.text, fontSize: 24, marginTop: space.s, fontFamily: typeface.displayBold, fontWeight: typeface.displayBold ? undefined : "700" },
});
