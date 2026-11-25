import React, { useState } from "react";
import { formatCountdown, formatDelay } from "@boveda/core";
import { Badge, Button, Card, H2, P, Screen } from "../ui";
import { useWallet } from "../wallet";
import { t } from "../i18n";
import { confirm, run, useNow } from "../helpers";

/** Lo que puede quedar en la bóveda tras sacarlo todo (restos de comisiones): cuenta como vacía. */
const DUST = 5_000_000n;

/**
 * Kit nuevo cuando se ha perdido el papel. Las 24 palabras nunca se guardan en el móvil (móvil + kit sacan todo al
 * momento), así que no se pueden volver a enseñar: se saca todo a la Cartera con la cuenta atrás de siempre, se crea
 * la bóveda de nuevo con un kit nuevo y se vuelve a guardar. Sin operaciones nuevas en la bóveda: el guardián sigue
 * bloqueando cualquier cambio de llaves pedido solo con el móvil.
 */
export function NewKit({ onBack, onWithdraw }: { onBack: () => void; onWithdraw: () => void }) {
  const { profile, balances, tokens, nfts, movements, restartVault } = useWallet();
  const now = useNow(5000);
  const [busy, setBusy] = useState(false);
  if (!profile?.vault) return null;
  const v = profile.vault;
  const mine = new Set(profile.mySchedules);
  const pocketId = profile.pocket.accountId;
  const leftTokens = tokens.vault.filter((x) => x.balance > 0n).length;
  const leftNfts = nfts.vault.length;
  const empty = balances.vault != null && balances.vault <= DUST && leftTokens === 0 && leftNfts === 0;
  const coming = movements.filter(
    (m) => m.lane === "withdraw" && m.status === "requested" && !m.executed && !m.expired && mine.has(m.scheduleId) && m.action.kind === "transfer" && m.action.to === pocketId,
  );
  const next = coming.reduce((a, m) => Math.max(a, m.executableAt), 0);

  return (
    <Screen title={t("Hacer un kit nuevo", "Make a new kit")} onBack={onBack}>
      <Card tone="warn">
        <P>
          {t(
            "Para cuando has perdido el papel con las 24 palabras. Sin él, si pierdes el móvil no podrás recuperar la bóveda.",
            "For when you've lost the paper with the 24 words. Without it, if you lose your phone you can't recover the vault.",
          )}
        </P>
        <P muted style={{ marginBottom: 0 }}>
          {t(
            "Las palabras no se guardan en el móvil (móvil y kit juntos sacan todo al momento), así que no se pueden volver a ver. Si aún tienes el kit pero alguien lo ha visto, usa «Evacuar la bóveda»: es al momento.",
            "The words aren't kept on the phone (phone and kit together take everything instantly), so they can't be shown again. If you still have the kit but someone has seen it, use “Evacuate the vault”: it's instant.",
          )}
        </P>
      </Card>

      <Card>
        <H2>{t("1. Saca todo a la Cartera", "1. Move everything to the Wallet")}</H2>
        <P muted>
          {t(
            `Con «Sacar», como siempre: llega cuando acabe tu cuenta atrás (${formatDelay(v.delaySeconds)}). Si hay tokens o NFT, sácalos también.`,
            `With “Withdraw”, as usual: it arrives when your countdown ends (${formatDelay(v.delaySeconds)}). If there are tokens or NFTs, move them too.`,
          )}
        </P>
        {empty ? (
          <Badge text={t("Bóveda vacía", "Vault empty")} tone="accent" />
        ) : coming.length ? (
          <Badge text={next > now ? t(`En camino: llega en ${formatCountdown(next - now)}`, `On its way: arrives in ${formatCountdown(next - now)}`) : t("Llegando…", "Arriving…")} tone="warn" />
        ) : (
          <Button title={t("Sacar a la Cartera", "Withdraw to the Wallet")} kind="secondary" onPress={onWithdraw} />
        )}
        {!empty && (leftTokens > 0 || leftNfts > 0) ? (
          <P muted style={{ marginTop: 8, marginBottom: 0 }}>
            {t(`Quedan en la bóveda: ${leftTokens} token(s) y ${leftNfts} NFT.`, `Still in the vault: ${leftTokens} token(s) and ${leftNfts} NFT(s).`)}
          </P>
        ) : null}
      </Card>

      <Card>
        <H2>{t("2. Crea la bóveda de nuevo", "2. Create the vault again")}</H2>
        <P muted>
          {t(
            "Con un kit nuevo. Esta vez apunta las 24 palabras en papel. Cuesta las comisiones de crear la bóveda (las verás antes de confirmar); la Cartera no cambia.",
            "With a new kit. This time write the 24 words on paper. It costs the vault creation fees (you'll see them before confirming); the Wallet stays the same.",
          )}
        </P>
        <Button
          title={t("Crear la bóveda con un kit nuevo", "Create the vault with a new kit")}
          disabled={!empty}
          busy={busy}
          onPress={() =>
            void run("Error", async () => {
              const ok = await confirm(
                t("¿Crear la bóveda de nuevo?", "Create the vault again?"),
                t(
                  "Dejas esta bóveda (vacía) y su kit, y creas otra con un kit nuevo.",
                  "You leave this (empty) vault and its kit, and create another with a new kit.",
                ),
                t("Crear de nuevo", "Create again"),
              );
              if (!ok) return;
              setBusy(true);
              try {
                await restartVault({ lostKit: true });
              } finally {
                setBusy(false);
              }
            })
          }
        />
      </Card>

      <Card>
        <H2>{t("3. Vuelve a guardar", "3. Store it again")}</H2>
        <P muted style={{ marginBottom: 0 }}>
          {t(
            "Con «Guardar», del todo a la bóveda nueva. Mientras el dinero está en la Cartera solo lo protege el móvil: haz los pasos 2 y 3 seguidos.",
            "With “Store”, everything into the new vault. While the money is in the Wallet only the phone protects it: do steps 2 and 3 back to back.",
          )}
        </P>
      </Card>
    </Screen>
  );
}
