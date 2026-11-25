// NFT: los de la bóveda (protegidos con la misma cuenta atrás que el dinero) y los de la Cartera.
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { hasLink, hideLinks, fetchNftMetadata, formatDelay, hostOfUrl, isValidDestination, nftMetadataSource, type NftMetadata } from "@boveda/core";
import { Badge, Button, Card, Field, H2, Icon, P, Screen, Segmented } from "../ui";
import { colors, radius, space } from "../theme";
import { useWallet, type NftItem } from "../wallet";
import { t } from "../i18n";
import { confirm, haptic, run } from "../helpers";

export type NftPlace = "vault" | "pocket";

/**
 * Metadata de cada NFT, leída una sola vez por sesión. Si está en un servidor de terceros (no IPFS ni
 * Arweave), solo se pide cuando lo decides tú: ese servidor vería tu dirección IP.
 */
const cache = new Map<string, Promise<NftMetadata | null>>();
const allowed = new Set<string>();
const keyOf = (n: { tokenId: string; serial: number }) => `${n.tokenId}#${n.serial}`;
function useNftMeta(item: NftItem, allowExternal = false, attempt = 0) {
  const [meta, setMeta] = useState<NftMetadata | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const ext = allowExternal || allowed.has(keyOf(item));
    const k = `${keyOf(item)}${ext ? "+ext" : ""}`;
    if (attempt > 0) setMeta(undefined);
    // Un fallo no se recuerda: la próxima vez que se vea el NFT (o con «Reintentar») se vuelve a pedir.
    if (!cache.has(k)) {
      cache.set(
        k,
        fetchNftMetadata(item.metadata, { allowExternal: ext }).then((m) => {
          if (!m) cache.delete(k);
          return m;
        }),
      );
    }
    void cache.get(k)?.then((m) => alive && setMeta(m));
    return () => {
      alive = false;
    };
  }, [item, allowExternal, attempt]);
  return meta;
}

function NftImage({ uri, size }: { uri: string | null | undefined; size: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  if (!uri || failed) {
    return (
      <View style={[styles.placeholder, { width: size, height: size }]}>
        <Icon name="photo" size={size / 4} color={colors.faint} />
      </View>
    );
  }
  return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: radius.m }} contentFit="cover" transition={150} onError={() => setFailed(true)} />;
}

function NftCard({ item, size, onPress }: { item: NftItem; size: number; onPress: () => void }) {
  const { meta } = useWallet();
  const m = useNftMeta(item);
  const collection = hideLinks(meta(item.tokenId)?.name ?? item.tokenId);
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [{ width: size, opacity: pressed ? 0.8 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={`${m?.name ? hideLinks(m.name) : collection} #${item.serial}`}
    >
      <NftImage uri={m && !m.imageExternal ? m.image : null} size={size} />
      <Text style={styles.name} numberOfLines={1}>
        {m?.name ? hideLinks(m.name) : `${collection} #${item.serial}`}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {collection} · #{item.serial}
      </Text>
    </Pressable>
  );
}

export function NftHome({ footer, onOpen }: { footer: React.ReactNode; onOpen: (item: NftItem, where: NftPlace) => void }) {
  const { nfts, pullRefresh, refreshing, profile, isV2 } = useWallet();
  const [where, setWhere] = useState<NftPlace>("vault");
  const { width } = useWindowDimensions();
  const size = Math.floor((width - space.l * 2 - space.m) / 2);
  const list = nfts[where];
  const delay = profile?.vault?.delaySeconds ?? 0;
  return (
    <Screen title="NFT" footer={footer} refreshing={refreshing} onRefresh={() => void pullRefresh()}>
      <Segmented
        options={[
          { value: "vault", label: t(`Bóveda (${nfts.vault.length})`, `Vault (${nfts.vault.length})`) },
          { value: "pocket", label: t(`Cartera (${nfts.pocket.length})`, `Wallet (${nfts.pocket.length})`) },
        ]}
        value={where}
        onChange={setWhere}
      />
      <View style={{ height: space.m }} />
      {where === "vault" ? (
        <Card tone="brass">
          <P style={{ marginBottom: 0 }}>
            {isV2
              ? t(
                  `Aquí tus NFT tienen la misma protección que tu dinero: para sacarlos hay una cuenta atrás de ${formatDelay(delay)}, el guardián te avisa y puedes bloquearlo.`,
                  `Here your NFTs get the same protection as your money: taking them out has a ${formatDelay(delay)} countdown, the guardian alerts you and you can block it.`,
                )
              : t("Los NFT solo se pueden guardar en una bóveda v2.", "NFTs can only be stored in a v2 vault.")}
          </P>
        </Card>
      ) : (
        <Card>
          <P muted style={{ marginBottom: 0 }}>
            {t(
              "Los NFT de la Cartera se pueden usar en las dApps. Guárdalos en la bóveda para que nadie pueda llevárselos sin que lo veas.",
              "Wallet NFTs can be used in dApps. Store them in the vault so nobody can take them without you seeing.",
            )}
          </P>
        </Card>
      )}
      {list.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="photo.stack" size={36} color={colors.faint} />
          <P muted center>
            {where === "vault"
              ? t("Tu bóveda no tiene NFT. Ábrelos desde la Cartera y pulsa «Guardar en la bóveda».", "Your vault has no NFTs. Open them from the Wallet and tap “Store in the vault”.")
              : t("Tu Cartera no tiene NFT. Recíbelos en tu cuenta o cómpralos en una dApp.", "Your Wallet has no NFTs. Receive them on your account or buy them in a dApp.")}
          </P>
        </View>
      ) : (
        <View style={styles.grid}>
          {list.map((n) => (
            <NftCard key={keyOf(n)} item={n} size={size} onPress={() => onOpen(n, where)} />
          ))}
        </View>
      )}
    </Screen>
  );
}

export function NftDetail({ item, where, onBack }: { item: NftItem; where: NftPlace; onBack: () => void }) {
  const { meta, profile, depositNfts, withdrawNfts, sendNftsFromPocket, isV2 } = useWallet();
  const [loadExternal, setLoadExternal] = useState(() => allowed.has(keyOf(item)));
  const [showImage, setShowImage] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const m = useNftMeta(item, loadExternal, attempt);
  const source = nftMetadataSource(item.metadata);
  const imageHost = m?.imageExternal ? hostOfUrl(m.image) : null;
  const { width } = useWindowDimensions();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const collection = hideLinks(meta(item.tokenId)?.name ?? item.tokenId);
  const ref = [{ tokenId: item.tokenId, serial: item.serial }];
  const delay = profile?.vault?.delaySeconds ?? 0;
  const pocketId = profile?.pocket.accountId ?? "";
  const act = (what: string, fn: () => Promise<unknown>) =>
    void run(what, async () => {
      setBusy(what);
      try {
        await fn();
        haptic.success();
        onBack();
      } finally {
        setBusy(null);
      }
    });

  return (
    <Screen onBack={onBack}>
      <NftImage key={attempt} uri={m && (!m.imageExternal || showImage) ? m.image : null} size={width - space.l * 2} />
      {m === null && (!source?.external || loadExternal) ? (
        <Button title={t("No se han podido cargar los datos. Reintentar", "Couldn't load the data. Retry")} kind="ghost" icon="arrow.clockwise" style={{ marginTop: space.s }} onPress={() => setAttempt((a) => a + 1)} />
      ) : null}
      {m?.imageExternal && m.image && !showImage ? (
        <Button title={t(`Ver la imagen (de ${imageHost ?? "otro servidor"})`, `Show the image (from ${imageHost ?? "another server"})`)} kind="ghost" style={{ marginTop: space.s }} onPress={() => setShowImage(true)} />
      ) : null}
      {source?.external && !loadExternal ? (
        <Card style={{ marginTop: space.m }}>
          <P muted>
            {t(
              `Los datos de este NFT están en ${source.host ?? "otro servidor"}, no en IPFS. Si los cargas, ese servidor verá tu dirección IP.`,
              `This NFT's data is on ${source.host ?? "another server"}, not on IPFS. If you load it, that server will see your IP address.`,
            )}
          </P>
          <Button
            title={t("Cargar los datos", "Load the data")}
            kind="secondary"
            onPress={() => {
              allowed.add(keyOf(item));
              setLoadExternal(true);
            }}
          />
        </Card>
      ) : null}
      <View style={{ height: space.l }} />
      <H2 style={{ fontSize: 24 }}>{m?.name ? hideLinks(m.name) : `${collection} #${item.serial}`}</H2>
      <View style={{ flexDirection: "row", gap: space.s, marginBottom: space.m, flexWrap: "wrap" }}>
        <Badge text={`${collection}`} tone="muted" />
        <Badge text={`#${item.serial}`} tone="muted" />
        <Badge text={where === "vault" ? t("En la bóveda", "In the vault") : t("En la Cartera", "In the Wallet")} tone={where === "vault" ? "brass" : "blue"} />
      </View>
      {m?.description ? <P muted>{hideLinks(m.description)}</P> : null}
      {hasLink(m?.name) || hasLink(m?.description) || hasLink(meta(item.tokenId)?.name) ? (
        <P style={{ color: colors.danger }}>
          {t(
            "Este NFT trae una web (la hemos ocultado). Los NFT regalados con una web son la estafa más común en Hedera: no la busques, y nunca escribas tus 24 palabras en una web.",
            "This NFT carries a website (we've hidden it). Gifted NFTs with a website are the most common scam on Hedera: don't look it up, and never type your 24 words on a website.",
          )}
        </P>
      ) : null}
      <P muted style={{ fontSize: 13 }}>{t(`Colección ${item.tokenId}`, `Collection ${item.tokenId}`)}</P>

      {where === "pocket" ? (
        <>
          {isV2 ? (
            <Button
              title={t("Guardar en la bóveda", "Store in the vault")}
              icon="lock.shield.fill"
              busy={busy === "deposit"}
              disabled={!!busy}
              style={{ marginTop: space.m }}
              onPress={() => act("deposit", () => depositNfts(ref))}
            />
          ) : null}
          <Field label={t("Enviar a otra cuenta (0.0.x)", "Send to another account (0.0.x)")} value={to} onChangeText={setTo} placeholder="0.0.12345" />
          <Button
            title={t("Enviar", "Send")}
            kind="secondary"
            busy={busy === "send"}
            disabled={!!busy || !isValidDestination(to.trim())}
            onPress={async () => {
              if (await confirm(t("¿Enviar este NFT?", "Send this NFT?"), t(`Sale de tu Cartera a ${to.trim()} al momento.`, `It leaves your Wallet to ${to.trim()} instantly.`), t("Enviar", "Send"))) {
                act("send", () => sendNftsFromPocket(to.trim(), ref));
              }
            }}
          />
        </>
      ) : (
        <>
          <Card style={{ marginTop: space.m }}>
            <P muted style={{ marginBottom: 0 }}>
              {t(
                `Al sacarlo empieza una cuenta atrás de ${formatDelay(delay)}. Hasta que acabe puedes bloquearlo desde Actividad, y el guardián te avisa si no lo has pedido tú.`,
                `Taking it out starts a ${formatDelay(delay)} countdown. Until it ends you can block it from Activity, and the guardian alerts you if you didn't ask for it.`,
              )}
            </P>
          </Card>
          <Button
            title={t(`Sacar a mi Cartera (${formatDelay(delay)})`, `Take out to my Wallet (${formatDelay(delay)})`)}
            icon="tray.and.arrow.up"
            busy={busy === "withdraw"}
            disabled={!!busy || !pocketId}
            onPress={() => act("withdraw", () => withdrawNfts(pocketId, ref))}
          />
          <Field label={t("O sacarlo a otra cuenta (0.0.x)", "Or take it out to another account (0.0.x)")} value={to} onChangeText={setTo} placeholder="0.0.12345" />
          <Button
            title={t(`Sacar a esa cuenta (${formatDelay(delay)})`, `Take out to that account (${formatDelay(delay)})`)}
            kind="secondary"
            busy={busy === "withdrawTo"}
            disabled={!!busy || !isValidDestination(to.trim())}
            onPress={() => act("withdrawTo", () => withdrawNfts(to.trim(), ref))}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.m, marginTop: space.m },
  name: { color: colors.text, fontSize: 15, fontWeight: "600", marginTop: space.s },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  placeholder: { borderRadius: radius.m, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  empty: { alignItems: "center", gap: space.m, paddingVertical: space.xxl },
});
