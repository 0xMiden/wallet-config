# icons

Earn vault logos. An `earn.vaults` entry names one with `logo`
(`icons/<name>.svg` or `icons/<name>.png`), and the wallet fetches it from the
directory of the document. `scripts/validate.mjs` checks each file (see
[Earn vaults](../README.md#earn-vaults)).

Each mark is the owner's vector artwork. Only the root changed: the `viewBox` is
made square around the mark, and the fixed `width` and `height` are removed.
The path data is the same as in the source.

| File           | Source                                                                                                                                                                                                                   | Notes                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `aave.svg`     | The Aave mark the wallet bundles (`src/app/icons/earn-provider-logos/aave.svg` in `0xMiden/miden-wallet`).                                                                                                                | The style attributes that repeated the fill are removed.                                                                                  |
| `compound.svg` | Compound Labs' `compound-components`, [`src/public/assets/compound-mark.svg`](https://github.com/compound-finance/compound-components/blob/e98d0b5626c14a31a5a03fd3c87c97db4af8c703/src/public/assets/compound-mark.svg). | The repository has no licence file.                                                                                                       |
| `morpho.svg`   | Morpho's brand kit at [brand.morpho.org](https://brand.morpho.org): [`morpho-logo.zip`](https://cdn.morpho.org/assets/brand-kit/morpho-logo.zip), `Morpho Logos/SVG/Morpho-logo-symbol-lightmode.svg`.                    | The clip path, which clipped nothing, is removed. The brand kit states no licence. No listed vault uses this logo yet.                     |

The marks are trademarks of their owners. The wallet shows them only to name
the protocol of a vault.
