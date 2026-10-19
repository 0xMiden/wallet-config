# wallet-config

The wallet reads one network document from
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`.
A changed document must have a higher `version`. The `network` must match the file name.

Testnet is fully configured. Devnet keeps its published disabled document.
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

## Fiat on-ramp

`onramp` is optional. It names the EIP-7702 smart-account implementation that
the fiat on-ramp and off-ramp relay use (Uniswap Calibur v1.1.0). The user's EVM
address delegates to it, the wallet signs EIP-712 batches in its domain, and the
backend relays them. The wallet and the backend both read this section. Absent
means the network has no on-ramp: devnet and mainnet do not set it.

| Field                     | Meaning                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `chainId`                 | The EVM chain that the relay runs on, and the chain of the EIP-712 domain. It must be the `chainId` of a `supportedEvmChains` entry. |
| `calibur.address`         | The Calibur implementation that the user's address delegates to.                                                                     |
| `calibur.runtimeHash`     | The keccak256 of the deployed Calibur runtime code. The backend checks it before each prepare and relay.                             |
| `calibur.domainName`      | The EIP-712 domain name.                                                                                                             |
| `calibur.domainVersion`   | The EIP-712 domain version.                                                                                                          |
| `calibur.batchTtlSeconds` | How long a signed batch stays valid: the batch deadline is at most this many seconds away.                                           |

Every field is required. `chainId` and `batchTtlSeconds` are positive integers.
The address has 20 bytes, and the runtime hash has 32 bytes. The domain name and
version are 1 to 32 characters with no control character and no space at either
end.

The wallet builds the signed batch and the backend checks it, so change these
values only together with a wallet build and a backend release that expect them.

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

The on-ramp has no switch, so the final command always checks it when it is set:
the Calibur address must have code. It does not check the Calibur runtime hash.
Check that value before publication.

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
