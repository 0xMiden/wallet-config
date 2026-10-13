# wallet-config

Per-network Epoch, Agglayer, swap and USDCx settings the Miden wallet reads at runtime from
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`. Whatever is on
`main` is what every wallet on that network uses within about an hour; there is no signature.

## Fields

| Field | Meaning |
|---|---|
| `network` | The network this file is for; must equal the file name (`testnet.json` holds `"testnet"`). |
| `version` | Positive integer. A wallet never goes back to a lower version than one it has accepted. |
| `evm.chainId` | EVM chain of the L1 bridge and the EVM USDC. Supported: `11155111` (Sepolia). |
| `agglayer.l1Bridge` | Agglayer unified bridge contract on the EVM chain (20-byte `0x` address). |
| `agglayer.midenBridge` | Agglayer bridge account on Miden (15-byte `0x` account id). Its registry lists the bridgeable tokens. |
| `agglayer.indexerUrl` | Agglayer bridge indexer base URL (`https:`), up to and including `/api`. |
| `epoch.allocatorUrl` | Epoch allocator base URL (`https:`). |
| `epoch.positionsUrl` | Epoch positions service base URL (`https:`). |
| `epoch.midenUsdcFaucet` | Miden USDC faucet used as Epoch collateral (15-byte `0x` account id). |
| `epoch.evmUsdc` | USDC on the EVM chain, the Fast route's output and the Earn underlying (20-byte `0x` address). |
| `epoch.earnProtocol` | Earn lending protocol. Supported: `dummy-lending`. |
| `features.earn` | Switch for new Earn deposits. |
| `features.fastBridge` | Switch for new Fast (Epoch) bridges, in and out. |
| `features.bridgeIn` | Switch for new Slow (Agglayer) bridges from EVM to Miden. |
| `features.bridgeOut` | Switch for new Slow (Agglayer) bridges from Miden to EVM. |
| `features.usdcxIn` | Switch for new USDCx deposits from EVM to Miden. On needs at least one usable deposit source in `usdcx.chains`. |
| `features.usdcxOut` | Switch for new USDCx withdrawals from Miden to EVM. On needs at least one supported chain in `usdcx.chains`. |
| `mainnetCountdown.enabled` | Switch for the banner in the open wallet that counts down to mainnet and links to the early-access list. |
| `mainnetCountdown.launchAt` | The deadline as an RFC 3339 UTC timestamp (`2026-10-26T00:00:00Z`). Required while enabled; the banner hides when it passes. |
| `onboarding.inviteOnly` | Optional. The Welcome screen a new wallet opens on: `true` for the invite-only one ("I have a code", which asks for a mainnet access code), `false` for the general one (create or recover). Either value removes the seven-tap switch between them on the logo. Absent means the general Welcome, with the seven-tap switch to the invite-only one. |
| `swap.etaUrl` | The DEX quote service base URL (`https:`); the wallet appends `/v1/swap-eta`. Required when `swap.tokens` is set. |
| `swap.tokens` | The tokens the swap screen offers, in picker order; the first two are the pair the form opens on. None, or at least two. |
| `swap.tokens[].symbol` | The symbol the wallet shows: 1 to 6 upper-case letters, unique in the list. |
| `swap.tokens[].faucetId` | The token's faucet (15-byte `0x` account id), unique in the list. |
| `swap.tokens[].decimals` | The faucet's on-chain decimals (integer, 0 to 12). The wallet converts typed amounts with it, so a wrong value changes what is swapped. |
| `swap.tokens[].logo` | Optional. The bundled mark to draw: `MIDEN`, `ETH`, `USDC` or `BTC`. Another value is ignored and the default mark is drawn. |
| `swap.tokens[].priceSymbol` | Optional. The asset the wallet's price feed values the token at: `ETH`, `BTC` or `USDC`. Absent means unpriced. Another value is ignored. |
| `usdcx.midenDomain` | Circle's remote-domain id for Miden (integer, 0 to 4294967295). Required in the section. |
| `usdcx.attestationUrl` | Circle's xReserve attestation service base URL (`https:`); the wallet appends `/v1/attestations`. Required in the section. |
| `usdcx.irisUrl` | Optional. Circle's Iris API base URL (`https:`), which attests the CCTP leg of an `executor` deposit. Absent means no `executor` deposits. |
| `usdcx.chains` | The EVM chains of the USDCx routes: an object keyed by chain name, in picker order; the first entry is the default. Every listed chain is a withdrawal destination. Required in the section. |
| `usdcx.chains.<name>` | The key is the chain's name: lowercase letters and digits, in groups joined by one hyphen (`arc-testnet`). Unique in the object. |
| `usdcx.chains.<name>.chainId` | The chain's EVM id (positive integer), unique in the object. Supported: `11155111` (Sepolia), `5042002` (Arc Testnet), `84532` (Base Sepolia), `421614` (Arbitrum Sepolia). Another id is ignored and its chain is dropped. |
| `usdcx.chains.<name>.domain` | Circle's domain of the chain (integer, 0 to 4294967295; Ethereum is `0`). |
| `usdcx.chains.<name>.usdc` | Circle's USDC on the chain (20-byte `0x` address). |
| `usdcx.chains.<name>.deposit` | Optional. How a deposit starts on the chain. Absent means a withdrawal destination only. |
| `usdcx.chains.<name>.deposit.route` | `xreserve` (deposit into the chain's own xReserve) or `executor` (CCTP burn to the executor chain; needs `usdcx.irisUrl` and a chain with `executor`). Another value is ignored and the chain is a withdrawal destination only. |
| `usdcx.chains.<name>.deposit.xReserve` | Route `xreserve`: the xReserve contract (20-byte `0x` address). Required for that route. |
| `usdcx.chains.<name>.deposit.tokenMessenger` | Route `executor`: the CCTP TokenMessenger (20-byte `0x` address). Required for that route. |
| `usdcx.chains.<name>.deposit.tokenMessengerWithFees` | Route `executor`: the CCTP TokenMessenger wrapper that takes fees (20-byte `0x` address). Required for that route. |
| `usdcx.chains.<name>.executor` | Optional. Circle's Generic Executor on the chain every `executor` deposit goes to. At most one chain carries it, and only a chain whose route is `xreserve`. |
| `usdcx.chains.<name>.executor.address` | The executor contract (20-byte `0x` address). Required in `executor`. |
| `usdcx.chains.<name>.executor.handler` | The executor's DepositFor handler (20-byte `0x` address). Required in `executor`. |

Everything else (rollup id, bridgeable tokens, the bridge tokens' decimals and symbols, the Earn
market, service health) the wallet reads from chain and from the services themselves. `agglayer`,
`epoch`, `swap`, `usdcx`, `mainnetCountdown` and `onboarding` may be omitted. Each listed swap token requires `symbol`,
`faucetId` and `decimals`. A missing switch is off, a
missing `swap.tokens` shows Swap as unavailable on that network, and a missing `usdcx` shows USDCx
deposits and withdrawals as not configured. Unknown fields are ignored, so a
field can be added before older wallets understand it.

The order of the keys in `usdcx.chains` is data: it is the order of the wallet's chain picker, and
the first entry is the default chain. Do not run a formatter that sorts keys on this file. A chain
name must not appear twice: JSON keeps only the last one.

## What a switch does

A switch that is `false` greys out the entry point for **new** Earn deposits, Fast bridges or Slow
bridges in that direction. It never blocks Withdraw (Earn), Claim (Agglayer, on L1) or Reclaim
(Epoch): those recover funds, and the wallet never greys them out.
A switch also never changes a transfer already in flight: each one keeps the ids it started with.

`features.usdcxIn` and `features.usdcxOut` follow the same rule. A switch that is `false` stops
**new** USDCx deposits or withdrawals only. A deposit or a withdrawal that already started
continues to its end.

`mainnetCountdown.enabled` controls only the banner. It does not change transfer controls.

`onboarding.inviteOnly` controls only the Welcome screen of a wallet with no account yet. It does not
change an existing wallet. Older wallets ignore it and keep the general Welcome.

## Publishing

1. Edit the values and bump `version`. Going back to older values is a new, higher version too.
2. Open a pull request. `validate` checks the document against the wallet's own rules, the version
   bump against `main`, and, for every switch that is on, that the contracts exist on the EVM chain
   and the services answer their health routes. For USDCx it reads each chain's contracts on that
   chain. It does not read Miden, the quote service or Circle's two services: check a
   swap token's faucet and decimals against the chain, the quote service's answer, and the Circle
   URLs and domains, yourself before you merge.
3. Merge (squash). Wallets pick it up within about an hour plus the raw CDN cache (about 5 minutes);
   a wallet showing a greyed-out control re-checks every minute.

To stage a deploy, merge the new values with their switch `false` (`validate` checks no service for a
switch that is off), then flip the switch in a second pull request once the deploy is live.

Run the checks locally with Node 22: `node --test scripts/validate.test.mjs` and
`node scripts/validate.mjs` (add `--no-smoke` to skip the network, `BASE_REF=origin/main` for the
version rule).
