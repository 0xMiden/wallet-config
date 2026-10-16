# wallet-config

The wallet reads one network document from
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`.
A changed document must have a higher `version`. The `network` must match the file name.

Testnet keeps its four active USDCx routes and stages six more destinations.
Devnet keeps its published disabled document.
Mainnet lists its Guardian operator and routes USDCx from Arc, Ethereum, Base, and
Arbitrum. Its Earn, Epoch, and Agglayer features are off, and it has no swap tokens.

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

`chains` maps chain slugs to network definitions. Each entry has a `family`:

- `evm`: a numeric `chainId` and `bridges`.
- `solana`: a `cluster` and `bridges`, without an EVM `chainId`.

Each bridge has independent `depositEnabled` and `withdrawalEnabled` booleans.
A missing bridge is unavailable. A withdrawal-only USDCx entry does not need
`deposit`, `executor`, or TokenMessenger addresses. The Circle `domain` belongs
under `bridges.usdcx`; it is not the EVM chain ID.

Testnet version 11 adds `chains`. It keeps the four existing entries in
`supportedEvmChains` for released wallets. The validator checks that these
entries match `chains`, except for the new `family` field. New readers must use
`chains` when present and use `supportedEvmChains` only when `chains` is absent.
Do not merge the two lists. Mainnet and devnet keep their existing format.

The wallet still needs a `chains` reader and the new chain definitions. A config
entry alone does not add wallet support. Before enabling a new route, add its
wallet RPC and explorer support, add its RPC to this repository's smoke checks,
and verify that the bridge service can complete the withdrawal.

For Solana Devnet, use `tokens.USDC.mintAddress` with Circle's Devnet mint.
Solana deposits are not supported by this schema yet. An enabled Solana
withdrawal checks that the mint exists under the SPL Token program, is initialized,
and uses six decimals. The wallet must derive the recipient's USDC token account;
the bridge service must ensure that account exists before payout.

Address validation belongs in wallet code. EVM recipients use 20-byte addresses;
Solana recipients use Base58-encoded
32-byte addresses. Do not add address regexes to the remote document.

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
Token addresses belong to each bridge. There is no global EVM chain or USDC address.

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
feature turns off. Wallets with the current reader
read only `bridge-providers` and `supportedEvmChains`. The proposed reader uses
`chains` first. Keep both shapes, with the
same values, until no supported release reads the old fields. A wallet never
accepts a version below the highest it has accepted, so a revert ships as a new
version.

## Testnet withdrawal destinations

The first four entries retain their existing picker order and deposit routes.
All ten entries enable USDCx withdrawals. The six new entries keep deposits off.
The wallet must support the new chain families before these routes appear.
Solana payouts use an initialized USDC token account, as specified in Circle's
[Gateway guide](https://developers.circle.com/gateway/references/solana) and
[CCTP guide](https://developers.circle.com/cctp/references/solana-programs).

| Chain slug | EVM chain ID / Solana cluster | Circle domain |
| --- | --- | --- |
| arc-testnet | 5042002 | 26 |
| sepolia | 11155111 | 0 |
| base-sepolia | 84532 | 6 |
| arbitrum-sepolia | 421614 | 3 |
| avalanche-fuji | 43113 | 1 |
| optimism-sepolia | 11155420 | 2 |
| polygon-amoy | 80002 | 7 |
| monad-testnet | 10143 | 15 |
| hyperevm-testnet | 998 | 19 |
| solana-devnet | devnet | 5 |

Reference data checked on 2026-10-16:

- [Circle domain IDs](https://developers.circle.com/cctp/concepts/supported-chains-and-domains)
- [Circle native USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Chainlink network IDs](https://docs.chain.link/resources/link-token-contracts)
- [Viem chain definitions](https://github.com/wevm/viem/tree/main/src/chains/definitions)
