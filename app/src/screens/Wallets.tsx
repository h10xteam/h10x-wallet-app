// Varias wallets en el mismo móvil (0.10): la lista, abrir otra y añadir una nueva. Cada wallet tiene su Cartera, su
// bóveda, su notario y su kit, y el guardián vigila cada bóveda por separado.
import React, { useState } from "react";
import { MAX_WALLETS } from "@boveda/core";
import { Badge, Button, Card, Group, ListRow, P, Screen } from "../ui";
import { colors, space } from "../theme";
import { useWallets, type WalletSummary } from "../wallets";
import { t } from "../i18n";
import { haptic, run } from "../helpers";

const label = (w: WalletSummary, i: number) => w.name ?? t(`Wallet ${i + 1}`, `Wallet ${i + 1}`);

export function WalletsScreen({ onBack }: { onBack: () => void }) {
  const { wallets, active, canAdd, add, select, removeEmpty } = useWallets();
  const [busy, setBusy] = useState("");
  const act = (what: string, fn: () => Promise<void>) =>
    void run(t("No se pudo", "It didn't work"), async () => {
      setBusy(what);
      try {
        await fn();
        haptic.success();
      } finally {
        setBusy("");
      }
    });
  return (
    <Screen title={t("Tus wallets", "Your wallets")} onBack={onBack}>
      <P muted>
        {t(
          "Cada wallet tiene su Cartera, su bóveda, su notario y su kit de rescate. El guardián vigila cada bóveda por separado; al tocar uno de sus avisos se abre la wallet de esa bóveda.",
          "Each wallet has its own Wallet account, vault, notary and rescue kit. The guardian watches each vault separately; tapping one of its alerts opens that vault's wallet.",
        )}
      </P>
      <Group style={{ marginBottom: space.l }}>
        {wallets.map((w, i) => {
          const on = w.id === active;
          return (
            <ListRow
              key={w.id}
              icon={on ? "checkmark.circle.fill" : "wallet.pass.fill"}
              iconColor={on ? colors.safe : colors.muted}
              title={label(w, i)}
              subtitle={w.vaultId ? t(`Bóveda ${w.vaultId}`, `Vault ${w.vaultId}`) : w.empty ? t("Vacía: sin crear todavía", "Empty: not created yet") : t("Sin bóveda todavía", "No vault yet")}
              right={on ? <Badge text={t("Abierta", "Open")} tone="accent" /> : undefined}
              onPress={on ? undefined : () => act(w.id, () => select(w.id))}
            />
          );
        })}
      </Group>
      <Button
        title={t("Añadir una wallet", "Add a wallet")}
        icon="plus.circle.fill"
        disabled={!canAdd || !!busy}
        busy={busy === "add"}
        onPress={() => act("add", add)}
      />
      {!canAdd ? <P muted style={{ marginTop: space.s }}>{t(`Como mucho ${MAX_WALLETS} wallets en este móvil.`, `At most ${MAX_WALLETS} wallets on this phone.`)}</P> : null}
      {wallets.some((w) => w.empty && w.id !== active) ? (
        <Button
          title={t("Quitar las wallets vacías", "Remove empty wallets")}
          kind="ghost"
          style={{ marginTop: space.s }}
          onPress={() =>
            act("clean", async () => {
              for (const w of wallets) if (w.empty && w.id !== active) await removeEmpty(w.id);
            })
          }
        />
      ) : null}
      <Card style={{ marginTop: space.l }}>
        <P muted style={{ marginBottom: 0 }}>
          {t(
            "Una wallet nueva empieza de cero: su propia Cartera, que hay que cargar, y su propia bóveda con un kit nuevo. Para quitar una wallet con algo dentro, ábrela y bórrala desde sus Ajustes.",
            "A new wallet starts from scratch: its own Wallet account, which needs funding, and its own vault with a new kit. To remove a wallet with something in it, open it and delete it from its Settings.",
          )}
        </P>
      </Card>
    </Screen>
  );
}
