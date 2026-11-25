// Historial completo (0.10): todo lo que ha pasado en la Cartera y en la bóveda, no solo las operaciones con cuenta
// atrás. Envíos y recibos, lo que se guarda o se saca de la bóveda, cambios en SaucerSwap, NFT, staking, permisos y lo
// que se firmó para una dApp. Lo lee del mirror por páginas (core/src/activity.js lo cuenta en palabras).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { SymbolViewProps } from "expo-symbols";
import { Mirror, NETWORKS, SAUCERSWAP, activityHorizon, buildActivity, formatHbar, formatUnits, type ActivityItem, type ActivityKind, type DappLogEntry, type TokenInfo } from "@boveda/core";
import { Badge, Button, Group, Icon, P } from "./ui";
import { colors, space } from "./theme";
import { useWallet } from "./wallet";
import { NETWORK } from "./env";
import { t, when } from "./i18n";
import { open } from "./helpers";

const mirror = new Mirror(NETWORKS[NETWORK].mirror);
type SymbolName = SymbolViewProps["name"];
const PAGE = 25;

type Feed = { txs: any[]; next: string | null; done: boolean };
const EMPTY: Feed = { txs: [], next: null, done: true };

/** Contratos de SaucerSwap de esta red: una llamada a uno de ellos es un cambio (swap). */
const ROUTERS: string[] = (() => {
  const s = (SAUCERSWAP as Record<string, { routerV1: string; routerV2: string } | undefined>)[NETWORK];
  return s ? [s.routerV1, s.routerV2] : [];
})();

/** Icono de cada tipo de movimiento (todos con su equivalente de Android en ui.tsx: lo comprueba test/v010). */
export const KIND_ICON: Record<ActivityKind | "signature", SymbolName> = {
  sent: "arrow.up.right",
  received: "arrow.down.left",
  deposit: "tray.and.arrow.down.fill",
  fromVault: "tray.and.arrow.up.fill",
  swap: "arrow.left.arrow.right",
  nftSent: "photo",
  nftReceived: "photo",
  reward: "leaf.fill",
  vaultOp: "lock.shield.fill",
  vaultCreated: "checkmark.shield.fill",
  allowance: "hand.raised.fill",
  associate: "link",
  contract: "signature",
  evm: "signature",
  message: "paperplane.fill",
  airdrop: "arrow.down.circle.fill",
  settings: "gearshape.fill",
  other: "circle.hexagongrid.fill",
  signature: "signature",
};

const kindTitle = (k: ActivityKind): string => {
  switch (k) {
    case "sent":
      return t("Enviado", "Sent");
    case "received":
      return t("Recibido", "Received");
    case "deposit":
      return t("Guardado en la bóveda", "Stored in the vault");
    case "fromVault":
      return t("Sacado de la bóveda", "Taken out of the vault");
    case "swap":
      return t("Cambio", "Swap");
    case "nftSent":
      return t("NFT enviado", "NFT sent");
    case "nftReceived":
      return t("NFT recibido", "NFT received");
    case "reward":
      return t("Recompensa de staking", "Staking reward");
    case "vaultOp":
      return t("Operación de la bóveda", "Vault operation");
    case "vaultCreated":
      return t("Bóveda creada", "Vault created");
    case "allowance":
      return t("Permiso de gasto", "Spending allowance");
    case "associate":
      return t("Token activado", "Token enabled");
    case "contract":
      return t("Llamada a un contrato", "Contract call");
    case "evm":
      return t("Transacción EVM", "EVM transaction");
    case "message":
      return t("Mensaje", "Message");
    case "airdrop":
      return t("Airdrop", "Airdrop");
    case "settings":
      return t("Ajustes de la cuenta", "Account settings");
    default:
      return t("Otra operación", "Other operation");
  }
};

type Row = { type: "tx"; key: string; at: number; item: ActivityItem } | { type: "sig"; key: string; at: number; entry: DappLogEntry };

/**
 * Lee el historial de la Cartera y de la bóveda por páginas, y lo junta. Solo enseña hasta donde se ha leído en las dos
 * (así no hay huecos); «Cargar más» pide la página siguiente.
 */
export function useHistory() {
  const { profile, dappLog, meta } = useWallet();
  const pocketId = profile?.pocket.accountId ?? null;
  const vaultId = profile?.vault?.accountId ?? null;
  const notaryId = profile?.vault?.notaryId ?? null;
  const [feeds, setFeeds] = useState<{ pocket: Feed; vault: Feed } | null>(null);
  const [log, setLog] = useState<DappLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [extraMeta, setExtraMeta] = useState<Record<string, TokenInfo>>({});
  const run = useRef(0);

  const page = useCallback(async (accountId: string | null, prev: Feed | null): Promise<Feed> => {
    if (!accountId) return EMPTY;
    if (prev && (prev.done || !prev.next)) return prev;
    const r = await mirror.accountTransactions(accountId, { next: prev?.next ?? null, limit: PAGE });
    return { txs: [...(prev?.txs ?? []), ...r.transactions], next: r.next, done: !r.next };
  }, []);

  const reload = useCallback(async () => {
    const mine = ++run.current;
    setBusy(true);
    try {
      const [pocket, vault, entries] = await Promise.all([page(pocketId, null), page(vaultId, null), dappLog()]);
      if (mine !== run.current) return;
      setFeeds({ pocket, vault });
      setLog(entries);
      setFailed(false);
    } catch {
      if (mine === run.current) setFailed(true);
    } finally {
      if (mine === run.current) setBusy(false);
    }
  }, [page, pocketId, vaultId, dappLog]);

  const loadMore = useCallback(async () => {
    if (!feeds || busy) return;
    const mine = ++run.current;
    setBusy(true);
    try {
      const [pocket, vault] = await Promise.all([page(pocketId, feeds.pocket), page(vaultId, feeds.vault)]);
      if (mine === run.current) setFeeds({ pocket, vault });
    } catch {
      if (mine === run.current) setFailed(true);
    } finally {
      if (mine === run.current) setBusy(false);
    }
  }, [feeds, busy, page, pocketId, vaultId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = useMemo<Row[]>(() => {
    if (!feeds || !pocketId) return [];
    const items = buildActivity({
      pocket: feeds.pocket.txs,
      vault: feeds.vault.txs,
      accounts: { pocket: pocketId, vault: vaultId, notary: notaryId, routers: ROUTERS },
      dapps: new Map(log.filter((e) => e.txId).map((e) => [e.txId as string, e.dapp])),
    });
    const horizon = activityHorizon([
      { items: feeds.pocket.txs, done: feeds.pocket.done },
      { items: feeds.vault.txs, done: feeds.vault.done },
    ]);
    const shown = horizon ? items.filter((i) => i.consensus >= horizon) : items;
    const oldest = shown.length ? shown[shown.length - 1].at : 0;
    const allDone = feeds.pocket.done && feeds.vault.done;
    // Lo firmado para una dApp sin transacción en la red (un mensaje, o una que la dApp no llegó a mandar).
    const seen = new Set(items.map((i) => i.txId));
    const sigs = log.filter((e) => !(e.txId && seen.has(e.txId)) && (allDone || e.at >= oldest));
    const out: Row[] = [
      ...shown.map((item) => ({ type: "tx" as const, key: item.id, at: item.at, item })),
      ...sigs.map((entry, i) => ({ type: "sig" as const, key: `sig-${entry.at}-${i}`, at: entry.at, entry })),
    ];
    return out.sort((a, b) => b.at - a.at);
  }, [feeds, log, pocketId, vaultId, notaryId]);

  // Nombres y decimales de los tokens que salen y que la wallet no tiene ya (se piden una vez cada uno).
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    const missing = new Set<string>();
    for (const r of rows) if (r.type === "tx") for (const x of r.item.tokens) if (!meta(x.tokenId) && !extraMeta[x.tokenId] && !asked.current.has(x.tokenId)) missing.add(x.tokenId);
    if (missing.size === 0) return;
    const batch = [...missing].slice(0, 20);
    for (const id of batch) asked.current.add(id);
    void (async () => {
      const found: Record<string, TokenInfo> = {};
      for (const id of batch) {
        const info = await mirror.tokenInfo(id).catch(() => null);
        if (info) found[id] = info;
      }
      if (mounted.current && Object.keys(found).length) setExtraMeta((m) => ({ ...m, ...found }));
    })();
  }, [rows, meta, extraMeta]);

  const tokenMeta = useCallback((id: string) => meta(id) ?? extraMeta[id], [meta, extraMeta]);
  const more = !!feeds && !(feeds.pocket.done && feeds.vault.done);
  return { rows, loading: !feeds && busy, busy, failed, more, loadMore, reload, tokenMeta };
}

/** Una línea del historial: qué fue, con quién, cuándo y cuánto. Al tocarla, se abre en HashScan. */
function HistoryRow({ row, tokenMeta }: { row: Row; tokenMeta: (id: string) => TokenInfo | undefined }) {
  if (row.type === "sig") {
    const e = row.entry;
    return (
      <View style={{ padding: space.l, flexDirection: "row", gap: space.m, alignItems: "center" }}>
        <RowIcon name={KIND_ICON.signature} tint={colors.link} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: 15.5, fontWeight: "600" }}>{e.method === "hedera_signMessage" ? t(`Mensaje firmado para ${e.dapp}`, `Message signed for ${e.dapp}`) : t(`Firmado para ${e.dapp}`, `Signed for ${e.dapp}`)}</Text>
          <Text style={{ color: colors.muted, fontSize: 12.5, marginTop: 2 }}>{when(e.at)}</Text>
        </View>
      </View>
    );
  }
  const it = row.item;
  const amounts: { text: string; plus: boolean }[] = [];
  if (it.hbar !== 0n) amounts.push({ text: `${it.hbar > 0n ? "+" : "−"}${formatHbar(it.hbar < 0n ? -it.hbar : it.hbar)} HBAR`, plus: it.hbar > 0n });
  for (const x of it.tokens) {
    const m = tokenMeta(x.tokenId);
    const abs = x.amount < 0n ? -x.amount : x.amount;
    amounts.push({ text: `${x.amount > 0n ? "+" : "−"}${m ? formatUnits(abs, m.decimals) : abs.toString()} ${m?.symbol ?? x.tokenId}`, plus: x.amount > 0n });
  }
  if (it.nftsIn.length) amounts.push({ text: `+${it.nftsIn.length} NFT`, plus: true });
  if (it.nftsOut.length) amounts.push({ text: `−${it.nftsOut.length} NFT`, plus: false });
  if (it.reward > 0n && it.kind !== "reward") amounts.push({ text: t(`+${formatHbar(it.reward)} HBAR de staking`, `+${formatHbar(it.reward)} HBAR staking`), plus: true });
  if (it.kind === "reward") amounts.push({ text: `+${formatHbar(it.reward)} HBAR`, plus: true });
  const where = it.where === "both" ? t("Cartera y bóveda", "Wallet and vault") : it.where === "vault" ? t("Bóveda", "Vault") : t("Cartera", "Wallet");
  const who =
    it.counterparty && (it.kind === "sent" || it.kind === "nftSent")
      ? t(`a ${it.counterparty}`, `to ${it.counterparty}`)
      : it.counterparty && (it.kind === "received" || it.kind === "nftReceived" || it.kind === "airdrop")
        ? t(`de ${it.counterparty}`, `from ${it.counterparty}`)
        : it.contract && it.kind !== "swap" && it.kind !== "vaultOp"
          ? it.contract
          : "";
  const detail = [where, who, it.via ? t(`vía ${it.via}`, `via ${it.via}`) : "", when(it.at)].filter(Boolean).join(" · ");
  const tint = !it.ok ? colors.danger : it.kind === "deposit" || it.kind === "vaultCreated" || it.kind === "reward" ? colors.safe : it.kind === "received" || it.kind === "nftReceived" ? colors.accent : colors.brass;
  const link = `${NETWORKS[NETWORK].hashscan}/transaction/${it.consensus}`;
  return (
    <Pressable
      onPress={NETWORKS[NETWORK].hashscan ? () => open(link) : undefined}
      accessibilityRole="button"
      accessibilityLabel={`${kindTitle(it.kind)} · ${detail}`}
      style={({ pressed }) => ({ padding: space.l, flexDirection: "row", gap: space.m, alignItems: "flex-start", opacity: pressed ? 0.8 : 1 })}
    >
      <RowIcon name={KIND_ICON[it.kind]} tint={tint} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15.5, fontWeight: "600" }}>{kindTitle(it.kind)}</Text>
        <Text style={{ color: colors.muted, fontSize: 12.5, marginTop: 2 }}>{detail}</Text>
        {it.memo ? (
          <Text style={{ color: colors.faint, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
            {it.memo}
          </Text>
        ) : null}
        {!it.ok ? <Badge text={t(`Falló · ${it.result}`, `Failed · ${it.result}`)} tone="danger" /> : null}
      </View>
      <View style={{ alignItems: "flex-end", maxWidth: "45%" }}>
        {amounts.map((a, i) => (
          <Text key={i} style={{ color: !it.ok ? colors.muted : a.plus ? colors.safe : colors.text, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
            {a.text}
          </Text>
        ))}
        {it.fee > 0n ? <Text style={{ color: colors.faint, fontSize: 11.5, marginTop: 2 }}>{t(`comisión ${formatHbar(it.fee)}`, `fee ${formatHbar(it.fee)}`)}</Text> : null}
      </View>
    </Pressable>
  );
}

function RowIcon({ name, tint }: { name: SymbolName; tint: string }) {
  return (
    <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: `${tint}22`, alignItems: "center", justifyContent: "center" }}>
      <Icon name={name} size={15} color={tint} weight="bold" />
    </View>
  );
}

/** El historial completo, con «Cargar más». */
export function HistoryList({ history }: { history: ReturnType<typeof useHistory> }) {
  const { rows, loading, busy, failed, more, loadMore, reload, tokenMeta } = history;
  if (loading) return <P muted>{t("Cargando el historial…", "Loading the history…")}</P>;
  if (failed && rows.length === 0) {
    return (
      <>
        <P muted>{t("No se ha podido leer el historial. Comprueba la conexión.", "Couldn't read the history. Check the connection.")}</P>
        <Button title={t("Reintentar", "Try again")} kind="secondary" onPress={() => void reload()} />
      </>
    );
  }
  if (rows.length === 0) {
    return (
      <View style={{ alignItems: "center", paddingVertical: space.xxl, gap: space.m }}>
        <Icon name="clock.arrow.circlepath" size={40} color={colors.faint} />
        <P muted center>
          {t("Aún no hay movimientos. Cuando recibas, envíes o guardes algo, aparecerá aquí.", "No movements yet. When you receive, send or store something, it will show up here.")}
        </P>
      </View>
    );
  }
  return (
    <>
      <Group>
        {rows.map((r) => (
          <HistoryRow key={r.key} row={r} tokenMeta={tokenMeta} />
        ))}
      </Group>
      {more ? <Button title={t("Cargar más", "Load more")} kind="secondary" busy={busy} style={{ marginTop: space.m }} onPress={() => void loadMore()} /> : null}
    </>
  );
}
