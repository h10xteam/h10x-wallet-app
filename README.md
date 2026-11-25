# H10X Wallet

A self-custody wallet for [Hedera](https://hedera.com) with a protected **vault**, part of the H10X project
(<https://h10xindex.xyz/#wallet>).

**The rule: no single key can move money quickly.** With your phone you withdraw after a countdown. With your
rescue kit (24 words), if you lose your phone, you recover after a longer one. While a countdown runs, the other
key can block it. With the phone and the kit together you can move everything at once.

> **Beta.** Running on Hedera **mainnet** with caps, for a small group of testers, and on testnet for tests.
> The code has been reviewed by the team only; no third party has reviewed it. Only keep what you can afford to lose.

## How it works

- **Wallet account** (the "pocket"): a normal Hedera account on your phone for everyday use. Its key lives in the
  phone's secure keychain, behind Face ID / fingerprint.
- **Rescue kit**: 24 words on paper. They control a small account (3 HBAR) that pays its own fees.
- **Vault**: a Hedera account with a `1 of 3` key:

  ```
  1 of 3
  ├─ ALL [ phone , notary ]   withdrawal: short countdown; the kit or the guardian can block it
  ├─ ALL [ kit   , notary ]   recovery: longer countdown; the phone can block it
  └─ ALL [ phone , kit ]      both keys together: immediate
  ```

- **Notary** (`contracts/VaultNotary2.sol`, `VaultNotary3.sol`): an immutable contract, one per vault. It holds no
  money and cannot move it on its own. It only co-signs a scheduled transaction once its countdown has passed and
  nobody has blocked it. Each key can also **freeze** the other key's lane.
- **Guardian** (`guardian/`): a small service that watches registered vaults, completes withdrawals and recoveries
  when their countdown ends, sends push (and optional email) alerts, and blocks operations the app never asks for.
  It never moves funds and it can never block your recovery.

## Features

| | |
| --- | --- |
| Create a wallet, create a vault with a verified rescue kit | ✅ |
| Send, store in the vault, withdraw with a countdown, block | ✅ |
| Alerts: a withdrawal you don't recognise, someone used your kit; freeze lanes | ✅ |
| Evacuate with phone + kit; recover on a new phone with only the kit | ✅ |
| "My phone was stolen": freeze withdrawals with the kit from another device + guardian theft mode | ✅ |
| Tie-break password (notary v3): kit + password always wins a phone-vs-kit dispute | ✅ |
| Move the whole wallet to a new phone without copying any key | ✅ |
| Hedera tokens (HTS) and NFTs in the wallet account and in the vault | ✅ |
| Native staking from the vault (rewards stay in the vault) | ✅ |
| Swap on SaucerSwap: HBAR ↔ a reviewed token list, and token ↔ token; output to the wallet or straight to the vault | ✅ |
| Tokenized stocks on Hedera through SODAX (mainnet) | ✅ beta |
| Trusted friends (DeRec): recover the wallet account on a new phone with your friends' help | ✅ beta |
| dApps over WalletConnect (HIP-820), with every request decoded before signing | ✅ |
| Several wallets on the same phone, each with its own vault and kit | ✅ |
| Full activity history (sends, receipts, swaps, NFTs, staking, dApp signatures) | ✅ |
| Prices in € or $, English and Spanish | ✅ |
| Buy with card through an external provider | ⏸ prepared, off |
| Service fees | ⏸ prepared, off |

## Security model and known limits

- Stolen phone **and** kit together (with the phone unlocked): they can empty the vault immediately.
- Only the phone: the thief can freeze your recovery, so the money is frozen, not stolen. With the **tie-break
  password** your recovery wins and cannot be stopped. If you still have your phone, evacuate with phone + kit.
- Only the kit: the thief can cancel your withdrawals and close that lane for a while. You evacuate.
- If nobody looks during the whole recovery countdown, a thief with the kit gets the vault. That is why the guardian
  sends push alerts, and optional email alerts that only the kit can change.
- A connected dApp can ask the wallet account for spending permissions (allowances). The app shows them in red and
  lets you revoke them, but the user approves them. Keep the valuable part in the vault.
- The app and the guardian trust the Hedera mirror node they read from.

### Vault time locks

- **Withdrawal with the phone:** 24 hours by default; 48 hours, 3 days or 7 days can be chosen.
- **Recovery with the kit:** 7 days by default, or 14 days. Never shorter than the withdrawal.

Changing them later requires the 24 words: the notary cannot change its own delays, so the app deploys a new notary
(same phone, same kit, same guardian) and switches the vault key with phone + kit together.

### Tie-break password (notary v3)

When creating the vault, the app suggests 5 random words (you can change them). **Kit + password** gives a
**priority recovery**: the phone cannot block or freeze it, and withdrawals stay closed until it executes. Without the
kit the password is useless; the notary only stores an address derived from it with scrypt. If you forget it, you
only lose the tie-break.

### Notary factory

With a tie-break password, each vault's notary is created by a factory (`contracts/NotaryFactory3.sol`: no owner, no
state, no admin key). The app only uses it if its on-chain code exactly matches the compiled one, and it compares the
created notary byte by byte before binding the vault to it. This cuts the cost of creating a vault from about 28 HBAR
to about 7.

## Trusted friends (DeRec, beta)

Optional social recovery of the **wallet account** with the [DeRec](https://derecalliance.org) protocol
(`@derec-alliance/react-native` 0.1.0). The rescue kit is never shared, and the vault keeps its own rules.

- **What is shared:** the wallet-account key (32 bytes) and the wallet profile, split among your friends ("helpers")
  with a threshold of `max(2, ⌊n/2⌋ + 1)`.
- **Transport:** Hedera Consensus Service. Each device has its own mailbox, a topic without a submit key, and reads
  it from the mirror node. Messages are paid by a small mailbox account funded with 2 HBAR from the wallet account,
  never by the wallet account itself. Only DeRec's encrypted messages travel; HCS shows which mailbox writes to which,
  not what they say.
- **Pairing:** the owner shows a QR code (`ContactMode.HashedKeys`, valid for 15 minutes); the friend scans it.
  The app only accepts pairing for its own fresh codes.
- **Recovery:** on the new phone, each friend picks the owner and shows a recovery code; releasing a share always
  needs the friend's confirmation after comparing a 6-digit code with the owner by phone. Before installing the key,
  the app checks on the network that it still controls the wallet account. Then it protects the secret again from the
  new phone.
- **Code:** `core/src/derec/` (stores, HCS transport, friend codes, device logic), `app/src/derec/` and
  `app/src/screens/Friends.tsx`. Tests: `test/derec.test.mjs`; testnet scenario: `test/derec/hcs-prueba.mjs`.

The DeRec native module only runs in an installed build (TestFlight / EAS), not in Expo Go.

## Swap

On SaucerSwap, from the wallet account only. HBAR ↔ token for a reviewed list of tokens per network
(`core/src/swaptokens.js`: each one has a pool with WHBAR, no custom fees or fee key, no KYC, not frozen or paused; the
app checks this again on the mirror node every time). Token ↔ token goes direct or through WHBAR, always through the
same router so it is a single transaction with the minimum output inside.

The app quotes every pool and route and uses the best one: V1 with `getAmountsOut`, V2 with the QuoterV2 or, when the
public mirror node refuses the QuoterV2, with the same concentrated-liquidity maths applied to the pool's on-chain
state (`core/src/swapv3.js`, checked against the real QuoterV2 to the unit). Before signing it re-quotes and simulates
the call. Slippage 0.5 %, 1 % or 3 %. Sells approve the exact amount only, never unlimited. No H10X Wallet fee.

## Tokenized stocks (beta)

Buy and sell, with HBAR or USDC, the stock tokens that SODAX brings to Hedera as HTS tokens (mainnet only). SODAX's
API prepares the transaction; the app decodes it and checks contract, amount, token, origin, destination, minimum and
deadline before the wallet signs a single EVM transaction. The token list is fixed in `core/src/stocks.js` and checked
again on the network. The user confirms they meet SODAX's terms, and the issuer's notice is shown. No H10X Wallet fee.
Builds can leave this out with `EXPO_PUBLIC_STOCKS=0`.

## dApps

Connections over WalletConnect only with an allow-list (`core/src/dapps.js`): SaucerSwap, SentX, HSuite, HashPack and
Kabila, plus the H10X website on mainnet.

- The domain is checked against the origin certified by WalletConnect Verify, not the name the site claims.
- Only the wallet account connects; the vault never signs for a dApp.
- Every request is decoded and shown (what leaves, to whom, permissions, contracts) and signed with Face ID.
  Always blocked: key changes, account deletion, security settings, system operations, and transaction lists whose
  body differs per node. Unlimited allowances are shown in red.
- What you see is what you sign: bodies with two operations, unreadable data, or that don't start with the payer
  are rejected.
- Links hidden in token, NFT and memo names are removed with a warning. Tokens calling themselves "HBAR" are marked
  as fake.
- The in-app dApp browser only stays on allow-listed domains; other links open outside the app or are blocked.

## Repository layout

```
app/        the mobile app (Expo SDK 58 + React Native)
core/       shared logic: keys, vaults and notaries, mirror node, swaps, stocks, DeRec, dApp request decoding
guardian/   the guardian service
contracts/  VaultNotary (v1), VaultNotary2 (v2), VaultNotary3 (v3) and NotaryFactory3
scripts/    contract build, read-only quote checks, emergency notice and factory deployment helpers
test/       offline tests, simulated network, real-testnet tests and the attack programme
```

The server setup (service units, firewall, reverse proxy, build machine) is not part of this repository.

## Build and test

Requires Node 20 or newer.

```bash
npm ci --ignore-scripts
npm test             # offline suite: notaries with fuzzing, core, end-to-end, attacks
npm run typecheck    # types for core, guardian and app
npm run compile      # recompiles the notaries
```

The guardian is configured with environment variables in `guardian/.env` (never committed), for example
`HEDERA_NETWORK`, `OPERATOR_ID` / `OPERATOR_KEY` (the guardian's own account, which pays notary calls), `PORT`,
`MAX_VAULT_HBAR` and `MAX_VAULTS` (beta caps), and optional `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `EMAIL_FROM` for
email alerts. It listens on `127.0.0.1` and is meant to sit behind a reverse proxy.

The app is built with EAS (Expo Application Services). WalletConnect needs a Reown project ID
(`EXPO_PUBLIC_WC_PROJECT_ID`).

Code comments and test names are in Spanish.

## Naming

The project used to be called Hvault. Some internal names keep it so nothing breaks: the package names (`boveda`,
`@boveda/core`), the Expo slug, the server tooling (`hvault-vps`), storage keys on the phone, and the signed message
tags `hvault-desempate-v1` and `hvault-robo:v1` (changing them would invalidate passwords and alerts already signed).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

H10X team · <https://h10xindex.xyz>
