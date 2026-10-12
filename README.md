# wallet-config

Per-network Epoch, Agglayer and swap settings the Miden wallet reads at runtime from
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
| `swap.etaUrl` | The DEX quote service base URL (`https:`); the wallet appends `/v1/swap-eta`. Required when `swap.tokens` is set. |
| `swap.tokens` | The tokens the swap screen offers, in picker order; the first two are the pair the form opens on. None, or at least two. |
| `swap.tokens[].symbol` | The symbol the wallet shows: 1 to 6 upper-case letters, unique in the list. |
| `swap.tokens[].faucetId` | The token's faucet (15-byte `0x` account id), unique in the list. |
| `swap.tokens[].decimals` | The faucet's on-chain decimals (integer, 0 to 12). The wallet converts typed amounts with it, so a wrong value changes what is swapped. |
| `swap.tokens[].logo` | Optional. The bundled mark to draw: `MIDEN`, `ETH`, `USDC` or `BTC`. Another value is ignored and the default mark is drawn. |
| `swap.tokens[].priceSymbol` | Optional. The asset the wallet's price feed values the token at: `ETH`, `BTC` or `USDC`. Absent means unpriced. Another value is ignored. |

Everything else (rollup id, bridgeable tokens, the bridge tokens' decimals and symbols, the Earn
market, service health) the wallet reads from chain and from the services themselves. `agglayer`,
`epoch` and `swap` are optional, and so is every field inside them; a missing switch is off, and a
missing `swap.tokens` shows Swap as unavailable on that network. Unknown fields are ignored, so a
field can be added before older wallets understand it.

## What a switch does

A switch that is `false` greys out the entry point for **new** Earn deposits, Fast bridges or Slow
bridges in that direction. It never blocks Withdraw (Earn), Claim (Agglayer, on L1) or Reclaim
(Epoch): those recover funds, and the wallet never greys them out.
A switch also never changes a transfer already in flight: each one keeps the ids it started with.

## Publishing

1. Edit the values and bump `version`. Going back to older values is a new, higher version too.
2. Open a pull request. `validate` checks the document against the wallet's own rules, the version
   bump against `main`, and, for every switch that is on, that the contracts exist on the EVM chain
   and the services answer their health routes. It does not read Miden or the quote service: check a
   swap token's faucet and decimals against the chain, and the quote service's answer, yourself
   before you merge.
3. Merge (squash). Wallets pick it up within about an hour plus the raw CDN cache (about 5 minutes);
   a wallet showing a greyed-out control re-checks every minute.

To stage a deploy, merge the new values with their switch `false` (`validate` checks no service for a
switch that is off), then flip the switch in a second pull request once the deploy is live.

Run the checks locally with Node 22: `node --test scripts/validate.test.mjs` and
`node scripts/validate.mjs` (add `--no-smoke` to skip the network, `BASE_REF=origin/main` for the
version rule).
