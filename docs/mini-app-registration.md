# Mini-app registration

Use this repository as the review destination for new Bread mini-app registration.
Games, financial apps and financial utilities, learning content, NFTs and other
tools follow a common process, with acceptance checks specific to their behavior.

Registration is a review and catalog workflow. It is separate from a hosted demo,
build completion, pilot approval, public listing and user wallet permissions.
There is no registration API supplied by the wallet adapter.

## Current activation gate

Bread 1.17.3's [Explore reader](https://github.com/0xMiden/wallet/blob/v1.17.3/src/lib/explore-config/source.ts)
still loads per-network catalogs from [wallet-explore](https://github.com/0xMiden/wallet-explore).
This repository currently validates bridge, swap and onboarding configuration;
it has no accepted mini-app catalog schema or file layout.

Before encoding or activating an app registration here, maintainers must establish
the catalog layout/validator, migrate existing catalog entries, and release the
matching reader. Keep a candidate's metadata and evidence ready for review while
activation is blocked. Do not add an invented `apps` field, endpoint or category
to a current network document: an ignored field cannot register an app, and an
unsupported catalog value can make a wallet retain its previous catalog.

This guide documents the intended registration process. It adds no catalog data,
runtime parser, submission service, wallet release or automatic approval.

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
| Placement | Requested Finance, Arcade or Others group and the compatible current serialized category. All is an aggregate view, not a submitted category. |
| Compatibility | Network, account types, exact tested Bread versions/platforms and dependency/contract versions. |
| Capabilities | Minimal wallet/private-data access, backend/API origins, collected data and public/on-chain disclosures. |
| Presentation | Ordinary layout or optional native fullscreen; readiness, safe areas, rotation and Back to Bread behavior tested on the target build. |
| Acceptance | Successful core journey, refusal, unsupported capabilities, account/network changes, repeated taps, timeout/reload and recovery evidence. |
| Operations | Reachable maintainer, incident/support and rollback route, applicable privacy/terms and unresolved gates. |

Use the accepted catalog validator for field limits and paths. The current
wallet-explore schema is a compatibility reference, not permission to invent
this repository's future catalog layout.

## Games, finance and the native Arcade direction

[Wallet issue 1452](https://github.com/0xMiden/wallet/issues/1452) confirms native
Explore with **All, Finance, Arcade, Others**, in that order. Finance contains
financial apps and financial utilities; Arcade contains games and a custom native
view; Others contains remaining utilities, NFTs and learning. Games continue to
launch through the existing dApp browser. The earlier external Arcade-site
proposal is superseded.

The current catalog values remain `tools`, `defi`, `games`, `nft` and `learn` until
a compatible mapping or coordinated migration is implemented. Preserve existing
entries, network selection, search, recents and platform gates. Review utility
classification into Finance or Others; do not change serialized values ahead of
their parser. Target tabs do not establish new JSON fields.

Games must describe deterministic scoring, any public result data and the reviewed
challenge protocol they use. Record/shot notes, common Game Coin, shared ranking,
prizes and reward eligibility are separate unresolved product/contract decisions.
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
2. Confirm the accepted catalog schema, migration and reader-release plan. Keep
   activation explicitly blocked when these are absent.
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
