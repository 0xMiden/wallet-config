# wallet-config

The wallet reads one network document from
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`.
A changed document must have a higher `version`. The `network` must match the file name.

This change configures testnet only. Devnet keeps its published disabled document.
Mainnet configuration is deferred.

## Bridge configuration

`features` keeps the existing switches: `earn`, `fastBridge`, `bridgeIn`, and
`bridgeOut`. `earn` controls new Earn deposits. `fastBridge` controls Epoch
transfers in both directions. `bridgeIn` and `bridgeOut` control Agglayer deposits
and withdrawals. A false global switch disables new transfers even when a chain
route is enabled. When a bridge switch is omitted, the per-chain switches apply.
The wallet gets Earn markets from Epoch. This document does not configure markets.

`bridge-providers` holds shared services:

| Provider   | Fields                                             |
| ---------- | -------------------------------------------------- |
| `epoch`    | `allocatorUrl`, `positionsUrl`, optional `outputs` |
| `agglayer` | `indexerUrl`                                       |
| `usdcx`    | `midenDomain`, `attestationUrl`, `irisUrl`         |

Service URLs must use HTTPS, without credentials, a query, or a fragment.
Epoch `outputs` maps an output name to `{ "faucetId": "0x…" }`. The
`usdc-testnet-output` entry identifies the special testnet faucet. Mainnet Epoch
does not require this entry or any Miden faucet.

`supportedEvmChains` maps chain slugs to `{ "chainId": number, "bridges": {} }`.
The slug and id must match the wallet registry. Each bridge has `depositEnabled`
and `withdrawalEnabled` booleans. A missing bridge is unavailable.

| Bridge     | Route fields                                                                              |
| ---------- | ----------------------------------------------------------------------------------------- |
| `epoch`    | `tokens.USDC.contractAddress`; optional `tokens.USDC.outputs` lists provider output names |
| `agglayer` | `contractAddress`, `midenBridgeId`                                                        |
| `usdcx`    | `domain`, `tokens.USDC.contractAddress`, optional `deposit`, optional `executor`          |

A USDCx `deposit` is one of these forms:

```json
{ "route": "xreserve", "xReserve": "0x…" }
```

```json
{
  "route": "executor",
  "executorChain": "arc-testnet",
  "tokenMessenger": "0x…",
  "tokenMessengerWithFees": "0x…"
}
```

The executor chain must have a USDCx xReserve deposit route and an
`executor` with `address` and `handler`. Its direction switches can be off.
A deposit route is required when deposits are enabled. EVM addresses have 20
bytes. Miden account ids have 15 bytes. Circle domains are unsigned 32-bit integers.
Source tokens belong to each bridge. There is no global EVM chain or USDC address.

Chain order sets picker order. Do not sort the chain keys. Do not repeat keys:
JSON parsing would discard the first value. Validation checks the source text.

Direction switches control new transfers only. They must not block a claim,
reclaim, Earn withdrawal, or recovery of an existing transfer. Existing transfers
keep the data saved when they started.

## Other settings

`swap`, `onboarding`, `mainnetCountdown`, and other unrelated sections remain in
place. Swap requires an HTTPS `etaUrl` and at least two tokens when a token list
is set. Each token needs a unique uppercase `symbol` (1–6 letters), a unique
15-byte `faucetId`, and integer `decimals` from 0 to 12. Optional `logo` values
are `MIDEN`, `ETH`, `USDC`, and `BTC`. Optional `priceSymbol` values are `ETH`,
`BTC`, and `USDC`.

`onboarding.inviteOnly` is an optional boolean. `mainnetCountdown.enabled` is a
boolean; when true, `launchAt` must be a valid UTC timestamp such as
`2026-10-26T16:00:00Z`.

## Validation and publication

Use Node 22:

```sh
node --test scripts/validate.test.mjs
BASE_REF=origin/main node scripts/validate.mjs --no-smoke
node scripts/validate.mjs
```

The final command checks contracts on each enabled route's chain and shared
service health. Executor deposits also check the target contracts when its new
transfer switches are off. It does not check Miden faucets or Circle service
responses. Check these values before publication.

Stage a route with both direction switches false. Enable it after its contracts
and services are ready. Keep route data while transfers can need recovery.

This schema requires the matching wallet release. Released wallets that read the
old root fields cannot use this document. Do not merge or publish it until the
wallet release and the configuration rollout have an agreed order. These changes
do not publish a transition or add old fields for older releases.
