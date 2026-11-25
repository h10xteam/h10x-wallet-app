import React, { useCallback, useEffect, useState } from "react";
import { Alert, Switch, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { HBAR, formatDelay, formatHbar, formatUnits, hideLinks, isValidDestination, parseUnits, vaultRoom, type Allowance } from "@boveda/core";
import { AssetPicker, Big, Button, Card, Choice, Field, Group, H2, ListRow, Mono, P, Row, Screen, SectionTitle, Segmented, Steps, WordsField, type AssetOption } from "../ui";
import { colors, space } from "../theme";
import { HBAR_ASSET, useWallet, type EvacuateResult, type RecoverResult } from "../wallet";
import { usePrefs } from "../prefs";
import { usePrices } from "../prices";
import { useGuardianStatus } from "../guardianStatus";
import { NETWORK } from "../env";
import { t, when } from "../i18n";
import { authenticate, canLock } from "../LockGate";
import { accountLink, confirm, haptic, open, run, txLink, useNow, useProtectSecrets } from "../helpers";
import { DEFAULT_DELAYS, DelayPicker, PasswordSetup, delaysOf, newPasswordPlan, passwordReady, type Delays, type PasswordPlan } from "./Onboarding";

const wordCount = (w: string) => (w.trim() ? w.trim().split(/\s+/).length : 0);
const wordsLabel = (w: string) => t(`Las 24 palabras (${wordCount(w)}/24)`, `The 24 words (${wordCount(w)}/24)`);
const WORDS_PLACEHOLDER = () => t("palabra1 palabra2 …", "word1 word2 …");
const DEST_PLACEHOLDER = () => t("0.0.1234 o 0x…", "0.0.1234 or 0x…");

function done(title: string, message: string, txId?: string) {
  haptic.success();
  Alert.alert(title, message, txId ? [{ text: t("Ver en HashScan", "View on HashScan"), onPress: () => open(txLink(txId)) }, { text: "OK" }] : [{ text: "OK" }]);
}

/** Activos de la cartera o de la bóveda, para el selector y para validar importes. */
function useAssets(where: "pocket" | "vault") {
  const { balances, tokens } = useWallet();
  const hbar = (where === "pocket" ? balances.pocket : balances.vault) ?? 0n;
  const list = (where === "pocket" ? tokens.pocket : tokens.vault).filter((x) => x.balance > 0n);
  const options: AssetOption[] = [{ id: HBAR_ASSET, symbol: "HBAR", balance: formatHbar(hbar, 2) }, ...list.map((x) => ({ id: x.tokenId, symbol: x.symbol, balance: formatUnits(x.balance, x.decimals, 2) }))];
  const info = (id: string) => {
    if (id === HBAR_ASSET) return { symbol: "HBAR", decimals: 8, balance: hbar, tokenId: undefined as string | undefined };
    const x = list.find((y) => y.tokenId === id);
    return { symbol: x?.symbol ?? "?", decimals: x?.decimals ?? 0, balance: x?.balance ?? 0n, tokenId: id as string | undefined };
  };
  return { options, info, hbar };
}

/** Línea de la comisión del servicio (solo si está activada). */
function FeeLine({ tinybars, when: moment }: { tinybars: bigint; when: "deposit" | "withdraw" }) {
  if (tinybars <= 0n) return null;
  return (
    <P muted style={{ marginBottom: space.l }}>
      {moment === "deposit"
        ? t(`Comisión del servicio: ${formatHbar(tinybars)} HBAR, en la misma operación.`, `Service fee: ${formatHbar(tinybars)} HBAR, in the same operation.`)
        : t(`Comisión del servicio: ${formatHbar(tinybars)} HBAR, solo si la retirada llega a salir.`, `Service fee: ${formatHbar(tinybars)} HBAR, only if the withdrawal actually goes out.`)}
    </P>
  );
}

export function Send({ onBack, initialAsset }: { onBack: () => void; initialAsset?: string }) {
  const { send } = useWallet();
  const { fiat } = usePrices();
  const assets = useAssets("pocket");
  const [asset, setAsset] = useState(initialAsset ?? HBAR_ASSET);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const a = assets.info(asset);
  const value = parseUnits(amount, a.decimals);
  const ok = isValidDestination(to) && value != null && value <= a.balance;
  const text = (v: bigint) => `${formatUnits(v, a.decimals, 8)} ${a.symbol}`;
  return (
    <Screen title={t("Enviar", "Send")} onBack={onBack}>
      <P muted>{t("Desde tu cartera. Sale al momento.", "From your wallet. It goes out instantly.")}</P>
      <AssetPicker options={assets.options} value={asset} onChange={(id) => (setAsset(id), setAmount(""))} />
      <Field label={t("Destino", "To")} placeholder={DEST_PLACEHOLDER()} value={to} onChangeText={setTo} />
      <Field
        label={t(`Importe (${a.symbol})`, `Amount (${a.symbol})`)}
        placeholder="0"
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
        hint={[t(`Disponible: ${text(a.balance)}`, `Available: ${text(a.balance)}`), value ? fiat(value, a.decimals, a.tokenId) : null].filter(Boolean).join("  ·  ")}
      />
      <Button
        title={t("Enviar", "Send")}
        disabled={!ok}
        busy={busy}
        onPress={() =>
          void run(t("No se pudo enviar", "Could not send"), async () => {
            if (!value || !(await confirm(t("¿Enviar?", "Send?"), t(`${text(value)} a ${to.trim()}`, `${text(value)} to ${to.trim()}`), t("Enviar", "Send")))) return;
            setBusy(true);
            try {
              const txId = await send(to, asset, value);
              done(t("Enviado", "Sent"), t(`${text(value)} a ${to.trim()}`, `${text(value)} to ${to.trim()}`), txId);
              onBack();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Screen>
  );
}

export function Deposit({ onBack, initialAsset }: { onBack: () => void; initialAsset?: string }) {
  const { deposit, fees, vaultTokensOn, isV2, balances } = useWallet();
  const { fiat } = usePrices();
  const { limits } = useGuardianStatus();
  const assets = useAssets("pocket");
  const [asset, setAsset] = useState(initialAsset ?? HBAR_ASSET);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const fee = fees?.deposit ?? 0n;
  const a = assets.info(asset);
  const value = parseUnits(amount, a.decimals);
  const isHbar = asset === HBAR_ASSET;
  const enough = value != null && (isHbar ? value + fee <= assets.hbar : value <= a.balance && fee <= assets.hbar);
  const tokensBlocked = !isHbar && (!isV2 || vaultTokensOn === false);
  // Beta: tope de HBAR por bóveda (lo publica el guardián; 0 = sin tope). Solo cuenta el HBAR.
  const room = isHbar ? vaultRoom(balances.vault, limits.maxVaultHbar) : null;
  const overCap = room != null && value != null && value > room;
  const ok = enough && !tokensBlocked && !overCap;
  const text = (v: bigint) => `${formatUnits(v, a.decimals, 8)} ${a.symbol}`;
  return (
    <Screen title={t("Guardar en la bóveda", "Store in the vault")} onBack={onBack}>
      <P muted>
        {t("Pasa HBAR o tokens de tu cartera a la bóveda. Entrar es inmediato; para sacarlos habrá cuenta atrás.", "Move HBAR or tokens from your wallet into the vault. Going in is instant; taking them out has a countdown.")}
      </P>
      <AssetPicker options={assets.options} value={asset} onChange={(id) => (setAsset(id), setAmount(""))} />
      {tokensBlocked ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>
            {isV2
              ? t("Tu bóveda todavía no acepta tokens. Actívalos desde la pantalla principal.", "Your vault does not accept tokens yet. Enable them from the home screen.")
              : t("La bóveda v1 solo guarda HBAR. Pásate a la v2 para guardar tokens.", "The v1 vault only holds HBAR. Upgrade to v2 to hold tokens.")}
          </P>
        </Card>
      ) : null}
      <Field
        label={t(`Importe (${a.symbol})`, `Amount (${a.symbol})`)}
        placeholder="0"
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
        hint={[t(`En la cartera: ${text(a.balance)}`, `In the wallet: ${text(a.balance)}`), value ? fiat(value, a.decimals, a.tokenId) : null].filter(Boolean).join("  ·  ")}
      />
      {room != null ? (
        <Card tone={overCap ? "warn" : undefined}>
          <P style={{ marginBottom: 0 }}>
            {t(
              `Durante la beta, cada bóveda guarda como mucho ${limits.maxVaultHbar} HBAR. Te caben ${formatHbar(room)} HBAR más.`,
              `During the beta, each vault holds at most ${limits.maxVaultHbar} HBAR. ${formatHbar(room)} more HBAR fit.`,
            )}
          </P>
        </Card>
      ) : null}
      <FeeLine tinybars={fee} when="deposit" />
      <Button
        title={t("Guardar", "Store")}
        disabled={!ok}
        busy={busy}
        onPress={() =>
          void run(t("No se pudo guardar", "Could not store"), async () => {
            if (!value) return;
            setBusy(true);
            try {
              const txId = await deposit(asset, value);
              done(t("Guardado", "Stored"), t(`${text(value)} están en tu bóveda.`, `${text(value)} are in your vault.`), txId);
              onBack();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Screen>
  );
}

export function Withdraw({ onBack, initialAsset }: { onBack: () => void; initialAsset?: string }) {
  const { withdraw, profile, isV2, locks, fees } = useWallet();
  const { fiat } = usePrices();
  const assets = useAssets("vault");
  const now = useNow();
  const [asset, setAsset] = useState(initialAsset ?? HBAR_ASSET);
  const [target, setTarget] = useState<"pocket" | "other">("pocket");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  if (!profile?.vault) return null;
  const fee = isV2 ? (fees?.withdraw ?? 0n) : 0n;
  const dest = target === "pocket" ? (profile.pocket.accountId ?? "") : to.trim();
  const a = assets.info(asset);
  const value = parseUnits(amount, a.decimals);
  const isHbar = asset === HBAR_ASSET;
  const frozen = isV2 && locks.withdraw > now;
  const enough = value != null && (isHbar ? value + fee <= assets.hbar : value <= a.balance && fee <= assets.hbar);
  const ok = !frozen && isValidDestination(dest) && enough;
  const delay = formatDelay(profile.vault.delaySeconds);
  const text = (v: bigint) => `${formatUnits(v, a.decimals, 8)} ${a.symbol}`;
  return (
    <Screen title={t("Sacar de la bóveda", "Withdraw from the vault")} onBack={onBack}>
      {frozen ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>
            {t(
              `Las retiradas están congeladas hasta ${when(locks.withdraw)}. Si necesitas el dinero ya, usa «Evacuar» en Ajustes con tu kit de rescate.`,
              `Withdrawals are frozen until ${when(locks.withdraw)}. If you need the money now, use "Evacuate" in Settings with your rescue kit.`,
            )}
          </P>
        </Card>
      ) : (
        <Card>
          <P>{t(`Saldrá dentro de ${delay}. Hasta entonces puedes bloquear la retirada desde la pantalla principal.`, `It goes out in ${delay}. Until then you can block the withdrawal from the home screen.`)}</P>
        </Card>
      )}
      {isV2 ? <AssetPicker options={assets.options} value={asset} onChange={(id) => (setAsset(id), setAmount(""))} /> : null}
      <Choice
        value={target}
        onChange={setTarget}
        options={[
          { value: "pocket", label: t("A mi cartera", "To my wallet"), detail: profile.pocket.accountId },
          { value: "other", label: t("A otra cuenta", "To another account") },
        ]}
      />
      {target === "other" ? <Field label={t("Destino", "To")} placeholder={DEST_PLACEHOLDER()} value={to} onChangeText={setTo} /> : null}
      <Field
        label={t(`Importe (${a.symbol})`, `Amount (${a.symbol})`)}
        placeholder="0"
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
        hint={[t(`En la bóveda: ${text(a.balance)}`, `In the vault: ${text(a.balance)}`), value ? fiat(value, a.decimals, a.tokenId) : null].filter(Boolean).join("  ·  ")}
      />
      <FeeLine tinybars={fee} when="withdraw" />
      <Button
        title={t(`Pedir retirada (${delay})`, `Request withdrawal (${delay})`)}
        disabled={!ok}
        busy={busy}
        onPress={() =>
          void run(t("No se pudo pedir la retirada", "Could not request the withdrawal"), async () => {
            if (!value || !(await confirm(t("¿Pedir la retirada?", "Request the withdrawal?"), t(`${text(value)} a ${dest}. Saldrá dentro de ${delay}.`, `${text(value)} to ${dest}. It goes out in ${delay}.`), t("Pedir", "Request")))) return;
            setBusy(true);
            try {
              await withdraw(dest, asset, value);
              done(t("Retirada pedida", "Withdrawal requested"), t(`Empieza la cuenta atrás de ${delay}. La verás en la pantalla principal.`, `The ${delay} countdown starts now. You'll see it on the home screen.`));
              onBack();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Screen>
  );
}

export function Receive({ onBack }: { onBack: () => void }) {
  const { profile, pocketTokensOn, addPocketToken } = useWallet();
  const [copied, setCopied] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [busy, setBusy] = useState(false);
  if (!profile) return null;
  const id = profile.pocket.accountId ?? "";
  const copy = (text: string, what: string) => {
    void Clipboard.setStringAsync(text);
    setCopied(what);
  };
  return (
    <Screen title={t("Recibir", "Receive")} onBack={onBack}>
      <Card>
        <View style={{ alignItems: "center", marginBottom: space.l }}>
          <View style={{ backgroundColor: "#fff", padding: space.m, borderRadius: 12 }}>
            <QRCode value={id || profile.pocket.evmAddress} size={180} />
          </View>
        </View>
        <P muted>{t("Cuenta", "Account")}</P>
        <Big>{id || "—"}</Big>
        <P muted>{t("Dirección EVM", "EVM address")}</P>
        <Mono>{profile.pocket.evmAddress}</Mono>
        <Row style={{ marginTop: space.s }}>
          <Button title={copied === "id" ? t("Copiada", "Copied") : t("Copiar cuenta", "Copy account")} kind="secondary" style={{ flex: 1 }} onPress={() => copy(id, "id")} />
          <Button title={copied === "evm" ? t("Copiada", "Copied") : t("Copiar 0x…", "Copy 0x…")} kind="secondary" style={{ flex: 1 }} onPress={() => copy(profile.pocket.evmAddress, "evm")} />
        </Row>
      </Card>
      <P muted>{t("Esto es tu cartera. Para proteger el dinero, luego pásalo a la bóveda.", "This is your wallet. To protect the money, move it to the vault afterwards.")}</P>
      <SectionTitle>Tokens</SectionTitle>
      {pocketTokensOn !== false ? (
        <P muted>{t("Tu cartera acepta cualquier token de Hedera automáticamente.", "Your wallet accepts any Hedera token automatically.")}</P>
      ) : (
        <>
          <P muted>{t("Para recibir un token nuevo, añádelo primero con su ID.", "To receive a new token, add it first with its ID.")}</P>
          <Field label={t("ID del token", "Token ID")} placeholder="0.0.1234" value={tokenId} onChangeText={setTokenId} />
          <Button
            title={t("Añadir token", "Add token")}
            kind="secondary"
            busy={busy}
            disabled={!/^0\.0\.\d+$/.test(tokenId.trim())}
            onPress={() =>
              void run(t("No se pudo añadir", "Could not add"), async () => {
                setBusy(true);
                try {
                  const info = await addPocketToken(tokenId);
                  done(t("Token añadido", "Token added"), t(`Ya puedes recibir ${info.symbol}.`, `You can now receive ${info.symbol}.`));
                  setTokenId("");
                } finally {
                  setBusy(false);
                }
              })
            }
          />
        </>
      )}
    </Screen>
  );
}

export function Rescue({ onBack }: { onBack: () => void }) {
  useProtectSecrets();
  const { rescue, profile, isV2 } = useWallet();
  const [words, setWords] = useState("");
  // Con una v2, esto sirve para rescatar una bóveda v1 anterior (p. ej. si el paso a la v2 se cortó).
  const legacy = profile?.legacyVaults?.at(-1);
  const [vaultId, setVaultId] = useState((isV2 ? legacy : profile?.vault?.accountId) ?? "");
  const [to, setTo] = useState((isV2 ? profile?.vault?.accountId : profile?.pocket.accountId) ?? "");
  const [busy, setBusy] = useState(false);
  const ok = wordCount(words) === 24 && /^0\.0\.\d+$/.test(vaultId.trim()) && isValidDestination(to);
  return (
    <Screen title={t("Rescatar la bóveda v1", "Rescue the v1 vault")} onBack={onBack}>
      <Card tone="warn">
        <P>{t("Saca todo el dinero de una bóveda v1 al momento, sin cuenta atrás, usando su kit de rescate.", "Takes all the money out of a v1 vault instantly, with no countdown, using its rescue kit.")}</P>
      </Card>
      <WordsField label={wordsLabel(words)} value={words} onChangeText={setWords} placeholder={WORDS_PLACEHOLDER()} />
      <Field label={t("Número de la bóveda", "Vault number")} value={vaultId} onChangeText={setVaultId} placeholder="0.0.1234" />
      <Field label={t("Enviar a", "Send to")} value={to} onChangeText={setTo} placeholder={DEST_PLACEHOLDER()} hint={t("Una cuenta tuya que no esté comprometida.", "An account of yours that isn't compromised.")} />
      <Button
        title={t("Rescatar ahora", "Rescue now")}
        kind="danger"
        disabled={!ok}
        busy={busy}
        onPress={() =>
          void run(t("No se pudo rescatar", "Could not rescue"), async () => {
            if (!(await confirm(t("¿Rescatar la bóveda?", "Rescue the vault?"), t(`Todo el saldo de ${vaultId.trim()} irá a ${to.trim()} al momento.`, `The whole balance of ${vaultId.trim()} goes to ${to.trim()} right now.`), t("Rescatar", "Rescue"), true))) return;
            setBusy(true);
            try {
              const out = await rescue({ words, vaultId, to });
              done(t("Bóveda rescatada", "Vault rescued"), t(`${formatHbar(out.tinybars)} HBAR enviados a ${to.trim()}.`, `${formatHbar(out.tinybars)} HBAR sent to ${to.trim()}.`), out.txId);
              onBack();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Screen>
  );
}

/** Preferencias de este iPhone: idioma, moneda y bloqueo con Face ID. */
function Preferences() {
  const { prefs, setPrefs } = usePrefs();
  const [busy, setBusy] = useState(false);
  const toggleLock = (on: boolean) =>
    void run(t("No se pudo cambiar el bloqueo", "Could not change the lock"), async () => {
      setBusy(true);
      try {
        if (on && !(await canLock())) {
          Alert.alert(t("Sin Face ID ni código", "No Face ID or passcode"), t("Configura Face ID o un código en los Ajustes del iPhone para poder bloquear la app.", "Set up Face ID or a passcode in the iPhone's Settings to lock the app."));
          return;
        }
        // Tanto para activarlo como para quitarlo hace falta tu cara (o el código).
        if (await authenticate(on ? t("Activar el bloqueo de H10X Wallet", "Turn on the H10X Wallet lock") : t("Quitar el bloqueo de H10X Wallet", "Turn off the H10X Wallet lock"))) {
          await setPrefs({ appLock: on });
          haptic.success();
        }
      } finally {
        setBusy(false);
      }
    });
  return (
    <>
      <SectionTitle>{t("Preferencias", "Preferences")}</SectionTitle>
      <Group>
        <ListRow
          icon="globe"
          iconColor={colors.link}
          title={t("Idioma", "Language")}
          right={
            <Segmented
              value={prefs.lang}
              onChange={(lang) => void setPrefs({ lang })}
              options={[
                { value: "auto", label: "Auto" },
                { value: "es", label: "ES" },
                { value: "en", label: "EN" },
              ]}
            />
          }
        />
        <ListRow
          icon="eurosign.circle"
          iconColor={colors.safe}
          title={t("Moneda", "Currency")}
          subtitle={NETWORK !== ("mainnet" as string) ? t("En testnet, valor de referencia con el precio real del HBAR.", "On testnet, a reference value using the real HBAR price.") : undefined}
          right={
            <Segmented
              value={prefs.currency}
              onChange={(currency) => void setPrefs({ currency })}
              options={[
                { value: "EUR", label: "€" },
                { value: "USD", label: "$" },
              ]}
            />
          }
        />
        <ListRow
          icon="faceid"
          iconColor={colors.brass}
          title={t("Bloquear con Face ID", "Lock with Face ID")}
          subtitle={t("Al abrir la app y al volver a ella.", "When opening the app and coming back to it.")}
          right={<Switch value={prefs.appLock} disabled={busy} onValueChange={toggleLock} trackColor={{ true: colors.brass, false: colors.surfaceStrong }} />}
        />
      </Group>
    </>
  );
}

export function Settings({
  onBack,
  onRescue,
  onEvacuate,
  onMigrate,
  onDelays,
  onStaking,
  onEmail,
  onAllowances,
  onAbout,
  onMoveHelp,
  onNewKit,
  onWallets,
  onFriends,
  footer,
}: {
  onBack?: () => void;
  onRescue: () => void;
  onEvacuate: () => void;
  onMigrate: () => void;
  onDelays: () => void;
  onStaking: () => void;
  onEmail: () => void;
  onAllowances: () => void;
  onAbout?: () => void;
  onMoveHelp?: () => void;
  onNewKit?: () => void;
  /** 0.10: la lista de wallets de este móvil. */
  onWallets?: () => void;
  /** DeRec: amigos de confianza (proteger la Cartera y ayudar a otros). */
  onFriends?: () => void;
  footer?: React.ReactNode;
}) {
  const { profile, registerGuardian, setH10xAlerts, wipe, isV2, fees, staking, renameWallet } = useWallet();
  const [busy, setBusy] = useState(false);
  const [alertBusy, setAlertBusy] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  if (!profile) return null;
  const h10xPrefs = profile.h10xAlerts ?? { dao: true, basket: true };
  const setAlert = (k: "dao" | "basket", on: boolean) =>
    void run(t("No se pudo cambiar el aviso", "Could not change the alert"), async () => {
      setAlertBusy(true);
      try {
        await setH10xAlerts({ ...h10xPrefs, [k]: on });
        haptic.success();
      } finally {
        setAlertBusy(false);
      }
    });
  const v = profile.vault;
  const guardianOn = !!profile.guardian?.registered;
  const connect = () =>
    void run(t("No se pudo conectar con el guardián", "Could not connect to the guardian"), async () => {
      setBusy(true);
      try {
        const msg = await registerGuardian();
        haptic.success();
        Alert.alert(t("Guardián", "Guardian"), msg);
      } finally {
        setBusy(false);
      }
    });
  return (
    <Screen title={t("Ajustes", "Settings")} onBack={onBack} footer={footer}>
      <Preferences />

      <SectionTitle>{t("Cuentas", "Accounts")}</SectionTitle>
      {naming != null ? (
        <Card>
          <Field label={t("Nombre de la wallet", "Wallet name")} placeholder={t("Mi wallet", "My wallet")} value={naming} onChangeText={setNaming} maxLength={32} autoCapitalize="sentences" autoFocus />
          <Row>
            <Button title={t("Cancelar", "Cancel")} kind="secondary" style={{ flex: 1 }} onPress={() => setNaming(null)} />
            <Button
              title={t("Guardar", "Save")}
              style={{ flex: 1 }}
              onPress={() =>
                void run(t("No se pudo guardar el nombre", "Could not save the name"), async () => {
                  await renameWallet(naming);
                  haptic.success();
                  setNaming(null);
                })
              }
            />
          </Row>
        </Card>
      ) : null}
      <Group>
        {onWallets ? <ListRow icon="rectangle.stack.fill" iconColor={colors.link} title={t("Tus wallets", "Your wallets")} subtitle={t("Cambiar de wallet o añadir otra", "Switch wallet or add another")} onPress={onWallets} /> : null}
        <ListRow icon="iphone" iconColor={colors.muted} title={t("Nombre", "Name")} value={profile.name ?? t("Sin nombre", "No name")} onPress={() => setNaming(profile.name ?? "")} />
        <ListRow icon="wallet.pass.fill" iconColor={colors.link} title={t("Cartera", "Wallet")} value={profile.pocket.accountId ?? "—"} onPress={profile.pocket.accountId ? () => open(accountLink(profile.pocket.accountId ?? "")) : undefined} />
        <ListRow icon="hand.raised.fill" iconColor={colors.warn} title={t("Permisos de gasto", "Spending allowances")} subtitle={t("Quién puede mover fondos de tu Cartera sin preguntarte", "Who can move funds from your Wallet without asking")} onPress={onAllowances} />
        {onFriends ? <ListRow icon="person.3.fill" iconColor={colors.safe} title={t("Amigos de confianza", "Trusted friends")} subtitle={t("Si pierdes el móvil, te devuelven la Cartera · DeRec", "If you lose your phone, they give your Wallet back · DeRec")} onPress={onFriends} /> : null}
        {v ? <ListRow icon="lock.shield.fill" title={t(`Bóveda v${isV2 ? 2 : 1}`, `Vault v${isV2 ? 2 : 1}`)} value={v.accountId} onPress={() => open(accountLink(v.accountId))} /> : null}
        {v ? <ListRow icon="signature" iconColor={colors.muted} title={t("Notario", "Notary")} value={v.notaryId} /> : null}
        {isV2 && v?.rescueAccountId ? <ListRow icon="key.fill" iconColor={colors.warn} title={t("Cuenta del kit", "Kit account")} value={v.rescueAccountId} /> : null}
        {(profile.legacyVaults ?? []).length ? <ListRow icon="archivebox" iconColor={colors.muted} title={t("Bóvedas anteriores", "Previous vaults")} value={(profile.legacyVaults ?? []).join(", ")} /> : null}
      </Group>

      {v ? (
        <>
          <SectionTitle>{t("Protección", "Protection")}</SectionTitle>
          <Group>
            <ListRow icon="timer" title={t("Retirada con el móvil", "Withdrawal with the phone")} value={formatDelay(v.delaySeconds)} onPress={isV2 ? onDelays : undefined} />
            {isV2 ? <ListRow icon="key.fill" iconColor={colors.warn} title={t("Recuperación con el kit", "Recovery with the kit")} value={formatDelay(v.recoveryDelaySeconds ?? 0)} onPress={onDelays} /> : null}
            {isV2 ? (
              <ListRow icon="envelope.fill" iconColor={colors.link} title={t("Avisos por correo", "Email alerts")} subtitle={t("Para cuando no tengas el móvil · con el kit", "For when you don't have your phone · with the kit")} onPress={onEmail} />
            ) : null}
            {isV2 ? (
              <ListRow icon="lock.shield.fill" iconColor={v.tiebreaker ? colors.safe : colors.warn} title={t("Contraseña de desempate", "Tiebreaker password")} value={v.tiebreaker ? t("Activada", "On") : t("Añadir", "Add")} onPress={onDelays} />
            ) : null}
            <ListRow icon="faceid" iconColor={colors.link} title={t("Llave de la cartera con Face ID", "Wallet key behind Face ID")} value={profile.biometric ? t("Sí", "Yes") : t("No en Expo Go", "Not in Expo Go")} />
          </Group>

          {isV2 ? (
            <>
              <SectionTitle>{t("Rendimiento", "Yield")}</SectionTitle>
              <Group>
                <ListRow
                  icon="leaf.fill"
                  iconColor={staking?.nodeId != null ? colors.safe : colors.muted}
                  title={t("Staking nativo de Hedera", "Hedera native staking")}
                  value={staking?.nodeId != null ? t(`Nodo ${staking.nodeId}`, `Node ${staking.nodeId}`) : t("Desactivado", "Off")}
                  onPress={onStaking}
                />
              </Group>
            </>
          ) : null}

          {fees && (fees.deposit > 0n || fees.withdraw > 0n) ? (
            <>
              <SectionTitle>{t("Comisiones del servicio", "Service fees")}</SectionTitle>
              <Group>
                <ListRow icon="tray.and.arrow.down" title={t("Al guardar en la bóveda", "When storing in the vault")} value={`${formatHbar(fees.deposit)} HBAR`} />
                <ListRow icon="tray.and.arrow.up" title={t("Al sacar de la bóveda", "When withdrawing from the vault")} subtitle={t("Solo si la retirada sale", "Only if the withdrawal goes out")} value={`${formatHbar(fees.withdraw)} HBAR`} />
              </Group>
              <P muted style={{ marginTop: space.s }}>{t("Nunca se cobran al recuperar con el kit ni al evacuar.", "Never charged when recovering with the kit or evacuating.")}</P>
            </>
          ) : null}

          <SectionTitle>{t("Guardián", "Guardian")}</SectionTitle>
          <Group>
            <ListRow
              icon="checkmark.shield.fill"
              iconColor={guardianOn ? colors.safe : colors.muted}
              title={guardianOn ? t("Activo", "Active") : t("Sin conectar", "Not connected")}
              subtitle={guardianOn ? t(`Cuenta ${profile.guardian?.account}`, `Account ${profile.guardian?.account}`) : t("Completa tus operaciones a su hora y te avisa", "Completes your operations on time and alerts you")}
            />
            <ListRow icon="bell.badge.fill" iconColor={colors.link} title={t("Avisos al móvil", "Phone alerts")} value={profile.guardian?.pushes ? t("Sí", "Yes") : "No"} />
          </Group>
          <Button
            title={guardianOn ? t("Volver a registrar en el guardián", "Register with the guardian again") : t("Conectar con el guardián", "Connect to the guardian")}
            kind="secondary"
            busy={busy}
            style={{ marginTop: space.m }}
            onPress={connect}
          />

          <SectionTitle>{t("Avisos de H10X", "H10X alerts")}</SectionTitle>
          <Group>
            <ListRow
              icon="person.3.fill"
              title={t("DAO de H10X", "H10X DAO")}
              subtitle={t("Ronda nueva, empieza la votación, últimas 24 h y resultado", "New round, voting starts, last 24 h and result")}
              right={<Switch value={h10xPrefs.dao} disabled={!guardianOn || alertBusy} onValueChange={(on) => setAlert("dao", on)} trackColor={{ true: colors.brass, false: colors.surfaceStrong }} />}
            />
            <ListRow
              icon="chart.line.uptrend.xyaxis"
              title={t("Cambios en la cesta", "Basket changes")}
              subtitle={t("Cuando un token entra o sale, o cambian los pesos", "When a token joins or leaves, or weights change")}
              right={<Switch value={h10xPrefs.basket} disabled={!guardianOn || alertBusy} onValueChange={(on) => setAlert("basket", on)} trackColor={{ true: colors.brass, false: colors.surfaceStrong }} />}
            />
          </Group>
          {!guardianOn ? <P muted style={{ fontSize: 13 }}>{t("Necesitan el guardián conectado.", "They need the guardian connected.")}</P> : null}

          <SectionTitle>{t("Emergencias", "Emergencies")}</SectionTitle>
          {isV2 ? (
            <Group>
              <ListRow icon="arrow.up.forward.app.fill" iconColor={colors.danger} title={t("Evacuar la bóveda", "Evacuate the vault")} subtitle={t("Con el móvil y el kit juntos, al momento", "With the phone and the kit together, instantly")} onPress={onEvacuate} />
              {onNewKit ? <ListRow icon="key.fill" iconColor={colors.warn} title={t("Hacer un kit nuevo", "Make a new kit")} subtitle={t("Si has perdido el papel con las 24 palabras", "If you've lost the paper with the 24 words")} onPress={onNewKit} /> : null}
              {(profile.legacyVaults ?? []).length ? <ListRow icon="lifepreserver" iconColor={colors.muted} title={t("Rescatar una bóveda anterior (v1)", "Rescue a previous vault (v1)")} onPress={onRescue} /> : null}
            </Group>
          ) : (
            <Group>
              <ListRow icon="arrow.triangle.2.circlepath" title={t("Pasar a la bóveda v2", "Upgrade to the v2 vault")} subtitle={t("Kit nuevo y más protección", "New kit and more protection")} onPress={onMigrate} />
              <ListRow icon="lifepreserver" iconColor={colors.danger} title={t("Rescatar la bóveda con el kit", "Rescue the vault with the kit")} onPress={onRescue} />
            </Group>
          )}
        </>
      ) : null}

      {isV2 ? <TheftModeCard /> : null}

      <SectionTitle>{t("Este móvil", "This phone")}</SectionTitle>
      <Group>
        {isV2 && onMoveHelp ? (
          <ListRow
            icon="iphone.and.arrow.forward"
            title={t("Pasar a otro móvil", "Move to another phone")}
            subtitle={t("La misma wallet en tu móvil nuevo, sin esperar ni crear otra", "The same wallet on your new phone, no waiting and nothing new")}
            onPress={onMoveHelp}
          />
        ) : null}
        <ListRow icon="network" iconColor={colors.muted} title={t("Red", "Network")} value={profile.network} />
        <ListRow
          icon="trash.fill"
          iconColor={colors.danger}
          title={t("Borrar la cartera de este móvil", "Delete the wallet from this phone")}
          onPress={() =>
            void run("Error", async () => {
              const sure = await confirm(
                t("¿Borrar la cartera de este móvil?", "Delete the wallet from this phone?"),
                isV2
                  ? t(
                      "Se borra la llave de este iPhone. El dinero de la bóveda solo podrás recuperarlo con tu kit de rescate (con su cuenta atrás), y el de la cartera se perderá.",
                      "This iPhone's key is deleted. You can only recover the vault's money with your rescue kit (with its countdown), and the wallet's money will be lost.",
                    )
                  : t(
                      "Se borra la llave de este iPhone. El dinero de la bóveda solo podrás recuperarlo con tu kit de rescate, y el de la cartera se perderá.",
                      "This iPhone's key is deleted. You can only recover the vault's money with your rescue kit, and the wallet's money will be lost.",
                    ),
                t("Borrar", "Delete"),
                true,
              );
              if (sure && (await confirm(t("¿Seguro?", "Are you sure?"), t("No se puede deshacer.", "This cannot be undone."), t("Sí, borrar", "Yes, delete"), true))) await wipe();
            })
          }
        />
      </Group>

      {onAbout ? (
        <>
          <SectionTitle>About</SectionTitle>
          <Group>
            <ListRow icon="info.circle.fill" iconColor={colors.link} title="About H10X Wallet" subtitle={t("La web de H10X y quién ha creado la app", "H10X's website and who made the app")} onPress={onAbout} />
          </Group>
        </>
      ) : null}
    </Screen>
  );
}

/**
 * Avisos por correo: si te roban el móvil, los avisos de la app le llegan a quien lo tenga. El correo solo
 * se pone, se cambia o se quita con las 24 palabras, así que quien tenga el móvil no puede quitártelo.
 */
export function EmailAlerts({ onBack }: { onBack: () => void }) {
  useProtectSecrets();
  const { emailStatus, emailStart, emailConfirm, emailRemove } = useWallet();
  const [status, setStatus] = useState<{ available: boolean; registered: boolean; email: string | null; pending: string | null } | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [words, setWords] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const load = React.useCallback(() => void emailStatus().then(setStatus), [emailStatus]);
  React.useEffect(load, [load]);
  const wordsOk = wordCount(words) === 24;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const act = (what: string, title: string, fn: () => Promise<void>) =>
    void run(title, async () => {
      setBusy(what);
      try {
        await fn();
        haptic.success();
      } finally {
        setBusy("");
      }
    });

  return (
    <Screen title={t("Avisos por correo", "Email alerts")} onBack={onBack}>
      <Card tone="brass">
        <P>
          {t(
            "Si te roban el móvil, los avisos de la app le llegan a quien lo tenga. Con un correo, también te llegan a ti: te escribimos solo si pasa algo importante (una retirada pedida, una operación bloqueada, el uso de tu kit, el modo robo o un cambio del móvil que recibe los avisos).",
            "If your phone is stolen, the app's alerts go to whoever has it. With an email they reach you too: we only write if something important happens (a withdrawal requested, a blocked operation, use of your kit, theft mode or a change of the phone that receives alerts).",
          )}
        </P>
        <P style={{ marginBottom: 0 }}>
          {t(
            "Se pone y se quita con tus 24 palabras: quien tenga tu móvil no puede quitártelo. Usa un correo que puedas abrir desde otro dispositivo.",
            "It's set and removed with your 24 words: whoever has your phone can't remove it. Use an email you can open from another device.",
          )}
        </P>
      </Card>

      {status === undefined ? (
        <P muted>{t("Consultando al guardián…", "Asking the guardian…")}</P>
      ) : status === null ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{t("No se ha podido hablar con el guardián. Prueba más tarde.", "Couldn't reach the guardian. Try again later.")}</P>
        </Card>
      ) : !status.registered ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{t("Primero conecta la bóveda con el guardián (Ajustes → Guardián).", "First connect the vault to the guardian (Settings → Guardian).")}</P>
        </Card>
      ) : !status.available && !status.email ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{t("Este guardián todavía no manda correos.", "This guardian doesn't send emails yet.")}</P>
        </Card>
      ) : (
        <>
          <Group>
            <ListRow icon="envelope.fill" iconColor={status.email ? colors.safe : colors.muted} title={t("Correo de avisos", "Alerts email")} value={status.email ?? t("Ninguno", "None")} />
          </Group>
          <View style={{ height: space.l }} />
          <WordsField label={wordsLabel(words)} value={words} onChangeText={setWords} placeholder={WORDS_PLACEHOLDER()} />
          {sentTo ? (
            <>
              <P>{t(`Te hemos mandado un código de 6 cifras a ${sentTo}. Caduca en 15 minutos.`, `We sent a 6-digit code to ${sentTo}. It expires in 15 minutes.`)}</P>
              <Field label={t("Código", "Code")} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} placeholder="123456" />
              <Button
                title={t("Confirmar el correo", "Confirm the email")}
                busy={busy === "confirm"}
                disabled={!wordsOk || code.replace(/\D/g, "").length !== 6 || !!busy}
                onPress={() =>
                  act("confirm", t("No se pudo confirmar", "Could not confirm"), async () => {
                    const shown = await emailConfirm({ words, email, code });
                    setWords("");
                    setCode("");
                    setSentTo(null);
                    Alert.alert(t("Avisos por correo", "Email alerts"), t(`Listo: si pasa algo importante, avisaremos también a ${shown}.`, `Done: if something important happens, we'll also alert ${shown}.`));
                    load();
                  })
                }
              />
              <Button title={t("Cambiar el correo", "Change the email")} kind="ghost" style={{ marginTop: space.s }} onPress={() => setSentTo(null)} />
            </>
          ) : (
            <>
              <Field
                label={status.email ? t("Correo nuevo", "New email") : t("Tu correo", "Your email")}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoComplete="email"
                placeholder={t("tu@correo.com", "you@email.com")}
              />
              <Button
                title={t("Mandarme un código", "Send me a code")}
                busy={busy === "start"}
                disabled={!wordsOk || !emailOk || !!busy || !status.available}
                onPress={() =>
                  act("start", t("No se pudo mandar el código", "Could not send the code"), async () => {
                    setSentTo(await emailStart({ words, email }));
                  })
                }
              />
            </>
          )}
          {status.email && !sentTo ? (
            <Button
              title={t("Quitar el correo", "Remove the email")}
              kind="ghost"
              style={{ marginTop: space.m }}
              busy={busy === "remove"}
              disabled={!wordsOk || !!busy}
              onPress={() =>
                act("remove", t("No se pudo quitar", "Could not remove it"), async () => {
                  if (!(await confirm(t("¿Quitar el correo?", "Remove the email?"), t("Dejarás de recibir avisos por correo.", "You'll stop receiving email alerts."), t("Quitar", "Remove"), true))) return;
                  await emailRemove(words);
                  setWords("");
                  load();
                })
              }
            />
          ) : null}
          <P muted style={{ marginTop: space.l }}>
            {t(
              "Nunca te pediremos tus 24 palabras por correo ni te mandaremos enlaces para hacer nada. Si un correo lo hace, es falso.",
              "We will never ask for your 24 words by email or send you links to do anything. If an email does, it's fake.",
            )}
          </P>
        </>
      )}
    </Screen>
  );
}

/** Si la bóveda está en modo robo (lo activó alguien con el kit), se avisa y se puede quitar con el kit. */
function TheftModeCard() {
  useProtectSecrets();
  const { theftStatus, stopTheftMode } = useWallet();
  const [status, setStatus] = useState<{ active: boolean; until: number } | null>(null);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  React.useEffect(() => {
    void theftStatus().then(setStatus);
  }, [theftStatus]);
  if (!status?.active) return null;
  return (
    <Card tone="danger" style={{ marginTop: space.xl }}>
      <H2>{t("Modo robo activado", "Theft mode is on")}</H2>
      <P>
        {t(
          "Alguien con tu kit de rescate ha avisado de que te robaron el móvil: el guardián bloquea todas las retiradas de esta bóveda. Si no has sido tú, tu kit está en otras manos: evacúa la bóveda con el móvil y el kit.",
          "Someone with your rescue kit reported this phone as stolen: the guardian blocks every withdrawal from this vault. If it wasn't you, your kit is in someone else's hands: evacuate the vault with the phone and the kit.",
        )}
      </P>
      <P muted>{t("Si has recuperado el móvil, quítalo con tus 24 palabras.", "If you got your phone back, turn it off with your 24 words.")}</P>
      <WordsField label={wordsLabel(words)} value={words} onChangeText={setWords} placeholder={WORDS_PLACEHOLDER()} />
      <Button
        title={t("Quitar el modo robo", "Turn off theft mode")}
        kind="secondary"
        busy={busy}
        disabled={wordCount(words) !== 24}
        onPress={() =>
          void run(t("No se pudo quitar", "Could not turn it off"), async () => {
            setBusy(true);
            try {
              await stopTheftMode(words);
              setStatus({ active: false, until: 0 });
              setWords("");
              haptic.success();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Card>
  );
}

/** Texto del resultado de una evacuación (HBAR, tokens movidos y los que no pudieron salir). */
function evacuationText(out: EvacuateResult, to: string) {
  const parts = [t(`${formatHbar(out.tinybars)} HBAR enviados a ${to}.`, `${formatHbar(out.tinybars)} HBAR sent to ${to}.`)];
  if (out.tokens.length) parts.push(t(`También ${out.tokens.length} token(s).`, `Also ${out.tokens.length} token(s).`));
  if (out.nfts.length) parts.push(t(`Y ${out.nfts.length} NFT.`, `And ${out.nfts.length} NFT(s).`));
  if (out.failedNfts.length) parts.push(t(`${out.failedNfts.length} NFT no se pudieron mover y siguen en la bóveda.`, `${out.failedNfts.length} NFT(s) could not be moved and are still in the vault.`));
  const skipped = (out.skippedTokens ?? []).length + (out.skippedNfts ?? []).length;
  if (skipped) {
    parts.push(
      t(
        `${skipped} token(s) o NFT se han quedado en la bóveda a propósito: moverlos le cobraría una comisión (puede ser un token trampa que te han regalado). No los toques si no sabes qué son.`,
        `${skipped} token(s) or NFT(s) were left in the vault on purpose: moving them would charge it a fee (it may be a trap token someone sent you). Leave them alone if you don't know what they are.`,
      ),
    );
  }
  if (out.failedTokens.length) {
    parts.push(
      t(
        `${out.failedTokens.length} token(s) no se pudieron mover (el destino no los acepta) y siguen en la bóveda: ${out.failedTokens.map((f) => f.tokenId).join(", ")}.`,
        `${out.failedTokens.length} token(s) could not be moved (the destination doesn't accept them) and are still in the vault: ${out.failedTokens.map((f) => f.tokenId).join(", ")}.`,
      ),
    );
  }
  return parts.join(" ");
}

/** Evacuación inmediata con las dos llaves (v2): para cuando sospechas de una de ellas. */
export function Evacuate({ onBack, suspect }: { onBack: () => void; suspect?: "kit" | "device" }) {
  useProtectSecrets();
  const { evacuate, profile, balances, tokens } = useWallet();
  const [words, setWords] = useState("");
  // Si la llave sospechosa es la del móvil, la cartera de este móvil NO es un sitio seguro.
  const [target, setTarget] = useState<"pocket" | "other">(suspect === "device" ? "other" : "pocket");
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  if (!profile?.vault) return null;
  const to = target === "pocket" ? (profile.pocket.accountId ?? "") : other.trim();
  const ok = wordCount(words) === 24 && isValidDestination(to);
  const tokenCount = tokens.vault.filter((x) => x.balance > 0n).length;
  const all = balances.vault != null ? `${formatHbar(balances.vault)} HBAR${tokenCount ? t(` + ${tokenCount} token(s)`, ` + ${tokenCount} token(s)`) : ""}` : t("todo", "everything");
  return (
    <Screen title={t("Evacuar la bóveda", "Evacuate the vault")} onBack={onBack}>
      <Card tone="warn">
        <P>{t("Con este móvil y tu kit de rescate juntos sacas todo al momento, sin cuenta atrás: HBAR y tokens.", "With this phone and your rescue kit together you take everything out instantly, with no countdown: HBAR and tokens.")}</P>
        <P style={{ marginBottom: 0 }}>{t("Úsalo si crees que alguien tiene una de tus llaves. Después crea una bóveda nueva con un kit nuevo.", "Use it if you think someone has one of your keys. Then create a new vault with a new kit.")}</P>
      </Card>
      <WordsField label={wordsLabel(words)} value={words} onChangeText={setWords} placeholder={WORDS_PLACEHOLDER()} />
      <Choice
        value={target}
        onChange={setTarget}
        options={[
          { value: "pocket", label: t("A mi cartera de este móvil", "To this phone's wallet"), detail: t("Si crees que alguien tiene tu kit de rescate.", "If you think someone has your rescue kit.") },
          { value: "other", label: t("A otra cuenta mía", "To another account of mine"), detail: t("Si crees que alguien tiene la llave de este móvil: tu cartera de aquí no es segura.", "If you think someone has this phone's key: your wallet here isn't safe.") },
        ]}
      />
      {target === "other" ? <Field label={t("Destino", "To")} value={other} onChangeText={setOther} placeholder={DEST_PLACEHOLDER()} hint={t("Otra wallet o cuenta tuya que no dependa de este móvil.", "Another wallet or account of yours that doesn't depend on this phone.")} /> : null}
      <Button
        title={t(`Evacuar ${all}`, `Evacuate ${all}`)}
        kind="danger"
        disabled={!ok}
        busy={busy}
        onPress={() =>
          void run(t("No se pudo evacuar", "Could not evacuate"), async () => {
            if (!(await confirm(t("¿Evacuar la bóveda?", "Evacuate the vault?"), t(`Todo irá a ${to} ahora mismo.`, `Everything goes to ${to} right now.`), t("Evacuar", "Evacuate"), true))) return;
            setBusy(true);
            try {
              const out = await evacuate({ words, to });
              done(t("Bóveda evacuada", "Vault evacuated"), evacuationText(out, to), out.txId || undefined);
              onBack();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Screen>
  );
}

const RECOVER_STEPS = (stolen: boolean) =>
  stolen
    ? [
        t("Comprobando el kit", "Checking the kit"),
        t("Congelando las retiradas", "Freezing withdrawals"),
        t("Avisando al guardián", "Telling the guardian"),
        t("Creando tu cartera nueva", "Creating your new wallet"),
        t("Pidiendo la recuperación", "Requesting the recovery"),
        t("Listo", "Done"),
      ]
    : [t("Comprobando el kit", "Checking the kit"), t("Creando tu cartera nueva", "Creating your new wallet"), t("Pidiendo la recuperación", "Requesting the recovery"), t("Listo", "Done")];

/**
 * Móvil nuevo, solo con el kit (v1: rescate inmediato · v2: recuperación con cuenta atrás).
 * Si te han robado el móvil, primero congela las retiradas y activa el modo robo del guardián.
 */
export function Recover({ onBack, onDone, initialVaultId = "", initialStolen = false }: { onBack: () => void; onDone: () => void; initialVaultId?: string; initialStolen?: boolean }) {
  useProtectSecrets();
  const { recoverWithKit } = useWallet();
  const [what, setWhat] = useState<"lost" | "stolen">(initialStolen ? "stolen" : "lost");
  const [words, setWords] = useState("");
  const [vaultId, setVaultId] = useState(initialVaultId);
  const [target, setTarget] = useState<"here" | "other">("here");
  const [to, setTo] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState(-1);
  const [result, setResult] = useState<RecoverResult | null>(null);
  const stolen = what === "stolen";
  const ok = wordCount(words) === 24 && /^0\.0\.\d+$/.test(vaultId.trim()) && (target === "here" || isValidDestination(to));

  if (result) {
    const where = result.here ? t("tu cartera nueva de este móvil", "your new wallet on this phone") : result.to;
    const tokensNote =
      (result.kind === "v2" && result.tokens ? t(` y ${result.tokens} token(s)`, ` and ${result.tokens} token(s)`) : "") +
      (result.kind === "v2" && result.nfts ? t(` y ${result.nfts} NFT`, ` and ${result.nfts} NFT(s)`) : "");
    const theft = result.kind === "v2" ? result.stolen : undefined;
    return (
      <Screen title={result.kind === "v1" ? t("Bóveda rescatada", "Vault rescued") : theft ? t("Bóveda protegida", "Vault protected") : t("Recuperación en marcha", "Recovery under way")}>
        {theft ? (
          <Card tone="accent">
            <H2>{t("Retiradas congeladas", "Withdrawals frozen")}</H2>
            <P style={{ marginBottom: 0 }}>
              {theft.guardianNotified
                ? t(
                    `Quien tenga tu móvil no puede sacar nada hasta el ${when(theft.frozenUntil)}, y después el guardián bloqueará cualquier retirada hasta que llegue tu recuperación.`,
                    `Whoever has your phone can't take anything out until ${when(theft.frozenUntil)}, and after that the guardian will block every withdrawal until your recovery arrives.`,
                  )
                : t(
                    `Quien tenga tu móvil no puede sacar nada hasta el ${when(theft.frozenUntil)}. No he podido avisar al guardián: antes de esa hora, vuelve aquí con tu kit para congelarlas otra vez.`,
                    `Whoever has your phone can't take anything out until ${when(theft.frozenUntil)}. I couldn't reach the guardian: before then, come back here with your kit to freeze them again.`,
                  )}
            </P>
          </Card>
        ) : null}
        <Card tone="brass">
          <Big color={colors.brass}>{formatHbar(result.tinybars)} HBAR</Big>
          {result.kind === "v1" ? (
            <P>{t(`Ya están en ${where}.`, `They are already in ${where}.`)}</P>
          ) : (
            <P>
              {t(
                `Llegarán${tokensNote} a ${where} el ${when(result.executableAt)}, cuando acabe la cuenta atrás. El guardián lo completará solo.`,
                `They${tokensNote} will reach ${where} on ${when(result.executableAt)}, when the countdown ends. The guardian completes it on its own.`,
              )}
            </P>
          )}
        </Card>
        {result.kind === "v2" && (result.later || result.keyedOnly) ? (
          <Card tone="warn">
            <P style={{ marginBottom: 0 }}>
              {result.keyedOnly
                ? t(
                    "Esta vez van solo tokens cuyo emisor puede ponerles comisiones: en la bóveda ya no queda nada con qué pagarlas. Si el guardián no la completa solo, complétala tú cuanto antes al acabar la cuenta atrás.",
                    "This time only tokens whose issuer can add fees are going: there's nothing left in the vault to pay them with. If the guardian doesn't complete it, complete it yourself as soon as the countdown ends.",
                  )
                : t(
                    `${result.later} token(s) se quedan por ahora en la bóveda: pueden cobrar una comisión al moverlos y, con una recuperación, cualquiera podría completarla después de ponérsela. Cuando llegue esto, pide otra recuperación con tu kit: saldrán solos, sin nada con qué cobrarla.`,
                    `${result.later} token(s) stay in the vault for now: they can charge a fee to move and, with a recovery, anyone could complete it after adding one. When this arrives, request another recovery with your kit: they'll go alone, with nothing to charge it from.`,
                  )}
            </P>
          </Card>
        ) : null}
        {result.kind === "v2" && result.priority ? (
          <Card tone="accent">
            <H2>{t("Recuperación prioritaria", "Priority recovery")}</H2>
            <P style={{ marginBottom: 0 }}>
              {t(
                "Con tu contraseña de desempate, quien tenga tu móvil antiguo no puede pararla ni congelarla, y las retiradas quedan cerradas hasta que llegue.",
                "With your tiebreaker password, whoever has your old phone can't stop or freeze it, and withdrawals stay closed until it arrives.",
              )}
            </P>
          </Card>
        ) : result.kind === "v2" ? (
          <Card>
            <P style={{ marginBottom: 0 }}>
              {t(
                "Mientras dura la cuenta atrás, quien tenga tu móvil antiguo puede congelar la recuperación. Si lo hace, el dinero queda congelado, no robado: esta app te avisará y podrás pedirla otra vez con tu kit.",
                "While the countdown runs, whoever has your old phone can freeze the recovery. If they do, the money is frozen, not stolen: this app will tell you and you can request it again with your kit.",
              )}
            </P>
          </Card>
        ) : null}
        <Button title={result.here ? t("Ir a mi cartera nueva", "Go to my new wallet") : t("Entendido", "Got it")} onPress={onDone} />
        {!result.here ? <Button title={t("Ver en HashScan", "View on HashScan")} kind="ghost" style={{ marginTop: space.s }} onPress={() => open(accountLink(result.to))} /> : null}
      </Screen>
    );
  }

  if (step >= 0) {
    return (
      <Screen title={stolen ? t("Protegiendo tu bóveda", "Protecting your vault") : t("Recuperando tu bóveda", "Recovering your vault")}>
        <Card>
          <Steps steps={RECOVER_STEPS(stolen)} current={step} />
          <P muted>{t("Tarda unos segundos. No cierres la app.", "It takes a few seconds. Don't close the app.")}</P>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("Recuperar con el kit", "Recover with the kit")} onBack={onBack}>
      <Choice
        value={what}
        onChange={setWhat}
        options={[
          { value: "lost", label: t("He perdido el móvil", "I lost my phone"), detail: t("Recupera el dinero en una cuenta nueva tras la cuenta atrás.", "Recover the money into a new account after the countdown.") },
          {
            value: "stolen",
            label: t("Me han robado el móvil", "My phone was stolen"),
            detail: t("Primero congela las retiradas al momento y pide al guardián que bloquee cualquier otra. Después, lo mismo que si lo hubieras perdido.", "First freezes withdrawals instantly and asks the guardian to block any new one. Then, the same as if you had lost it."),
          },
        ]}
      />
      {stolen ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>
            {t(
              "Hazlo cuanto antes. Si el ladrón ya pidió una retirada, congelar la anula si aún no ha salido.",
              "Do it as soon as possible. If the thief already requested a withdrawal, freezing cancels it as long as it hasn't gone out yet.",
            )}
          </P>
        </Card>
      ) : null}
      <WordsField label={wordsLabel(words)} value={words} onChangeText={setWords} placeholder={WORDS_PLACEHOLDER()} />
      <Field label={t("Número de la bóveda", "Vault number")} value={vaultId} onChangeText={setVaultId} placeholder="0.0.1234" />
      <Field
        label={t("Contraseña de desempate (si la creaste)", "Tiebreaker password (if you made one)")}
        value={password}
        onChangeText={setPassword}
        hint={t(
          "Con ella, tu recuperación gana: el móvil antiguo no puede pararla ni congelarla. Sin ella, se pide la recuperación normal.",
          "With it, your recovery wins: the old phone can't stop or freeze it. Without it, the normal recovery is requested.",
        )}
      />
      <Choice
        value={target}
        onChange={setTarget}
        options={[
          { value: "here", label: t("A una cartera nueva en este móvil", "To a new wallet on this phone"), detail: t("Recomendado. Después podrás crear una bóveda nueva.", "Recommended. You can create a new vault afterwards.") },
          { value: "other", label: t("A otra cuenta mía", "To another account of mine") },
        ]}
      />
      {target === "other" ? <Field label={t("Destino", "To")} placeholder={DEST_PLACEHOLDER()} value={to} onChangeText={setTo} /> : null}
      <Button
        title={stolen ? t("Congelar y recuperar", "Freeze and recover") : t("Recuperar", "Recover")}
        kind={stolen ? "danger" : "primary"}
        icon={stolen ? "snowflake" : undefined}
        disabled={!ok}
        onPress={() =>
          void run(t("No se pudo recuperar", "Could not recover"), async () => {
            setStep(0);
            try {
              setResult(await recoverWithKit({ words, vaultId, here: target === "here", to, stolen, password, onStep: setStep }));
            } finally {
              setStep(-1);
            }
          })
        }
      />
    </Screen>
  );
}

const MIGRATE_STEPS = () => [
  t("Comprobando tu kit antiguo", "Checking your old kit"),
  t("Creando tu kit nuevo", "Creating your new kit"),
  t("Desplegando tu notario v2", "Deploying your v2 notary"),
  t("Creando la bóveda v2", "Creating the v2 vault"),
  t("Moviendo el dinero", "Moving the money"),
  t("Activando el guardián", "Activating the guardian"),
  t("Listo", "Done"),
];

/** Bóveda v1 → v2 con el rescate inmediato de la v1 (hace falta su kit). */
export function Migrate({ onBack, onDone }: { onBack: () => void; onDone: (words: string[], vaultId: string, password?: string | null) => void }) {
  useProtectSecrets();
  const { migrateToV2, balances, profile } = useWallet();
  const [words, setWords] = useState("");
  const [delays, setDelays] = useState<Delays>(DEFAULT_DELAYS);
  const [pw, setPw] = useState<PasswordPlan>(() => newPasswordPlan());
  const [step, setStep] = useState(-1);
  const need = pw.on ? 26n : 24n; // con contraseña, el notario v3 gasta algo más al desplegarse
  const enough = (balances.pocket ?? 0n) >= need * HBAR;
  const ok = wordCount(words) === 24 && enough && passwordReady(pw);
  if (!profile?.vault) return null;
  if (step >= 0) {
    return (
      <Screen title={t("Pasando a la v2", "Upgrading to v2")}>
        <Card>
          <Steps steps={MIGRATE_STEPS()} current={step} />
          <P muted>{t("Tarda unos segundos. No cierres la app.", "It takes a few seconds. Don't close the app.")}</P>
        </Card>
      </Screen>
    );
  }
  const now = balances.vault != null ? `${formatHbar(balances.vault)} HBAR` : "—";
  return (
    <Screen title={t("Pasar a la bóveda v2", "Upgrade to the v2 vault")} onBack={onBack}>
      <Card>
        <P>{t(`Se crea una bóveda v2 con un kit de rescate NUEVO y se mueve a ella todo el saldo de tu bóveda actual (${now}).`, `A v2 vault is created with a NEW rescue kit and your current vault's whole balance (${now}) moves into it.`)}</P>
        <P style={{ marginBottom: 0 }}>
          {t("Para moverlo al momento hace falta el kit de tu bóveda actual. Si no lo tienes, saca antes el dinero con «Sacar» y vuelve.", "Moving it instantly needs your current vault's kit. If you don't have it, take the money out first with \"Withdraw\" and come back.")}
        </P>
      </Card>
      <WordsField label={t(`Las 24 palabras de tu kit actual (${wordCount(words)}/24)`, `The 24 words of your current kit (${wordCount(words)}/24)`)} value={words} onChangeText={setWords} placeholder={WORDS_PLACEHOLDER()} />
      <DelayPicker value={delays} onChange={setDelays} />
      <PasswordSetup value={pw} onChange={setPw} />
      {!enough ? <P style={{ color: colors.danger }}>{t(`Tu cartera necesita unos ${need} HBAR para crear la bóveda v2. Recárgala desde el faucet.`, `Your wallet needs about ${need} HBAR to create the v2 vault. Top it up from the faucet.`)}</P> : null}
      <Button
        title={t("Pasar a la v2", "Upgrade to v2")}
        disabled={!ok}
        onPress={() =>
          void run(t("No se pudo pasar a la v2", "Could not upgrade to v2"), async () => {
            setStep(0);
            try {
              const d = delaysOf(delays);
              const password = pw.on ? pw.password : null;
              const out = await migrateToV2({ oldWords: words, withdrawDelay: d.withdraw, recoveryDelay: d.recovery, password, onStep: setStep });
              onDone(out.words, out.vaultId, password);
            } finally {
              setStep(-1);
            }
          })
        }
      />
    </Screen>
  );
}

const DELAY_STEPS = (password: boolean) => [
  password ? t("Comprobando el kit y la contraseña", "Checking the kit and the password") : t("Comprobando el kit", "Checking the kit"),
  t("Desplegando el notario nuevo", "Deploying the new notary"),
  t("Cambiando la llave de la bóveda", "Changing the vault key"),
  t("Avisando al guardián", "Telling the guardian"),
  t("Listo", "Done"),
];

/**
 * Cambiar los plazos de la bóveda o poner/cambiar la contraseña de desempate: hace falta el móvil y el
 * kit a la vez (un ladrón con el móvil no puede acortarlos ni quitar la contraseña).
 */
export function ChangeDelays({ onBack }: { onBack: () => void }) {
  useProtectSecrets();
  const { profile, changeDelays, balances, movements } = useWallet();
  const v = profile?.vault;
  const hasPassword = !!v?.tiebreaker;
  const [pw, setPw] = useState<PasswordPlan>(() => newPasswordPlan(!hasPassword));
  const [delays, setDelays] = useState<Delays>(() => ({ mode: "normal", withdraw: v?.delaySeconds && v.delaySeconds >= 86400 ? v.delaySeconds : DEFAULT_DELAYS.withdraw, recovery: v?.recoveryDelaySeconds && v.recoveryDelaySeconds >= 7 * 86400 ? v.recoveryDelaySeconds : DEFAULT_DELAYS.recovery }));
  const [words, setWords] = useState("");
  const [step, setStep] = useState(-1);
  if (!v) return null;
  const d = delaysOf(delays);
  const same = d.withdraw === v.delaySeconds && d.recovery === (v.recoveryDelaySeconds ?? 0) && !pw.on;
  // Notario v3 (con contraseña): algo más de gas al desplegarlo.
  const need = pw.on || hasPassword ? 22n : 20n;
  const enough = (balances.pocket ?? 0n) >= need * HBAR;
  const pending = movements.filter((m) => m.status === "requested" && !m.executed && !m.expired).length;
  if (step >= 0) {
    return (
      <Screen title={t("Cambiando los ajustes", "Changing the settings")}>
        <Card>
          <Steps steps={DELAY_STEPS(pw.on)} current={step} />
          <P muted>{t("Tarda unos segundos. No cierres la app.", "It takes a few seconds. Don't close the app.")}</P>
        </Card>
      </Screen>
    );
  }
  return (
    <Screen title={t("Plazos y contraseña", "Delays and password")} onBack={onBack}>
      <Card>
        <P>
          {t(
            `Ahora: sacar ${formatDelay(v.delaySeconds)} · recuperar con el kit ${formatDelay(v.recoveryDelaySeconds ?? 0)}.`,
            `Now: withdraw ${formatDelay(v.delaySeconds)} · recover with the kit ${formatDelay(v.recoveryDelaySeconds ?? 0)}.`,
          )}
        </P>
        <P>{hasPassword ? t("Contraseña de desempate: activada.", "Tiebreaker password: on.") : t("Contraseña de desempate: no tiene.", "Tiebreaker password: none.")}</P>
        <P muted style={{ marginBottom: 0 }}>
          {t(
            "Para cambiarlos hacen falta tus 24 palabras: así, alguien que tenga solo tu móvil no puede acortarlos. Se despliega un notario nuevo (unos 17 HBAR en la red de pruebas) y la bóveda cambia de llave al momento.",
            "Changing them needs your 24 words: that way someone with only your phone can't shorten them. A new notary is deployed (about 17 HBAR on the test network) and the vault changes key instantly.",
          )}
        </P>
      </Card>
      {pending > 0 ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>
            {t(`Tienes ${pending} operación(es) en camino. Al cambiar los plazos se cancelan: tendrás que pedirlas otra vez.`, `You have ${pending} operation(s) on their way. Changing the delays cancels them: you'll have to request them again.`)}
          </P>
        </Card>
      ) : null}
      <DelayPicker value={delays} onChange={setDelays} />
      {hasPassword ? (
        <>
          <SectionTitle>{t("Contraseña de desempate", "Tiebreaker password")}</SectionTitle>
          <Choice
            value={pw.on ? "change" : "keep"}
            onChange={(c) => setPw(c === "change" ? { ...newPasswordPlan(true) } : { ...pw, on: false })}
            options={[
              { value: "keep", label: t("Mantener la que tengo", "Keep the one I have") },
              { value: "change", label: t("Cambiarla", "Change it"), detail: t("La anterior deja de servir.", "The old one stops working.") },
            ]}
          />
          {pw.on ? <PasswordSetup value={pw} onChange={setPw} optional={false} /> : null}
        </>
      ) : (
        <PasswordSetup value={pw} onChange={setPw} />
      )}
      <WordsField label={t(`Las 24 palabras de tu kit (${wordCount(words)}/24)`, `The 24 words of your kit (${wordCount(words)}/24)`)} value={words} onChangeText={setWords} placeholder={WORDS_PLACEHOLDER()} />
      {!enough ? <P style={{ color: colors.danger }}>{t(`Tu cartera necesita unos ${need} HBAR para desplegar el notario nuevo.`, `Your wallet needs about ${need} HBAR to deploy the new notary.`)}</P> : null}
      <Button
        title={same ? t("Ya tienes estos ajustes", "You already have these settings") : pw.on && d.withdraw === v.delaySeconds && d.recovery === (v.recoveryDelaySeconds ?? 0) ? t("Guardar la contraseña", "Save the password") : t("Guardar los cambios", "Save the changes")}
        disabled={same || !enough || wordCount(words) !== 24 || !passwordReady(pw)}
        onPress={() =>
          void run(t("No se pudieron guardar los cambios", "The changes could not be saved"), async () => {
            setStep(0);
            try {
              await changeDelays({ words, withdrawDelay: d.withdraw, recoveryDelay: d.recovery, password: pw.on ? pw.password : undefined, onStep: setStep });
              setStep(4);
              haptic.success();
              Alert.alert(
                t("Cambios guardados", "Changes saved"),
                [
                  t(`Sacar: ${formatDelay(d.withdraw)}. Recuperar con el kit: ${formatDelay(d.recovery)}.`, `Withdraw: ${formatDelay(d.withdraw)}. Recover with the kit: ${formatDelay(d.recovery)}.`),
                  pw.on ? t("Contraseña de desempate guardada. Apúntala lejos del kit.", "Tiebreaker password saved. Write it down away from the kit.") : "",
                ]
                  .filter(Boolean)
                  .join(" "),
              );
              onBack();
            } finally {
              setStep(-1);
            }
          })
        }
      />
    </Screen>
  );
}

/**
 * Permisos de gasto de la Cartera: quién puede mover fondos de tu Cartera sin volver a preguntarte (lo que
 * buscan las webs que roban) y quitarlos. Los da la Cartera al aprobarlos en una dApp; la bóveda no da permisos.
 */
export function Allowances({ onBack }: { onBack: () => void }) {
  const { pocketAllowances, revokePocketAllowance, meta } = useWallet();
  const [list, setList] = useState<Allowance[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setList(await pocketAllowances());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [pocketAllowances]);
  useEffect(() => {
    void load();
  }, [load]);
  const keyOf = (a: Allowance) => [a.kind, a.kind === "hbar" ? "" : a.tokenId, a.kind === "nft" ? a.serial : "", a.spender].join(":");
  const what = (a: Allowance) => {
    const unlimited = 2n ** 62n;
    if (a.kind === "hbar") return a.amount >= unlimited ? t("HBAR sin límite", "Unlimited HBAR") : `${formatHbar(a.amount)} HBAR`;
    const m = meta(a.tokenId);
    const name = m ? hideLinks(m.symbol || m.name) : a.tokenId;
    if (a.kind === "token") return a.amount >= unlimited ? t(`${name} sin límite`, `Unlimited ${name}`) : `${m ? formatUnits(a.amount, m.decimals, 2) : a.amount.toString()} ${name}`;
    if (a.kind === "nftAll") return t(`Todos tus NFT de ${name}`, `All your ${name} NFTs`);
    return `NFT ${name} #${a.serial}`;
  };
  const remove = (a: Allowance) =>
    void run(t("Quitar el permiso", "Remove the allowance"), async () => {
      const ok = await confirm(
        t("Quitar el permiso", "Remove the allowance"),
        t(`${a.spender} ya no podrá mover ${what(a)} de tu Cartera.`, `${a.spender} will no longer be able to move ${what(a)} from your Wallet.`),
        t("Quitar", "Remove"),
        true,
      );
      if (!ok) return;
      setBusy(keyOf(a));
      try {
        await revokePocketAllowance(a);
        haptic.success();
        await load();
      } finally {
        setBusy("");
      }
    });
  return (
    <Screen title={t("Permisos de gasto", "Spending allowances")} onBack={onBack} refreshing={false} onRefresh={() => void load()}>
      <P muted>
        {t(
          "Quien tiene un permiso puede mover esos fondos de tu Cartera sin volver a preguntarte: es lo que buscan las webs que roban. Quita los que no reconozcas o ya no uses. Tu bóveda no da permisos.",
          "Whoever holds an allowance can move those funds from your Wallet without asking again: it's what scam sites are after. Remove the ones you don't recognise or no longer use. Your vault never grants allowances.",
        )}
      </P>
      {error ? <P style={{ color: colors.danger }}>{error}</P> : null}
      {list == null && !error ? <P muted>{t("Cargando…", "Loading…")}</P> : null}
      {list && list.length === 0 ? (
        <Card>
          <P style={{ marginBottom: 0 }}>{t("Tu Cartera no ha dado ningún permiso.", "Your Wallet hasn't granted any allowance.")}</P>
        </Card>
      ) : null}
      {list && list.length > 0 ? (
        <Group>
          {list.map((a) => (
            <ListRow
              key={keyOf(a)}
              icon="hand.raised.fill"
              iconColor={colors.warn}
              title={what(a)}
              subtitle={t(`Puede moverlo: ${a.spender}`, `Can move it: ${a.spender}`)}
              value={busy === keyOf(a) ? t("Quitando…", "Removing…") : t("Quitar", "Remove")}
              valueColor={colors.danger}
              onPress={busy ? undefined : () => remove(a)}
            />
          ))}
        </Group>
      ) : null}
      <P muted>{t("Quitar un permiso cuesta una pequeña comisión de la red, que paga tu Cartera.", "Removing an allowance costs a small network fee, paid by your Wallet.")}</P>
    </Screen>
  );
}
