// Bóveda y Cartera, cada una en su pantalla: su saldo, su ID para copiar, sus acciones y la lista de lo que tiene con
// logos (como en HashPack). En la bóveda, además, el rendimiento, la protección y sus últimas operaciones.
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { formatDelay, formatHbar } from "@boveda/core";
import { Card, Chip, Group, Icon, IconButton, ListRow, P, Row, RoundAction, Screen, SectionTitle, TabBar, type Tab } from "../ui";
import { AssetRow, BalanceHero } from "../components/Assets";
import { colors, space } from "../theme";
import { useWallet } from "../wallet";
import { useHoldings, useMarket } from "../market";
import { MovementRow, type HomeAction } from "./Home";
import { t } from "../i18n";
import { haptic, useNow } from "../helpers";

export function AccountScreen({
  kind,
  onBack,
  go,
  onTab,
  onToken,
}: {
  kind: "vault" | "pocket";
  onBack: () => void;
  go: (a: HomeAction) => void;
  onTab: (t: Tab) => void;
  onToken: (id: string) => void;
}) {
  const { profile, pullRefresh, refreshing, isV2, staking, movements, locks } = useWallet();
  const { format } = useMarket();
  const h = useHoldings(kind);
  const now = useNow(5000);
  const [copied, setCopied] = useState(false);
  if (!profile?.vault) return null;
  const v = profile.vault;
  const isVault = kind === "vault";
  const accountId = (isVault ? v.accountId : profile.pocket.accountId) ?? "";
  const guardianActive = !!profile.guardian?.registered;
  const frozen = isV2 && locks.withdraw > now;
  const mine = new Set(profile.mySchedules);
  const earning = staking?.nodeId != null;
  const copy = () => {
    if (!accountId) return;
    void Clipboard.setStringAsync(accountId);
    haptic.success();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Screen
      heading={isVault ? t("Bóveda", "Vault") : t("Cartera", "Wallet")}
      onBack={onBack}
      right={
        isVault ? (
          <IconButton icon="clock.arrow.circlepath" label={t("Actividad", "Activity")} onPress={() => onTab("activity")} />
        ) : (
          <IconButton icon="qrcode" label={t("Recibir", "Receive")} onPress={() => go("receive")} />
        )
      }
      refreshing={refreshing}
      onRefresh={() => void pullRefresh()}
      footer={<TabBar current="home" onChange={onTab} />}
    >
      <BalanceHero
        center
        label={isVault ? t("En la bóveda", "In the vault") : t("En la Cartera", "In the Wallet")}
        value={h.total != null ? format(h.total) : `${formatHbar(h.hbar, 2)} HBAR`}
        change={h.total != null ? h.change : null}
      />
      <Row style={{ justifyContent: "center", marginTop: space.m, flexWrap: "wrap" }}>
        {accountId ? (
          <Chip
            text={copied ? t("Copiado", "Copied") : accountId}
            icon="doc.on.doc"
            onPress={copy}
            label={t(`Copiar el ID ${accountId}`, `Copy the ID ${accountId}`)}
          />
        ) : null}
        {isVault ? (
          <Chip
            text={frozen ? t("Retiradas congeladas", "Withdrawals frozen") : guardianActive ? t("Guardián activo", "Guardian active") : t("Sin guardián", "No guardian")}
            tone={frozen ? "warn" : guardianActive ? "accent" : "muted"}
          />
        ) : (
          <Chip text={t("Sin espera · solo en este móvil", "No wait · only on this phone")} />
        )}
      </Row>

      <Row gap={4} style={{ marginTop: space.xl, alignItems: "flex-start", paddingHorizontal: isVault ? space.xl : 0 }}>
        {isVault ? (
          <>
            <RoundAction primary icon="tray.and.arrow.down.fill" label={t("Guardar", "Store")} onPress={() => go("deposit")} />
            <RoundAction icon="tray.and.arrow.up.fill" label={t("Sacar", "Withdraw")} onPress={() => go("withdraw")} disabled={frozen} />
            <RoundAction icon="leaf.fill" label={t("Ganar", "Earn")} onPress={() => go("staking")} />
          </>
        ) : (
          <>
            <RoundAction icon="arrow.down.left" label={t("Recibir", "Receive")} onPress={() => go("receive")} />
            <RoundAction icon="arrow.up.right" label={t("Enviar", "Send")} onPress={() => go("send")} />
            <RoundAction icon="arrow.left.arrow.right" label={t("Cambiar", "Swap")} onPress={() => onTab("swap")} />
            <RoundAction primary icon="tray.and.arrow.down.fill" label={t("Guardar", "Store")} onPress={() => go("deposit")} />
          </>
        )}
      </Row>

      <SectionTitle right={<Text style={{ color: colors.muted, fontSize: 13 }}>{t("Por valor", "By value")}</Text>}>{t("Activos", "Assets")}</SectionTitle>
      <Group>
        {h.list.map((x) => (
          <AssetRow key={x.id} h={x} onPress={() => onToken(x.id)} />
        ))}
      </Group>

      {isVault ? (
        <>
          {isV2 ? (
            <Group style={{ marginTop: space.m }}>
              <ListRow
                icon="leaf.fill"
                iconColor={earning ? colors.safe : colors.brass}
                title={earning ? t(`Staking · nodo ${staking?.nodeId}`, `Staking · node ${staking?.nodeId}`) : t("Gana con tus HBAR", "Earn with your HBAR")}
                subtitle={
                  earning
                    ? t(`Pendiente de cobrar: ${formatHbar(staking?.pending ?? 0n, 4)} HBAR`, `Waiting to be collected: ${formatHbar(staking?.pending ?? 0n, 4)} HBAR`)
                    : t("Actívalo y tus HBAR de la bóveda generarán HBAR", "Turn it on and your vault HBAR will earn HBAR")
                }
                onPress={() => go("staking")}
              />
            </Group>
          ) : null}

          <SectionTitle>{t("Protección", "Protection")}</SectionTitle>
          <Group>
            <ListRow icon="timer" title={t("Retirada con el móvil", "Withdrawal with the phone")} value={formatDelay(v.delaySeconds)} />
            {isV2 ? <ListRow icon="key.fill" iconColor={colors.warn} title={t("Recuperación con el kit", "Recovery with the kit")} value={formatDelay(v.recoveryDelaySeconds ?? 0)} /> : null}
            <ListRow
              icon="checkmark.shield.fill"
              iconColor={guardianActive ? colors.safe : colors.muted}
              title={t("Guardián", "Guardian")}
              subtitle={guardianActive ? t("Completa a su hora y vigila tu kit", "Completes on time and watches your kit") : t("Sin él, completas tú al abrir la app", "Without it, you complete when you open the app")}
              value={guardianActive ? t("Activo", "Active") : t("Sin conectar", "Not connected")}
              valueColor={guardianActive ? colors.safe : colors.muted}
              onPress={() => go("settings")}
            />
            <ListRow icon="lifepreserver.fill" iconColor={colors.danger} title={t("Evacuar a la Cartera", "Evacuate to the Wallet")} subtitle={t("Con el móvil y el kit, al momento", "With the phone and the kit, instantly")} onPress={() => go("evacuate")} />
          </Group>

          <SectionTitle
            right={
              movements.length > 3 ? (
                <Pressable onPress={() => onTab("activity")} hitSlop={10}>
                  <Text style={{ color: colors.link, fontSize: 15 }}>{t("Ver todo", "See all")}</Text>
                </Pressable>
              ) : undefined
            }
          >
            {t("Últimas operaciones", "Latest operations")}
          </SectionTitle>
          {movements.length === 0 ? (
            <P muted>{t("Cuando saques dinero de la bóveda, aparecerá aquí con su cuenta atrás.", "When you take money out of the vault, it will show up here with its countdown.")}</P>
          ) : (
            <Group>
              {movements.slice(0, 3).map((m) => (
                <MovementRow key={m.scheduleId} m={m} mine={mine.has(m.scheduleId)} now={now} guardianActive={guardianActive} />
              ))}
            </Group>
          )}
        </>
      ) : (
        <Card tone="accent" style={{ marginTop: space.m }}>
          <Row gap={space.m} style={{ alignItems: "flex-start" }}>
            <View style={{ paddingTop: 1 }}>
              <Icon name="checkmark.shield.fill" size={20} color={colors.safe} />
            </View>
            <P style={{ flex: 1, marginBottom: 0, fontSize: 14, lineHeight: 20 }}>
              {t(
                "Lo que no uses a diario, guárdalo en la bóveda: tiene espera para sacar y se recupera con tu kit. La Cartera no: su llave solo está en este móvil.",
                "What you don't use every day, store it in the vault: it has a wait to take out and can be recovered with your kit. The Wallet can't: its key lives only on this phone.",
              )}
            </P>
          </Row>
        </Card>
      )}
    </Screen>
  );
}
