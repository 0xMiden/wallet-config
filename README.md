# wallet-config

The wallet reads one network document from
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`.
A changed document must have a higher `version`. The `network` must match the file name.

Testnet is fully configured. Devnet keeps its published disabled document.
Mainnet lists its Guardian operators, routes USDCx from Arc, Ethereum, Base, and
Arbitrum, and bridges native ETH over Agglayer from Ethereum (rollup 30, "Cedar").
Its Earn and Epoch features are off, and it has no swap tokens.

## Bridge configuration

`features` keeps the existing switches: `earn`, `fastBridge`, `bridgeIn`, and
`bridgeOut`. `earn` controls new Earn deposits. `fastBridge` controls Epoch
transfers in both directions. `bridgeIn` and `bridgeOut` control Agglayer deposits
and withdrawals. A false global switch disables new transfers even when a chain
route is enabled. When a bridge switch is omitted, the per-chain switches apply.
The wallet gets Earn markets from Epoch. This document does not configure markets.

`geo` contains the `wallet`, `earn` and `swap` location rules. The schema permits
omitting `geo` for older documents, but the eligibility service requires an explicit
`geo.wallet` map before granting access. A global denial blocks the whole wallet,
including withdrawals. An Earn or Swap rule blocks new operations in that feature;
an Earn-only denial leaves withdrawals available.

Each rule is `block` plus a place, with `"yes"` to block or `"no"` to leave it
unblocked. Places are `NY state`, `New York`, `UK`, `United Kingdom`,
`Great Britain`, an ISO country (`DE`, `GB`) or a subdivision (`US-NY`, `US-CA`).
Unknown features, invalid phrases and repeated places are refused.

All three published network documents block Cuba (`CU`), Iran (`IR`), North Korea
(`KP`), Russia (`RU`), Belarus (`BY`), Crimea (`UA-43`), Sevastopol (`UA-40`),
Donetsk (`UA-14`), Luhansk (`UA-09`), Kherson (`UA-65`) and Zaporizhzhia (`UA-23`).
The whole four oblasts are blocked. The policy does not distinguish territorial
control within an oblast. NY and UK remain separate Earn-only rules.

```json
"geo": {
  "wallet": {
    "block CU": "yes",
    "block IR": "yes",
    "block KP": "yes",
    "block RU": "yes",
    "block BY": "yes",
    "block UA-43": "yes",
    "block UA-40": "yes",
    "block UA-14": "yes",
    "block UA-09": "yes",
    "block UA-65": "yes",
    "block UA-23": "yes"
  },
  "earn": {
    "block NY state": "yes",
    "block UK": "yes"
  },
  "swap": {
    "block US-CA": "no"
  }
}
```

Older wallet versions that ignore `geo` gain the application gate only after
updating. The service returns permission decisions, not the caller's location.

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

Direction switches control new transfers only. They leave claims, reclaims, Earn
withdrawals and recovery available while the global wallet policy allows access.
Existing transfers keep the data saved when they started.

## Other settings

`swap`, `onboarding`, `mainnetCountdown`, and other unrelated sections remain in
place. Swap requires an HTTPS `etaUrl` and at least two tokens when a token list
is set. Each token needs a unique uppercase `symbol` (1-6 letters), a unique
15-byte `faucetId`, and integer `decimals` from 0 to 12. Optional `logo` values
are `MIDEN`, `ETH`, `USDC`, and `BTC`. Optional `priceSymbol` values are `ETH`,
`BTC`, and `USDC`.

`onboarding.inviteOnly` is an optional boolean. `mainnetCountdown.enabled` is a
boolean; when true, `launchAt` must be a valid UTC timestamp such as
`2026-10-26T16:00:00Z`.

`limits.bridgeInMaxBalanceUsd` is an optional number above zero: the most an
account may hold, in US dollars, once a bridge-in lands. The wallet's deposit
screen refuses a deposit that takes the receiving account's valued holdings past
it. It is a gate on that screen only: a note that arrives any other way is not
refused. A document with no `limits` section sets no ceiling.

## Guardian operators

`guardians` is optional. It lists the Guardian operators of the network in
picker order, and the first is the default operator. It has 1 to 16 entries.
Absent means the wallet uses the list it ships with.

| Field        | Meaning                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | Unique in the list: 1 to 32 lower-case letters, digits and single hyphens. The wallet draws its bundled logo for `open-zeppelin`, `gateway`, `lambda-class` and `kodax`. `custom` and `no-guardian` are reserved. |
| `name`       | The name the wallet shows (1 to 48 characters).                                                                                                                                                                 |
| `operatedBy` | Who runs the operator (1 to 48 characters).                                                                                                                                                                     |
| `location`   | The operator's region, as the wallet shows it (1 to 48 characters).                                                                                                                                             |
| `endpoint`   | The Guardian base URL (`https:`), unique in the list. A trailing slash and a default port are dropped and the host is lower-cased.                                                                              |

Two optional fields describe the operator in English. The wallet shows them as
written, in every language:

| Field   | Meaning                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| `about` | One sentence on who runs the operator (1 to 160 characters). Onboarding shows it under the operator's name. |
| `kind`  | A short line on what kind of company runs it (1 to 64 characters). The Change provider sheet shows it.      |

Without them, the wallet shows its own words for the four bundled ids and
`operatedBy` for any other id.

A text has no control character and no space at either end. Each entry needs
the five fields `id`, `name`, `operatedBy`, `location` and `endpoint`.

`guardians` replaces the list the wallet ships with; it does not add to it. The
wallet uses the list in these places:

- A new wallet chooses its operator from it.
- A wallet recovered from its recovery phrase looks for its account at each
  listed operator.
- The wallet reads an account's recovered history from each listed operator.
- When an account's stored operator and its on-chain Guardian key disagree, the
  wallet asks each listed operator for its key, and it can move the account to
  the listed operator that holds the on-chain key.

An account keeps the operator it has. If you remove an operator from the list,
the accounts that use it do not move and continue to work. They lose the name
and logo of their operator, and the wallet no longer reads their recovered
history from it by default. To remove every operator, do not omit `guardians`:
the wallet then uses its own list. An empty list is refused. Older wallets
ignore the field and keep their own list.

A Guardian has no switch: list an operator only when its endpoint is live.

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

The final command also asks every listed Guardian for its key
(`GET <endpoint>/pubkey?scheme=ecdsa`, the request the wallet makes). An
operator that `main` does not list yet must answer. An operator already on
`main` that does not answer gives a warning only. Two operators that serve one
key fail. The command cannot tell who operates an endpoint: confirm that with
the operator before publication.

Stage a route with both direction switches false. Enable it after its contracts
and services are ready. Keep route data while transfers can need recovery.

Wallets released before the new reader (1.17.3 and earlier) read only the old
root fields `evm`, `agglayer`, and `epoch`; without them every bridge and Earn
feature turns off. Newer wallets
read only `bridge-providers` and `supportedEvmChains`. Keep both shapes, with the
same values, until no supported release reads the old fields. A wallet never
accepts a version below the highest it has accepted, so a revert ships as a new
version.
