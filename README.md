# wallet-config

The wallet reads one network document from
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`.
A changed document must have a higher `version`. The `network` must match the file name.

Testnet is fully configured. Devnet keeps its published disabled document.
Mainnet lists its Guardian operators, routes USDCx from Arc, Ethereum, Base, and
Arbitrum, and bridges native ETH over Agglayer from Ethereum (rollup 30, "Cedar").
Mainnet Earn is on: it lists Aave V3 and Compound III USDC vaults on Arbitrum,
Base and Ethereum, through Epoch routes on those three chains, each with its
protocol's logo from `icons/`. Epoch fast bridge transfers (`fastBridge`) and
NEAR intents stay off. Mainnet Swap uses
`https://api.forkchoice.xyz`; the current wallet reads tokens and pairs from
the solver's `/v2/pairs` endpoint.

## Bridge configuration

`features` keeps the switches `earn`, `fastBridge`, `bridgeIn`, `bridgeOut`,
`nearIntents` and `arcadeGcPurchase`. Each value must be a boolean; an omitted
`nearIntents` or `arcadeGcPurchase` defaults to `false`. `arcadeGcPurchase`
turns on buying Game Coins in Arcade and requires the `arcade` section (see
[Arcade GC sale](#arcade-gc-sale)). `nearIntents` controls NEAR swaps routed through 1Click. Keep it false
until 1Click lists Miden and the NEAR token mappings, proxy, and receipt
configuration have been verified. Do not enable it with placeholder production
URLs, keys, or mappings. `earn` controls new Earn deposits. `fastBridge` controls
Epoch transfers in both directions. `bridgeIn` and `bridgeOut` control Agglayer
deposits and withdrawals. A false global switch disables new transfers even when
a chain route is enabled. When a bridge switch is omitted, the per-chain switches apply.
The `earn` section lists the Earn markets (see [Earn vaults](#earn-vaults)).

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
| `agglayer` | `contractAddress`, `midenBridgeId`; optional `tokens.<SYMBOL>.contractAddress`, `tokenApiUrl` |
| `usdcx`    | `domain`, `tokens.USDC.contractAddress`, optional `deposit`, optional `executor`          |

Agglayer `tokens` lists the ERC-20 source tokens the wallet offers for a deposit,
keyed by the symbol the picker shows (upper-case letters and digits, at most 11).
Native ETH is never listed: the wallet finds it in the Miden bridge's faucet
registry. That registry is the trust source for every listed token: the wallet
offers a token only when the registry holds a faucet for its contract address,
and takes the token's decimals from the contract. A listed token the registry
does not hold is dropped, so list a token once its faucet is registered.

Agglayer `tokenApiUrl` is a Blockscout API root (`https://<host>/api/v2`) that
lists an address's ERC-20 holdings on the chain. On a test network the wallet
also offers every holding of the connected wallet above 1e-5 of a token, since
the testnet bridge registers a token's faucet on its first deposit. Mainnet
offers only `tokens` and native ETH, whatever the field says.

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

## Arcade GC sale

`arcade.sale.seller` names the account whose public PSWAP note sells Game Coins:
a 15-byte `0x` account id. The section exists exactly while
`features.arcadeGcPurchase` is true: the switch on requires it, and an `arcade`
section while the switch is off or absent is refused. It is the one trust
decision the document makes for the Arcade purchase: the wallet finds the live
sale note on chain by the tag the PSWAP script derives from the GC and USDCx
faucets, prices a purchase from the note's own terms, and accepts only a note
whose creator is this seller. Nothing else about the sale is configured here.

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

## Earn vaults

`earn.vaults` lists the Epoch lending markets the Earn picker shows. The section
exists exactly while `features.earn` is true: Earn on requires a non-empty list,
and an `earn` section while Earn is off or `features.earn` is absent is refused,
so a stale list cannot stay in the document.

```json
"earn": {
  "vaults": [
    {
      "id": "aave-v3-base-usdc",
      "marketUid": "AAVE_V3:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "name": "Aave V3 USDC",
      "protocol": "1delta",
      "logo": "icons/aave.svg"
    }
  ]
}
```

| Field             | Meaning                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | Required. Unique in the list: a lower-case letter, then lower-case letters, digits and hyphens.                                                                                                                                                                 |
| `marketUid`       | Required. Unique in the list. Epoch's market id `LENDER_KEY:chainId:underlying`: `LENDER_KEY` is upper-case letters, digits and `_`; `chainId` is the `chainId` of a `supportedEvmChains` entry with a `bridges.epoch` route; `underlying` is the lower-case 0x address of that route's `tokens.USDC.contractAddress`. |
| `name`            | Required. The name the wallet shows (1 to 64 characters).                                                                                                                                                                                                       |
| `protocol`        | Required. `1delta` or `dummy-lending`: the string Epoch hashes into `protocolHashIdentifier` (`keccak256(toBytes(protocol))`). Mainnet vaults use `1delta`.                                                                                                     |
| `about`           | Optional. A description the wallet shows (at most 200 characters).                                                                                                                                                                                              |
| `risk`            | Optional. `low`, `medium` or `high`.                                                                                                                                                                                                                            |
| `depositsEnabled` | Optional boolean, default `true`. `false` marks a vault that takes no new deposits.                                                                                                                                                                              |
| `logo`            | Optional. The path of a logo file in this repository, relative to the document: `icons/<name>.svg` or `icons/<name>.png`, where `<name>` is lower-case letters and digits in groups joined by single hyphens. Several vaults can name one file. |

`name` and `about` are literal English text. The wallet shows them as written,
in every language, and never translates them.

### Vault logos

The wallet fetches a `logo` from the directory it fetched the document from:
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/icons/aave.svg`
for the published documents. When a vault has no `logo`, or the file cannot be
fetched, the wallet draws the mark it bundles for the protocol, else the
protocol's initial. Where each file comes from is in
[`icons/README.md`](icons/README.md).

The validator reads each named file from the repository, also with
`--no-smoke`, and refuses the document when a file breaks one of these rules:

- The file exists at the path, and it is at most 64 KiB (65,536 bytes).
- A PNG starts with the PNG signature.
- An SVG is UTF-8 text that starts with `<svg`, after an optional XML
  declaration and whitespace.
- An SVG contains no `<script`, no `<foreignObject`, no event handler attribute
  (` on…=`), no `javascript:`, and no `href` or `xlink:href` whose value does
  not start with `#`.

So a logo cannot run code or load a remote resource. Give an SVG a square
`viewBox` and no fixed `width` or `height` on its root, so the wallet can size
it. Remove metadata, comments, `<title>`, `<desc>` and editor namespaces before
you add a file.

List order is the picker order. The first vault with deposits enabled is the
default market. Do not sort the list.

A market must lend the USDC of an Epoch route, so add the chain's `epoch` route
to `supportedEvmChains` before you list a market on it. A vault the Epoch
catalogue does not serve cannot be listed: for example, MetaMorpho vaults are
not in the `/pools` catalogue, which lists only raw Morpho Blue markets
(`MORPHO_BLUE_<market id>`).

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

While Earn is on, the final command also asks the Epoch catalogue for the
markets of each lent token (`GET <positionsUrl>/pools?chainId=<id>&count=400&start=0&underlyings=<underlying>`)
and fails when it does not serve a listed `marketUid` (compared in lower case).
A host without the `/pools` route (testnet's) answers 404: the command then gives
a warning that it cannot verify the markets, not an error. `--no-smoke` skips this
check with the others.

The final command also asks every listed Guardian for its key
(`GET <endpoint>/pubkey?scheme=ecdsa`, the request the wallet makes). An
operator that `main` does not list yet must answer. An operator already on
`main` that does not answer gives a warning only. Two operators that serve one
key fail. The command cannot tell who operates an endpoint: confirm that with
the operator before publication.

On `testnet.json` every failed live check (service health, Guardian keys, RPC
chain ids and contract reads) is a warning: the command prints it with a `⚠`
and a GitHub `::warning` annotation that shows on the pull request, and the
check still passes. On `mainnet.json` and `devnet.json` they fail as described
above. Schema and URL format errors fail on every network.

Stage a route with both direction switches false. Enable it after its contracts
and services are ready. Keep route data while transfers can need recovery.

Wallets released before the new reader (1.17.3 and earlier) read only the old
root fields `evm`, `agglayer`, and `epoch`; without them every bridge and Earn
feature turns off. Newer wallets
read only `bridge-providers` and `supportedEvmChains`. Keep both shapes, with the
same values, until no supported release reads the old fields. A wallet never
accepts a version below the highest it has accepted, so a revert ships as a new
version.
