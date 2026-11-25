// Cambiar → Acciones (0.10.2, fase 3): comprar y vender acciones tokenizadas de Robinhood con HBAR o USDC a través de
// SODAX, con lo comprado en la Cartera o directo en la bóveda. Solo en mainnet (SODAX no tiene red de pruebas): en
// testnet se ven los precios reales, pero el botón no deja comprar.
// La lógica y todas las comprobaciones están en el núcleo (core/src/stocks.js). Aquí, la pantalla: las condiciones de
// SODAX la primera vez (país, persona de EE. UU. y aviso del emisor), el selector de acciones y el cambio.
// Los trozos de la pantalla de tokens (tarjetas, teclado, detalles, «hecho») llegan por props desde Swap.tsx, para que
// los dos archivos no se importen el uno al otro.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  HBAR,
  Mirror,
  NETWORKS,
  SODAX,
  STOCK_ELIGIBILITY,
  STOCK_NOTICE,
  STOCK_PAY,
  STOCK_TOKENS,
  formatUnits,
  parseUnits,
  sodaxApi,
  stockAddress,
  stockEligibility,
  stockSwapFromPocket,
  type StockEntry,
  type StockStep,
} from "@boveda/core";
import { Backdrop, Button, Card, Group, H2, Icon, P, Row, Segmented } from "../ui";
import { colors, radius, space, typeface } from "../theme";
import { useWallet } from "../wallet";
import { usePrices } from "../prices";
import { usePrefs } from "../prefs";
import { TokenLogo } from "../components/Assets";
import { NETWORK } from "../env";
import { lang, t } from "../i18n";
import { confirm, haptic, run } from "../helpers";

const api = sodaxApi();
const CAN_TRADE = NETWORK === SODAX.network;
const NET = (NETWORKS as Record<string, { mirror: string } | undefined>)[NETWORK];
const mirror = NET ? new Mirror(NET.mirror, fetch) : null;
/** HBAR que hay que dejar en la Cartera para las comisiones de red (asociar, permiso y la transacción EVM). */
const FEE_RESERVE = 3n * HBAR;

type Pay = "HBAR" | "USDC";
type Side = "buy" | "sell";
type Quote = { key: string; out: bigint | null; error: string | null };

/** Lo que presta la pantalla de tokens (Swap.tsx). */
export type StockParts = {
  AmountCard: (p: {
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
  }) => React.ReactElement;
  Keypad: (p: { onKey: (k: string) => void; onPart: (pct: number) => void; onClear: () => void }) => React.ReactElement;
  Line: (p: { k: string; v: string; color?: string }) => React.ReactElement;
  SwapDone: (p: { text: string; toVault: boolean; txId: string; onClose: () => void; onDeposit: () => void; title?: string }) => React.ReactElement;
};

const PAY_ID: Record<Pay, string> = { HBAR: "HBAR", USDC: STOCK_PAY.USDC.tokenId ?? "" };

export function StocksPanel({ parts, slippage, onDeposit }: { parts: StockParts; slippage: number; onDeposit: () => void }) {
  const { AmountCard, Keypad, Line, SwapDone } = parts;
  const { profile, balances, tokens, withPocket, refresh } = useWallet();
  const { fiat } = usePrices();
  const { prefs, setPrefs } = usePrefs();
  const eligible = stockEligibility(prefs.stocks).ok;
  const [terms, setTerms] = useState(false);
  const [side, setSide] = useState<Side>("buy");
  const [pay, setPay] = useState<Pay>("HBAR");
  const [stock, setStock] = useState<StockEntry>(STOCK_TOKENS[0]);
  const [amount, setAmount] = useState("");
  const [toVault, setToVault] = useState(false);
  const [picker, setPicker] = useState(false);
  const [details, setDetails] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<StockStep | null>(null);
  const [done, setDone] = useState<{ txId: string; text: string; toVault: boolean } | null>(null);
  const seq = useRef(0);

  const vaultId = profile?.vault?.accountId ?? null;
  const dest = toVault && vaultId ? vaultId : null;
  const payDec = STOCK_PAY[pay].decimals;
  const inDec = side === "buy" ? payDec : 8;
  const outDec = side === "buy" ? 8 : payDec;
  const inId = side === "buy" ? PAY_ID[pay] : stock.id;
  const outId = side === "buy" ? stock.id : PAY_ID[pay];
  const inSym = side === "buy" ? pay : stock.symbol;
  const outSym = side === "buy" ? stock.symbol : pay;
  const amountIn = parseUnits(amount.replace(/[.,]$/, ""), inDec);
  const hbar = balances.pocket ?? 0n;
  const balOf = (id: string) => (id === "HBAR" ? hbar : tokens.pocket.find((x) => x.tokenId === id)?.balance ?? 0n);
  const inBal = balOf(inId);
  const enough = amountIn != null && amountIn > 0n && (inId === "HBAR" ? amountIn + FEE_RESERVE <= hbar : amountIn <= inBal && hbar >= FEE_RESERVE);

  // ---- cotización (SODAX): medio segundo después de teclear y cada 20 s ------------------------------------
  const key = `${side}:${pay}:${stock.id}:${amountIn ?? ""}`;
  const q = quote?.key === key ? quote : null;
  useEffect(() => {
    if (!eligible || amountIn == null || amountIn <= 0n) {
      setQuoting(false);
      return;
    }
    const id = ++seq.current;
    const tokenSrc = side === "buy" ? STOCK_PAY[pay].address : stockAddress(stock.id);
    const tokenDst = side === "buy" ? stockAddress(stock.id) : STOCK_PAY[pay].address;
    const go = async () => {
      setQuoting(true);
      let next: Quote = { key, out: null, error: null };
      try {
        next = { key, out: await api.quote({ tokenSrc, tokenDst, amount: amountIn }), error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        next = {
          key,
          out: null,
          error: /too low|minimum/i.test(msg)
            ? t("Importe demasiado pequeño para SODAX. Prueba con algo más.", "Amount too small for SODAX. Try a bit more.")
            : t("Ahora no hay precio (el mercado puede estar cerrado). Prueba más tarde.", "No price right now (the market may be closed). Try later."),
        };
      }
      if (id !== seq.current) return;
      setQuote(next);
      setQuoting(false);
    };
    const first = setTimeout(go, 600);
    const again = setInterval(go, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [key, eligible]); // eslint-disable-line react-hooks/exhaustive-deps

  const out = q?.out ?? null;
  const minOut = out ? (out * BigInt(10_000 - slippage)) / 10_000n : null;
  const fmtNum = (n: number, d = 4) => n.toLocaleString(lang() === "en" ? "en-US" : "es-ES", { maximumFractionDigits: d });
  /** Precio de una acción en la moneda de pago. */
  const perShare = (() => {
    if (!out || amountIn == null) return null;
    const i = Number(amountIn) / 10 ** inDec;
    const o = Number(out) / 10 ** outDec;
    if (!(i > 0 && o > 0)) return null;
    return side === "buy" ? i / o : o / i;
  })();
  const fiatPay = (v: bigint | null) => (v == null ? null : fiat(v, payDec, pay === "HBAR" ? undefined : PAY_ID.USDC));
  const fiatIn = side === "buy" ? fiatPay(amountIn) : out != null ? fiatPay(out) : null;
  const fiatOut = side === "buy" ? fiatPay(amountIn) : fiatPay(out);

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
    const base = inId === "HBAR" ? hbar - FEE_RESERVE : inBal;
    if (base <= 0n) return setAmount("");
    const v = pct >= 100 ? base : (base * BigInt(pct)) / 100n;
    setAmount(v > 0n ? formatUnits(v, inDec, inDec, "en").replace(/,/g, "") : "");
  };
  const reset = () => {
    setAmount("");
    setQuote(null);
  };

  const STEP_TEXT: Record<StockStep, string> = {
    check: t("Comprobando…", "Checking…"),
    associate: t("Preparando la Cartera…", "Preparing the Wallet…"),
    quote: t("Cotizando de nuevo…", "Re-quoting…"),
    prepare: t("Comprobando lo que prepara SODAX…", "Checking what SODAX prepared…"),
    approve: t("Dando el permiso exacto…", "Granting the exact allowance…"),
    sign: t("Firmando…", "Signing…"),
    relay: t("Avisando a SODAX…", "Notifying SODAX…"),
    settle: t("Esperando a que SODAX lo complete (hasta unos minutos)…", "Waiting for SODAX to complete it (up to a few minutes)…"),
    deliver: t("Completado. Llegando a Hedera…", "Completed. Arriving on Hedera…"),
    done: t("Hecho", "Done"),
  };

  const canTrade = CAN_TRADE && !!mirror && eligible && !!out && enough && !busy && !quoting && !!profile?.pocket.accountId;
  const doTrade = () =>
    void run(side === "buy" ? t("No se pudo comprar", "Could not buy") : t("No se pudo vender", "Could not sell"), async () => {
      if (!mirror || !out || amountIn == null || !minOut) return;
      const where = dest ? t("tu bóveda", "your vault") : t("tu Cartera", "your Wallet");
      const summary = t(
        `${side === "buy" ? "Pagas" : "Vendes"} ${formatUnits(amountIn, inDec, 8)} ${inSym} y recibes unos ${formatUnits(out, outDec, 8)} ${outSym} (como mínimo ${formatUnits(minOut, outDec, 8)}) en ${where}.\n\nLo completa SODAX en unos minutos. Si nadie lo completa a tiempo, la orden caduca. Sin comisión de H10X Wallet.`,
        `You ${side === "buy" ? "pay" : "sell"} ${formatUnits(amountIn, inDec, 8)} ${inSym} and receive about ${formatUnits(out, outDec, 8)} ${outSym} (at least ${formatUnits(minOut, outDec, 8)}) in ${where}.\n\nSODAX completes it within a few minutes. If nobody completes it in time, the order expires. No H10X Wallet fee.`,
      );
      if (!(await confirm(side === "buy" ? t(`¿Comprar ${stock.symbol}?`, `Buy ${stock.symbol}?`) : t(`¿Vender ${stock.symbol}?`, `Sell ${stock.symbol}?`), summary, side === "buy" ? t("Comprar", "Buy") : t("Vender", "Sell")))) return;
      setBusy(true);
      setStep(null);
      try {
        const res = await withPocket(({ client, key, accountId }) =>
          stockSwapFromPocket({
            client,
            key,
            accountId,
            network: NETWORK,
            mirror,
            api,
            trade: { side, stock, pay },
            amountIn,
            agreedOut: out,
            slippageBps: slippage,
            eligibility: prefs.stocks,
            recipientId: dest,
            onStep: setStep,
          }),
        );
        haptic.success();
        reset();
        void refresh();
        const settled = res.status === "solved";
        const got = res.delivered && res.received != null && res.received > 0n ? res.received : out;
        setDone({
          txId: res.txId,
          toVault: !!dest,
          text: settled && res.delivered
            ? t(`Has recibido ${formatUnits(got, outDec, 8)} ${outSym} en ${dest ? "tu bóveda" : "tu Cartera"}.`, `You received ${formatUnits(got, outDec, 8)} ${outSym} in ${dest ? "your vault" : "your Wallet"}.`)
            : settled
              ? t(`SODAX ya lo ha completado. Llegará a ${dest ? "tu bóveda" : "tu Cartera"} en unos minutos.`, `SODAX has completed it. It will reach ${dest ? "your vault" : "your Wallet"} in a few minutes.`)
              : t(
                `Orden enviada. SODAX todavía no la ha completado: mira tu saldo en unos minutos.`,
                `Order sent. SODAX hasn't completed it yet: check your balance in a few minutes.`,
              ),
        });
      } finally {
        setBusy(false);
        setStep(null);
      }
    });

  const action = (() => {
    if (!eligible) return t("Acepta las condiciones para empezar", "Accept the conditions to start");
    if (!CAN_TRADE) return t("Solo en mainnet", "Mainnet only");
    if (amountIn == null || amountIn <= 0n) return t("Escribe un importe", "Enter an amount");
    if (!enough) return hbar < FEE_RESERVE ? t("Faltan 3 HBAR para comisiones", "Need 3 HBAR for fees") : t(`No tienes tanto ${inSym}`, `Not enough ${inSym}`);
    if (quoting && !out) return t("Cotizando…", "Getting a quote…");
    if (!out) return q?.error ?? t("Sin precio", "No price");
    if (busy && step) return STEP_TEXT[step];
    if (side === "buy") return dest ? t(`Comprar ${stock.symbol} a la bóveda`, `Buy ${stock.symbol} into the vault`) : t(`Comprar ${stock.symbol}`, `Buy ${stock.symbol}`);
    return t(`Vender ${stock.symbol}`, `Sell ${stock.symbol}`);
  })();

  if (!eligible) {
    return (
      <>
        <Card tone="brass">
          <Row gap={space.s} style={{ marginBottom: space.s }}>
            <Icon name="chart.line.uptrend.xyaxis" size={20} color={colors.brass} />
            <H2 style={{ marginBottom: 0 }}>{t("Acciones tokenizadas", "Tokenized stocks")}</H2>
          </Row>
          <P muted>
            {t(
              "Apple, NVIDIA, Tesla y más, como tokens de Hedera que siguen el precio de la acción. Las compras con HBAR o USDC y puedes guardarlas en tu bóveda.",
              "Apple, NVIDIA, Tesla and more, as Hedera tokens that track the share price. Buy them with HBAR or USDC and keep them in your vault.",
            )}
          </P>
          <Button title={t("Ver condiciones y empezar", "See conditions and start")} icon="chart.line.uptrend.xyaxis" onPress={() => setTerms(true)} />
        </Card>
        {terms ? <StockTerms onClose={() => setTerms(false)} onAccept={(c) => void setPrefs({ stocks: c }).then(() => setTerms(false))} /> : null}
      </>
    );
  }

  return (
    <>
      {!CAN_TRADE ? (
        <View style={styles.note}>
          <Icon name="info.circle.fill" size={15} color={colors.warn} />
          <Text style={styles.noteText}>
            {t(
              "Red de pruebas: precios reales de mainnet, pero no se puede comprar (SODAX solo funciona en mainnet).",
              "Test network: real mainnet prices, but you can't buy (SODAX only works on mainnet).",
            )}
          </Text>
        </View>
      ) : null}

      <Segmented
        value={side}
        onChange={(v) => {
          haptic.tap();
          setSide(v);
          reset();
        }}
        options={[
          { value: "buy", label: t("Comprar", "Buy") },
          { value: "sell", label: t("Vender", "Sell") },
        ]}
      />

      <View style={[styles.cards, { marginTop: space.m }]}>
        <AmountCard
          label={side === "buy" ? t("Pagas", "You pay") : t("Vendes", "You sell")}
          id={inId}
          symbol={inSym}
          onPick={() => (side === "buy" ? setPay(pay === "HBAR" ? "USDC" : "HBAR") : setPicker(true))}
          value={amount || "0"}
          dim={!amount}
          fiatText={fiatIn}
          balance={t(`Saldo: ${formatUnits(inBal, inDec, 4)}`, `Balance: ${formatUnits(inBal, inDec, 4)}`)}
          short={amountIn != null && amountIn > 0n && !enough}
        />
        <View style={styles.flipDot}>
          <Icon name="arrow.up.arrow.down" size={18} color={colors.brass} weight="semibold" />
        </View>
        <AmountCard
          label={dest ? t("Recibes en la bóveda (aprox.)", "You get in the vault (approx.)") : t("Recibes (aprox.)", "You get (approx.)")}
          id={outId}
          symbol={outSym}
          onPick={() => (side === "buy" ? setPicker(true) : setPay(pay === "HBAR" ? "USDC" : "HBAR"))}
          value={out != null ? formatUnits(out, outDec, 8) : "0"}
          dim={out == null}
          busy={quoting}
          fiatText={fiatOut}
          balance={t(`Saldo: ${formatUnits(balOf(outId), outDec, 4)}`, `Balance: ${formatUnits(balOf(outId), outDec, 4)}`)}
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

      {q?.error && !out ? (
        <View style={styles.note}>
          <Icon name="exclamationmark.triangle.fill" size={15} color={colors.warn} />
          <Text style={styles.noteText}>{q.error}</Text>
        </View>
      ) : null}

      {out != null && perShare ? (
        <Pressable onPress={() => setDetails((d) => !d)} accessibilityRole="button" style={styles.details}>
          <Row style={{ justifyContent: "space-between" }}>
            <Text style={styles.detailsHead}>{`1 ${stock.symbol} ≈ ${fmtNum(perShare, 2)} ${pay}`}</Text>
            <View style={{ transform: [{ rotate: details ? "-90deg" : "90deg" }] }}>
              <Icon name="chevron.right" size={12} color={colors.faint} weight="semibold" />
            </View>
          </Row>
          {details ? (
            <View style={{ marginTop: space.s, gap: 6 }}>
              {minOut ? <Line k={t("Mínimo a recibir", "Minimum received")} v={`${formatUnits(minOut, outDec, 8)} ${outSym}`} /> : null}
              <Line k={t("Tolerancia", "Slippage")} v={`${fmtNum(slippage / 100, 2)} %`} />
              <Line k={t("Ruta", "Route")} v={t("SODAX · acción de Robinhood", "SODAX · Robinhood stock")} />
              <Line k={t("Tiempo", "Time")} v={t("unos minutos", "a few minutes")} />
              <Line k={t("Comisión de H10X Wallet", "H10X Wallet fee")} v={t("ninguna", "none")} />
            </View>
          ) : null}
        </Pressable>
      ) : null}

      <Button
        title={action}
        icon={canTrade ? (dest ? "lock.shield.fill" : "chart.line.uptrend.xyaxis") : undefined}
        disabled={!canTrade}
        busy={busy}
        onPress={doTrade}
      />
      {busy && step ? <P muted center style={{ marginTop: space.s, fontSize: 13 }}>{STEP_TEXT[step]}</P> : null}

      <Keypad onKey={press} onPart={part} onClear={() => setAmount("")} />

      <P muted style={{ marginTop: space.m, fontSize: 13 }}>
        {t(
          "Sale de tu Cartera, nunca de la bóveda, y se firma con Face ID. Las acciones las emite Robinhood y el cambio lo hace SODAX: H10X Wallet no es un bróker ni cobra comisión.",
          "It comes from your Wallet, never from the vault, and you sign it with Face ID. Robinhood issues the stocks and SODAX does the swap: H10X Wallet is not a broker and charges no fee.",
        )}
      </P>
      <Button title={t("Condiciones de las acciones", "Stock conditions")} kind="ghost" icon="info.circle.fill" onPress={() => setTerms(true)} />

      {picker ? <StockPicker selected={stock.id} held={tokens.pocket} onClose={() => setPicker(false)} onPick={(s) => {
            setPicker(false);
            setStock(s);
            reset();
          }} /> : null}
      {terms ? (
        <StockTerms
          accepted={prefs.stocks}
          onClose={() => setTerms(false)}
          onAccept={(c) => void setPrefs({ stocks: c }).then(() => setTerms(false))}
          onWithdraw={() => void setPrefs({ stocks: null }).then(() => setTerms(false))}
        />
      ) : null}
      {done ? <SwapDone title={t("Orden hecha", "Order done")} text={done.text} toVault={done.toVault} txId={done.txId} onClose={() => setDone(null)} onDeposit={onDeposit} /> : null}
    </>
  );
}

/** Selector de acciones: buscador y la lista revisada, con lo que ya tienes. */
function StockPicker({ selected, held, onClose, onPick }: { selected: string; held: { tokenId: string; balance: bigint }[]; onClose: () => void; onPick: (s: StockEntry) => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const rows = useMemo(() => STOCK_TOKENS.filter((s) => !query || `${s.symbol} ${s.name} ${s.id}`.toLowerCase().includes(query)), [query]);
  const bal = (id: string) => held.find((x) => x.tokenId === id)?.balance ?? 0n;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Backdrop>
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{t("Acciones", "Stocks")}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
              <Text style={styles.sheetClose}>{t("Cerrar", "Close")}</Text>
            </Pressable>
          </View>
          <View style={styles.search}>
            <TextInput value={q} onChangeText={setQ} placeholder={t("Buscar (Apple, TSLA…)", "Search (Apple, TSLA…)")} placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={styles.searchInput} />
          </View>
          <ScrollView contentContainerStyle={{ padding: space.l, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
            <Group>
              {rows.map((s) => (
                <Pressable key={s.id} onPress={() => onPick(s)} accessibilityRole="button" style={({ pressed }) => [styles.tokenRow, pressed ? styles.pressed : null]}>
                  <TokenLogo id={s.id} symbol={s.symbol} size={36} ring={s.id === selected ? colors.brass : undefined} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{s.symbol}</Text>
                    <Text style={styles.rowSub}>{`${s.name} · ${s.id}`}</Text>
                  </View>
                  {bal(s.id) > 0n ? <Text style={styles.rowValue}>{formatUnits(bal(s.id), 8, 6)}</Text> : null}
                  <Icon name="checkmark.seal.fill" size={15} color={colors.brass} />
                </Pressable>
              ))}
            </Group>
            <P muted style={{ marginTop: space.l, fontSize: 13 }}>
              {t(
                "Revisadas por el equipo: las emite la tesorería de SODAX en Hedera, sin KYC, sin congelar, sin borrar y sin comisiones. La app lo vuelve a comprobar antes de cada cambio.",
                "Reviewed by the team: issued by SODAX's treasury on Hedera, with no KYC, freeze, wipe or fees. The app checks it again before every swap.",
              )}
            </P>
          </ScrollView>
        </SafeAreaView>
      </Backdrop>
    </Modal>
  );
}

/** Países para elegir (los bloqueados también están: así se explica por qué no se puede). */
const COUNTRIES: [string, string, string][] = [
  ["ES", "España", "Spain"],
  ["PT", "Portugal", "Portugal"],
  ["FR", "Francia", "France"],
  ["DE", "Alemania", "Germany"],
  ["IT", "Italia", "Italy"],
  ["NL", "Países Bajos", "Netherlands"],
  ["BE", "Bélgica", "Belgium"],
  ["LU", "Luxemburgo", "Luxembourg"],
  ["IE", "Irlanda", "Ireland"],
  ["AT", "Austria", "Austria"],
  ["CH", "Suiza", "Switzerland"],
  ["GB", "Reino Unido", "United Kingdom"],
  ["PL", "Polonia", "Poland"],
  ["SE", "Suecia", "Sweden"],
  ["DK", "Dinamarca", "Denmark"],
  ["FI", "Finlandia", "Finland"],
  ["NO", "Noruega", "Norway"],
  ["CZ", "Chequia", "Czechia"],
  ["GR", "Grecia", "Greece"],
  ["RO", "Rumanía", "Romania"],
  ["HU", "Hungría", "Hungary"],
  ["SK", "Eslovaquia", "Slovakia"],
  ["SI", "Eslovenia", "Slovenia"],
  ["HR", "Croacia", "Croatia"],
  ["BG", "Bulgaria", "Bulgaria"],
  ["LT", "Lituania", "Lithuania"],
  ["LV", "Letonia", "Latvia"],
  ["EE", "Estonia", "Estonia"],
  ["CY", "Chipre", "Cyprus"],
  ["MT", "Malta", "Malta"],
  ["AD", "Andorra", "Andorra"],
  ["MX", "México", "Mexico"],
  ["AR", "Argentina", "Argentina"],
  ["CO", "Colombia", "Colombia"],
  ["CL", "Chile", "Chile"],
  ["PE", "Perú", "Peru"],
  ["UY", "Uruguay", "Uruguay"],
  ["EC", "Ecuador", "Ecuador"],
  ["BR", "Brasil", "Brazil"],
  ["CA", "Canadá", "Canada"],
  ["US", "Estados Unidos", "United States"],
  ["PR", "Puerto Rico", "Puerto Rico"],
  ["RU", "Rusia", "Russia"],
];

/** Las condiciones de SODAX: país, persona de EE. UU. y aviso del emisor. */
function StockTerms({
  accepted,
  onClose,
  onAccept,
  onWithdraw,
}: {
  accepted?: { country: string } | null;
  onClose: () => void;
  onAccept: (c: { version: number; country: string; notUsPerson: boolean; readNotice: boolean; at: number }) => void;
  onWithdraw?: () => void;
}) {
  const [country, setCountry] = useState(accepted?.country ?? "");
  const [other, setOther] = useState("");
  const [notUs, setNotUs] = useState(!!accepted);
  const [read, setRead] = useState(!!accepted);
  const code = (other.trim() || country).toUpperCase();
  const blocked = /^[A-Z]{2}$/.test(code) && STOCK_ELIGIBILITY.blockedCountries.includes(code);
  const consent = { version: STOCK_ELIGIBILITY.version, country: code, notUsPerson: notUs, readNotice: read, at: Date.now() };
  const ok = stockEligibility(consent).ok;
  const notice = lang() === "en" ? STOCK_NOTICE.en : STOCK_NOTICE.es;
  const Check = ({ on, onPress, text }: { on: boolean; onPress: () => void; text: string }) => (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      style={styles.check}
    >
      {on ? <Icon name="checkmark.square.fill" size={22} color={colors.brass} /> : <View style={styles.box} />}
      <Text style={styles.checkText}>{text}</Text>
    </Pressable>
  );
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Backdrop>
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{t("Antes de usar acciones", "Before using stocks")}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
              <Text style={styles.sheetClose}>{t("Cerrar", "Close")}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: space.l, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
            <Card>
              {notice.map((p, i) => (
                <P key={i} style={i === notice.length - 1 ? { marginBottom: 0 } : undefined}>
                  {p}
                </P>
              ))}
            </Card>
            <Text style={styles.section}>{t("Dónde vives", "Where you live")}</Text>
            <View style={styles.chips}>
              {COUNTRIES.map(([c, es, en]) => (
                <Pressable
                  key={c}
                  onPress={() => {
                    haptic.tap();
                    setCountry(c);
                    setOther("");
                  }}
                  accessibilityRole="button"
                  style={[styles.chip, code === c ? styles.chipOn : null]}
                >
                  <Text style={[styles.chipText, code === c ? { color: colors.text } : null]}>{lang() === "en" ? en : es}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={other}
              onChangeText={(v) => setOther(v.replace(/[^a-zA-Z]/g, "").slice(0, 2))}
              placeholder={t("¿Otro país? Su código de 2 letras (p. ej. JP)", "Another country? Its 2-letter code (e.g. JP)")}
              placeholderTextColor={colors.faint}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[styles.search, styles.searchInput, { marginHorizontal: 0 }]}
            />
            {blocked ? (
              <Card tone="warn" style={{ marginTop: space.m }}>
                <P style={{ marginBottom: 0 }}>{t("Las acciones no se ofrecen en tu país.", "Stocks aren't offered in your country.")}</P>
              </Card>
            ) : null}
            <View style={{ marginTop: space.l, gap: space.m }}>
              <Check on={notUs} onPress={() => setNotUs((v) => !v)} text={t("No soy ciudadano ni residente de EE. UU. (no soy «persona de EE. UU.»).", "I'm not a US citizen or resident (not a «US person»).")} />
              <Check on={read} onPress={() => setRead((v) => !v)} text={t("He leído el aviso: es un token que sigue el precio, no me hace accionista.", "I've read the notice: it's a token that tracks the price, it doesn't make me a shareholder.")} />
            </View>
            <Button title={t("Aceptar", "Accept")} disabled={!ok} onPress={() => onAccept(consent)} style={{ marginTop: space.xl }} />
            {accepted && onWithdraw ? <Button title={t("Quitar mi aceptación", "Withdraw my acceptance")} kind="ghost" onPress={onWithdraw} /> : null}
          </ScrollView>
        </SafeAreaView>
      </Backdrop>
    </Modal>
  );
}

const styles = StyleSheet.create({
  cards: { gap: space.s, marginBottom: space.m },
  flipDot: {
    alignSelf: "center",
    marginVertical: -space.l - 2,
    zIndex: 2,
    width: 40,
    height: 40,
    borderRadius: 20,
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  chipOn: { borderColor: colors.brass, backgroundColor: colors.surfaceStrong },
  chipText: { color: colors.muted, fontSize: 14 },
  check: { flexDirection: "row", alignItems: "flex-start", gap: space.m },
  box: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: colors.muted },
  checkText: { color: colors.text, fontSize: 15, flex: 1 },
});

