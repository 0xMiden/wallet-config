# Mini-app registration

Use this repository as the review destination for new Bread mini-app registration.
Games, financial apps and financial utilities, learning content, NFTs and other
tools follow a common process, with acceptance checks specific to their behavior.

Registration is a review and catalog workflow. It is separate from a hosted demo,
build completion, pilot approval, public listing and user wallet permissions.
There is no registration API supplied by the wallet adapter.

## Catalog and activation gate

Bread 1.17.3's [Explore reader](https://github.com/0xMiden/wallet/blob/v1.17.3/src/lib/explore-config/source.ts)
still loads per-network catalogs from [wallet-explore](https://github.com/0xMiden/wallet-explore).
This PR adds the compatible catalog at `explore/<network>.json`, its icons and a
validator. See [Explore catalog](explore-catalog.md) for the exact schema and
publication rules. Existing entries and URLs are preserved; categories match the
three Explore tabs directly, with higher devnet/testnet document versions.
The matching reader is in [wallet PR #1512](https://github.com/0xMiden/wallet/pull/1512).
Catalog publication here reaches only wallets released with that reader; merging
these files alone does not move existing wallets off wallet-explore.

Register a reviewed app by editing the appropriate Explore catalog and bumping
its version. Use `finance`, `arcade` or `others` as the category; All is an aggregate.
Do not add an `apps` field to the root bridge/swap documents. An unavailable
production URL belongs in the candidate record, not in an active catalog item.
There is no registration API, automatic approval or leaderboard submission service.

## Prepare the candidate

Create or update the app's entry in the team's
[Miniapps record](https://app.notion.com/p/3f199411cf9081a38769e248b0f1d347).
The existing fields are Title, Production URL, Github URL, Description and Owner;
put the remaining evidence in the entry body. Leave an unavailable production
URL blank and explain the limitation.

Collect these facts before opening the catalog registration PR:

| Item | Evidence to provide |
|---|---|
| App identity | Stable proposed ID, name, useful short description, publisher/owner and support route. |
| Deployment | Intended HTTPS launch/review URLs, source/review access, app commit and deployed release identifier. Label demonstrations explicitly. |
| Placement | `finance`, `arcade` or `others`, matching the intended native Explore tab. All is an aggregate view, not a submitted category. |
| Compatibility | Network, account types, exact tested Bread versions/platforms and dependency/contract versions. |
| Capabilities | Minimal wallet/private-data access, backend/API origins, collected data and public/on-chain disclosures. |
| Presentation | Ordinary layout or optional native fullscreen; readiness, safe areas, rotation and Back to Bread behavior tested on the target build. |
| Acceptance | Successful core journey, refusal, unsupported capabilities, account/network changes, repeated taps, timeout/reload and recovery evidence. |
| Operations | Reachable maintainer, incident/support and rollback route, applicable privacy/terms and unresolved gates. |

Use `node scripts/validate-explore.mjs` for field limits, network, version and icon
checks. The schema preserves wallet-explore compatibility; see the catalog guide.

## Games, finance and the native Arcade direction

[Wallet issue 1452](https://github.com/0xMiden/wallet/issues/1452) confirms native
Explore with **All, Finance, Arcade, Others**, in that order. Finance contains
financial apps and financial utilities; Arcade contains games and a custom native
view; Others contains remaining utilities, NFTs and learning. Games continue to
launch through the existing dApp browser. The earlier external Arcade-site
proposal is superseded.

Published category values are `finance`, `arcade` and `others`. The matching wallet
reader and bundled snapshots change together; legacy cache reading is a separate
upgrade path. Preserve entries, network selection, search, recents and platform
gates. Put financial helpers in Finance and other utilities in Others. Older
released wallets keep their legacy wallet-explore schema until they upgrade.

Games must describe their own scoring, any public result data and any reviewed
challenge protocol they use. Game-specific rankings belong to the game. The native
wallet's intended shared ranking uses only GC balances that players explicitly
choose to submit. The GC asset, private-balance verification and submission
service are not supplied by this catalog migration. Record/shot notes, prizes
and reward eligibility remain separate product/contract decisions.
A valid replay does not prove human play. Label fixture rankings, fictional
challenges and browser-local submission drafts clearly.

Financial mini-apps must identify their supported asset/issuer, provider or route,
fees, settlement/receiving steps and claim/recovery behavior. A token symbol,
wallet connection, quote or healthy endpoint is insufficient route acceptance.
Do not incentivize extra financial actions or expose private balances as ranking
data. Registration grants no admission, liquidity, funds or payment authority.

Native Bread 1.17.3 introduced optional
[fullscreen presentation](https://github.com/0xMiden/wallet/blob/v1.17.3/docs/dapp-fullscreen.md).
It changes layout and the return control only. Extension tabs and ordinary
browsers need their own responsive layout/provider checks. Opening, connecting,
private-data permission and transaction approval remain separate.

## Review and activation

1. Record the candidate and assemble the metadata and test evidence above.
2. Confirm the catalog schema and the matching reader-release plan. Keep activation
   blocked on platforms that still read wallet-explore.
3. Open a registration PR against `main` with the accepted catalog changes,
   localization/icon/placement, required version bump and validation evidence.
   Preserve unrelated network configuration. Link the candidate record.
4. Obtain the required product and engineering/security reviews, plus relevant
   platform/privacy and financial-route or game-contract acceptance. Record the
   reviewers and the exact deployment/origin/network they approved.
5. After merge and the matching reader release, verify refresh, category placement,
   the actual launch URL, wallet capability/approval behavior and recovery on the
   claimed physical iOS/Android or extension build. A merge alone is insufficient.
6. Save the PR and acceptance evidence in the app entry. Describe the actual state
   as candidate, blocked, reviewed/pilot or listed; do not mark a local draft as a
   completed submission or listing.

Use a new reviewed change for a material deployment/origin, permission, network,
contract or monetization update. Removing a listing does not cancel an already
submitted transaction or erase the application's recovery responsibilities.
