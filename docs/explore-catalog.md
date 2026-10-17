# Explore catalog

The native wallet reads its network's catalog from
`https://raw.githubusercontent.com/0xMiden/wallet-config/main/explore/<network>.json`.
Icons resolve against `https://raw.githubusercontent.com/0xMiden/wallet-config/main/explore/`.
The root `<network>.json` documents continue to configure bridges, swap and
onboarding; their schema and versions are independent of Explore.

## What configuration controls

Catalog items supply app identity, literal display text, launch URLs, icons and
placement. Sections supply featured/list ordering. The wallet does not hardcode
a game's destination: its Open action uses the validated item's `url`.

Home → Arcade, Rankings, Game Coins and Activity are native wallet routes, not
external URLs in this catalog. A listed game opens through the existing dApp
browser. Listing grants no trust badge, connection, private-data access or
transaction approval. There is no balance collection or leaderboard service here.

## Fields

| Field | Meaning |
|---|---|
| `network` | Must match the file name: `explore/testnet.json` names `testnet`. |
| `version` | Positive safe integer. A changed document requires a higher version than the base branch's. |
| `items[].id` | Unique app id matching `^[a-z0-9-]+$`. |
| `items[].name` | Localized text, at most 40 Unicode characters in each language. |
| `items[].tagline` | Localized text, at most 120 Unicode characters in each language. |
| `items[].url` | HTTPS launch URL, no credentials, IP literal, localhost or punycode hostname. Query and fragment are allowed; kept exactly as written. |
| `items[].category` | `tools`, `defi`, `games`, `nft` or `learn`. |
| `items[].icon` | Optional `icons/<name>.png`, relative to `explore/`; `<name>` uses lowercase letters, digits and hyphens. |
| `items[].brandColor` | Optional `#RRGGBB`. |
| `items[].isExchange` | Required boolean. Existing wallet/platform exchange gates still apply. |
| `sections[].id` | Unique section id matching `^[a-z0-9-]+$`; `recents` and `search-results` are reserved. |
| `sections[].kind` | `featured` or `list`. |
| `sections[].title` | Localized text. |
| `sections[].itemIds` | Existing item ids, once each, in display order. |

Localized text is an object of literal strings. `en` is required; `de`, `en_GB`,
`es`, `fr`, `ja`, `ko`, `pl`, `pt`, `ru`, `tr`, `uk`, `zh_CN` and `zh_TW` are
optional. Readers try the current locale, its base language, then English.
Unsupported locales and unknown fields are ignored. Unknown categories or section
kinds are omitted by readers; a malformed known field rejects the whole document.

The wallet maps `tools`/`defi` to Finance, `games` to Arcade, and `nft`/`learn` to
Others. All aggregates these groups. Do not serialize `all`, `finance`, `arcade`
or `others`; that would not be compatible with current catalog parsers.

Every icon must be a regular PNG file, not a symlink or reached through one,
square, at most 256×256 and 32 KiB. A catalog must fit in 32 KiB.

Do not use an empty, dummy or placeholder URL in an active item. Keep an
unpublished app's metadata in its candidate record until its reviewed destination
exists. To remove a listing, publish a higher-version catalog without the item
and its section references; deleting the document or returning 404 does not clear
wallets' last accepted catalogs. An intentionally empty catalog has `items: []`
and `sections: []` at a higher version.

## Validation and publication

Run with Node 22, without extra package dependencies:

```sh
node --test scripts/validate-explore.test.mjs
BASE_REF=origin/main node scripts/validate-explore.mjs
# One catalog:
BASE_REF=origin/main node scripts/validate-explore.mjs explore/testnet.json
```

The required `validate` CI job tests both validators, checks all Explore catalogs,
their icons and version bumps, and retains the existing root configuration checks.
The Explore validator mirrors the wallet parser. It does not visit launch URLs,
connect wallets, sign transactions or establish that a game is safe or working.
App-specific acceptance and deployment/origin review are still required.

After a reviewed merge and a matching wallet release, new catalogs are checked
hourly and on foreground return when older than 15 minutes, with bounded retries
after failure. Invalid, unavailable or lower-version data never replaces the last
accepted catalog. The wallet bundles snapshots for first-run/offline use and
never shows a snapshot below its stored version floor. Rollbacks use new, higher
versions; never reset a floor to make an old document load.

## Migration and rollout

The initial devnet (version 1), testnet (version 2) and three PNG icons are byte
copies of [wallet-explore at f5dad85](https://github.com/0xMiden/wallet-explore/tree/f5dad85b54dc074836c31e587b15ee509130cb6c).
The unchanged bodies preserve existing version floors and same-version identity
checks. The matching reader migration is [wallet #1512](https://github.com/0xMiden/wallet/pull/1512).
No mainnet catalog or new game is invented by this migration.

1. Review and merge these catalogs/validator before shipping the new reader.
2. Recheck wallet-explore for intervening changes immediately before publication
   and copy them here with their versions; never ship a lower version or different
   body at an already accepted version.
3. Verify the wallet's bundled snapshots against the published wallet-config
   copies, and ship the reader. A missing new endpoint leaves cached/bundled data
   intact but cannot deliver new registrations.
4. Keep wallet-explore available for older supported wallets. Mirror reviewed
   listing changes there while those versions remain supported, preserving one
   body per network/version across both sources. Do not delete or redirect it as
   part of this PR. Both catalogs are unsigned; repository merge authority remains
   the publication boundary.

The companion docs PR [docs #381](https://github.com/0xMiden/docs/pull/381) describes
the broader mini-app workflow; its historical migration gate needs updating after
this contract is accepted. This PR does not merge that documentation or release a wallet.
