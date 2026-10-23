import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  baseText,
  EXPLORE_CATEGORIES,
  EXPLORE_LOCALES,
  EXPLORE_SECTION_KINDS,
  iconError,
  RESERVED_SECTION_IDS,
  parseExploreConfig,
  parseExploreConfigDetailed,
  validateFile,
  versionError
} from './validate-explore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'explore-fixtures');
const REPO_ROOT = path.resolve(HERE, '..');
const readFixture = (dir, name) => JSON.parse(readFileSync(path.join(FIXTURES, dir, name), 'utf8'));
const fixtureNames = dir => readdirSync(path.join(FIXTURES, dir)).filter(name => name.endsWith('.json'));

const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'wallet-explore-'));
const write = (root, file, content) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The first 24 bytes are all the check reads: the signature, then an IHDR chunk of length 13 giving width and height.
const png = (width, height, size = 64) => {
  const bytes = Buffer.alloc(size);
  PNG_SIGNATURE.copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

describe('fixtures', () => {
  for (const name of fixtureNames('good')) {
    it(`accepts good/${name}`, () => {
      const { catalog, errors } = parseExploreConfigDetailed(readFixture('good', name), 'testnet');
      assert.deepEqual(errors, []);
      assert.notEqual(catalog, null);
    });
  }

  for (const name of fixtureNames('bad')) {
    it(`refuses bad/${name} for its stated reason`, () => {
      const body = readFixture('bad', name);
      const { catalog, errors } = parseExploreConfigDetailed(body, 'testnet');
      assert.equal(catalog, null);
      assert.ok(errors.includes(body._expect), `expected "${body._expect}", got ${JSON.stringify(errors)}`);
    });
  }
});

describe('parseExploreConfig', () => {
  it('refuses a body that is not an object', () => {
    for (const body of [null, [], 'testnet', 1]) assert.equal(parseExploreConfig(body, 'testnet'), null);
  });

  it('leaves out what the wallet does not know, and says so', () => {
    const { catalog, dropped } = parseExploreConfigDetailed(readFixture('good', 'testnet-unknown.json'), 'testnet');
    assert.deepEqual(
      catalog.items.map(item => item.id),
      ['faucet']
    );
    assert.deepEqual(catalog.items[0].name, { en: 'Faucet' });
    assert.deepEqual(catalog.sections, [
      { id: 'featured', kind: 'featured', title: { en: 'Featured' }, itemIds: ['faucet'] }
    ]);
    assert.deepEqual(dropped, [
      'items[0].name.it is not a wallet locale',
      'items[1] is in category "quests", which the wallet does not know',
      'sections[1] is of kind "carousel", which the wallet does not know'
    ]);
  });

  it('keeps a url exactly as written, query and fragment included', () => {
    const catalog = parseExploreConfig(readFixture('good', 'testnet-full.json'), 'testnet');
    assert.equal(catalog.items[1].url, 'https://swap.example/app?ref=wallet#start');
  });

  it('accepts local http only when asked to, the way an E2E build does', () => {
    const local = readFixture('bad', 'url-local-http.json');
    assert.equal(parseExploreConfig(local, 'testnet'), null);
    assert.equal(parseExploreConfig(local, 'testnet', { allowLocalHttp: true }).items[0].url, 'http://127.0.0.1:4173/');
    assert.equal(parseExploreConfig(readFixture('bad', 'url-http.json'), 'testnet', { allowLocalHttp: true }), null);
  });

  it('counts the caps in characters, not bytes or UTF-16 units', () => {
    const { items } = parseExploreConfig(readFixture('good', 'testnet-limits.json'), 'testnet');
    assert.equal(Array.from(items[0].name.en).length, 40);
    assert.equal(Array.from(items[0].tagline.en).length, 120);
  });

  it('knows the wallet locales, categories, section kinds and reserved section ids', () => {
    assert.deepEqual(EXPLORE_LOCALES, [
      'de',
      'en',
      'en_GB',
      'es',
      'fr',
      'ja',
      'ko',
      'pl',
      'pt',
      'ru',
      'tr',
      'uk',
      'zh_CN',
      'zh_TW'
    ]);
    assert.deepEqual(EXPLORE_CATEGORIES, ['finance', 'arcade', 'others']);
    assert.deepEqual(EXPLORE_SECTION_KINDS, ['featured', 'list']);
    assert.deepEqual(RESERVED_SECTION_IDS, ['recents', 'search-results']);
  });
});

describe('the published documents', () => {
  it('checks nested Explore catalogs by default, not root bridge documents', () => {
    const output = execFileSync(process.execPath, ['scripts/validate-explore.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, BASE_REF: '' }
    });
    assert.match(output, /explore\/devnet\.json/);
    assert.match(output, /explore\/testnet\.json/);
    assert.doesNotMatch(output, /mainnet\.json/);
  });

  for (const file of ['devnet.json', 'testnet.json']) {
    it(`validates ${file} and its icons`, () => {
      assert.deepEqual(validateFile(`explore/${file}`, { root: REPO_ROOT }), { errors: [], notes: [] });
    });
  }
});

describe('validateFile', () => {
  const doc = network => ({
    network,
    version: 1,
    items: [
      {
        id: 'faucet',
        name: { en: 'Faucet' },
        tagline: { en: 'Get tokens' },
        url: 'https://faucet.example/',
        category: 'finance',
        icon: 'icons/faucet.png',
        isExchange: false
      }
    ],
    sections: []
  });

  it('requires the network to be the file name', () => {
    const root = tempRoot();
    write(root, 'devnet.json', JSON.stringify(doc('testnet')));
    write(root, 'icons/faucet.png', png(64, 64));
    assert.deepEqual(validateFile('devnet.json', { root }).errors, ['network must be "devnet"']);
  });

  it('publishes only the three exact native categories, never legacy names or All', () => {
    for (const category of ['tools', 'defi', 'games', 'nft', 'learn', 'all', 'unknown']) {
      const root = tempRoot();
      const body = doc('testnet');
      body.items[0].category = category;
      write(root, 'testnet.json', JSON.stringify(body));
      write(root, 'icons/faucet.png', png(64, 64));
      assert.deepEqual(validateFile('testnet.json', { root }).errors, [
        'items[0].category must be finance, arcade or others (All is an aggregate)'
      ]);
    }
  });

  it('refuses a document larger than a wallet reads', () => {
    const root = tempRoot();
    write(root, 'testnet.json', JSON.stringify({ ...doc('testnet'), padding: 'x'.repeat(32 * 1024) }));
    write(root, 'icons/faucet.png', png(64, 64));
    assert.deepEqual(validateFile('testnet.json', { root }).errors, [
      'the document is larger than 32 KiB, the most a wallet reads'
    ]);
  });

  it('checks the icon of an item the wallet leaves out too', () => {
    const root = tempRoot();
    const body = doc('testnet');
    body.items[0].category = 'quests';
    write(root, 'testnet.json', JSON.stringify(body));
    assert.deepEqual(validateFile('testnet.json', { root }).errors, [
      'items[0].category must be finance, arcade or others (All is an aggregate)',
      'icons/faucet.png is missing'
    ]);
  });

  it('resolves icons under the catalog directory, never the root bridge directory', () => {
    const root = tempRoot();
    write(root, 'explore/testnet.json', JSON.stringify(doc('testnet')));
    write(root, 'icons/faucet.png', png(64, 64));
    assert.deepEqual(validateFile('explore/testnet.json', { root }).errors, ['icons/faucet.png is missing']);
    write(root, 'explore/icons/faucet.png', png(64, 64));
    assert.deepEqual(validateFile('explore/testnet.json', { root }).errors, []);
  });

  it('refuses catalog files or catalog directories reached through symlinks', () => {
    const root = tempRoot();
    write(root, 'actual/testnet.json', JSON.stringify(doc('testnet')));
    symlinkSync(path.join(root, 'actual'), path.join(root, 'explore'));
    assert.deepEqual(validateFile('explore/testnet.json', { root }).errors, [
      'explore/testnet.json is not a regular file'
    ]);
    symlinkSync(path.join(root, 'actual/testnet.json'), path.join(root, 'testnet.json'));
    assert.deepEqual(validateFile('testnet.json', { root }).errors, ['testnet.json is not a regular file']);
  });

  it('reports a file that is not JSON', () => {
    const root = tempRoot();
    write(root, 'testnet.json', '{');
    assert.match(validateFile('testnet.json', { root }).errors[0], /^not JSON: /);
  });
});

describe('versionError', () => {
  const base = JSON.stringify({ network: 'testnet', version: 3 });

  it('passes an unchanged file and a new file', () => {
    assert.equal(versionError(base, 3, base), null);
    assert.equal(versionError(base, 1, null), null);
  });

  it('refuses a changed file that keeps or lowers the version', () => {
    const changed = JSON.stringify({ network: 'testnet', version: 3, items: [] });
    assert.match(versionError(changed, 3, base), /greater than 3/);
    assert.match(versionError(changed, 2, base), /greater than 3/);
  });

  it('passes a changed file with a higher version', () => {
    assert.equal(versionError(JSON.stringify({ version: 4 }), 4, base), null);
  });
});

describe('iconError', () => {
  const rootWith = (file, content) => {
    const root = tempRoot();
    write(root, file, content);
    return root;
  };

  it('accepts a square PNG of 256x256 and exactly 32 KiB', () => {
    assert.equal(iconError(rootWith('icons/a.png', png(256, 256, 32 * 1024)), 'icons/a.png'), null);
  });

  it('refuses a missing icon', () => {
    assert.equal(iconError(tempRoot(), 'icons/a.png'), 'icons/a.png is missing');
  });

  it('refuses an icon that is a link, or reached through one, or a directory', () => {
    const linkedFile = rootWith('real/a.png', png(16, 16));
    mkdirSync(path.join(linkedFile, 'icons'));
    symlinkSync(path.join(linkedFile, 'real/a.png'), path.join(linkedFile, 'icons/a.png'));
    assert.equal(iconError(linkedFile, 'icons/a.png'), 'icons/a.png is not a regular file');

    const linkedDir = rootWith('real/a.png', png(16, 16));
    symlinkSync(path.join(linkedDir, 'real'), path.join(linkedDir, 'icons'));
    assert.equal(iconError(linkedDir, 'icons/a.png'), 'icons/a.png is not a regular file');

    const directory = tempRoot();
    mkdirSync(path.join(directory, 'icons/a.png'), { recursive: true });
    assert.equal(iconError(directory, 'icons/a.png'), 'icons/a.png is not a regular file');
  });

  it('refuses an icon over 32 KiB', () => {
    assert.equal(iconError(rootWith('icons/a.png', png(16, 16, 32 * 1024 + 1)), 'icons/a.png'), 'icons/a.png is larger than 32 KiB');
  });

  it('refuses a file that is not a PNG, or whose first chunk is not a 13-byte IHDR', () => {
    assert.equal(iconError(rootWith('icons/a.png', Buffer.from('GIF89a, not a PNG at all')), 'icons/a.png'), 'icons/a.png is not a PNG');
    const shortHeader = png(16, 16);
    shortHeader.writeUInt32BE(12, 8);
    assert.equal(iconError(rootWith('icons/a.png', shortHeader), 'icons/a.png'), 'icons/a.png is not a PNG');
  });

  it('refuses an image that is not square, or has no pixels', () => {
    assert.equal(iconError(rootWith('icons/a.png', png(32, 16)), 'icons/a.png'), 'icons/a.png is not square');
    assert.equal(iconError(rootWith('icons/a.png', png(0, 0)), 'icons/a.png'), 'icons/a.png is not square');
  });

  it('refuses an image larger than 256x256', () => {
    assert.equal(iconError(rootWith('icons/a.png', png(512, 512)), 'icons/a.png'), 'icons/a.png is larger than 256x256');
  });
});

describe('baseText and the base-ref version rule', () => {
  const git = (root, ...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  const document = (version, tagline) =>
    JSON.stringify({
      network: 'testnet',
      version,
      items: [
        {
          id: 'faucet',
          name: { en: 'Faucet' },
          tagline: { en: tagline },
          url: 'https://faucet.example/',
          category: 'finance',
          icon: 'icons/faucet.png',
          isExchange: false
        }
      ],
      sections: []
    });
  // A repository whose main branch holds testnet.json at version 1.
  const repoOnMain = () => {
    const root = tempRoot();
    git(root, 'init', '-b', 'main');
    write(root, 'testnet.json', document(1, 'Get tokens'));
    write(root, 'icons/faucet.png', png(64, 64));
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    return root;
  };

  it('returns no base when no ref is set', () => {
    assert.equal(baseText('', 'testnet.json', repoOnMain()), null);
    assert.equal(baseText(undefined, 'testnet.json', repoOnMain()), null);
  });

  it('returns the file as the ref holds it, and null for a file the ref lacks', () => {
    const root = repoOnMain();
    assert.equal(baseText('main', 'testnet.json', root), document(1, 'Get tokens'));
    assert.equal(baseText('main', 'devnet.json', root), null);
  });

  it('throws for a ref that does not resolve, instead of reading it as a new file', () => {
    assert.throws(() => baseText('origin/does-not-exist', 'testnet.json', repoOnMain()), /does not resolve to a commit/);
  });

  it('fails validateFile closed on an unresolvable ref, and passes the same file on a resolvable one that is a new file', () => {
    const root = repoOnMain();
    write(root, 'testnet.json', document(1, 'Changed tagline'));
    assert.deepEqual(validateFile('testnet.json', { root, baseRef: 'origin/does-not-exist' }).errors, [
      'BASE_REF origin/does-not-exist does not resolve to a commit, so the version rule cannot run'
    ]);
    write(root, 'devnet.json', document(1, 'Get tokens').replace('testnet', 'devnet'));
    assert.deepEqual(validateFile('devnet.json', { root, baseRef: 'main' }).errors, []);
  });

  it('requires a higher version for a changed file against a resolvable ref', () => {
    const root = repoOnMain();
    write(root, 'testnet.json', document(1, 'Changed tagline'));
    assert.match(validateFile('testnet.json', { root, baseRef: 'main' }).errors[0], /greater than 1/);
    write(root, 'testnet.json', document(2, 'Changed tagline'));
    assert.deepEqual(validateFile('testnet.json', { root, baseRef: 'main' }).errors, []);
    write(root, 'testnet.json', document(1, 'Get tokens'));
    assert.deepEqual(validateFile('testnet.json', { root, baseRef: 'main' }).errors, []);
  });

  it('compares the nested catalog version independently of the root document', () => {
    const root = repoOnMain();
    write(root, 'explore/testnet.json', document(2, 'Initial catalog'));
    write(root, 'explore/icons/faucet.png', png(64, 64));
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'catalog');
    write(root, 'explore/testnet.json', document(2, 'Changed launch metadata'));
    assert.match(validateFile('explore/testnet.json', { root, baseRef: 'main' }).errors[0], /greater than 2/);
    write(root, 'explore/testnet.json', document(3, 'Changed launch metadata'));
    assert.deepEqual(validateFile('explore/testnet.json', { root, baseRef: 'main' }).errors, []);
  });
});
