import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EVM_RPCS,
  countdownErrors,
  duplicateKeys,
  evmRpc,
  isUsdcxDepositSource,
  parseBridgeConfig,
  parseBridgeConfigDetailed,
  plannedChecks,
  smokeTest,
  swapErrors,
  switchErrors,
  validateFile,
  versionError
} from './validate.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (dir, name) => JSON.parse(readFileSync(path.join(FIXTURES, dir, name), 'utf8'));
const fixtureNames = dir => readdirSync(path.join(FIXTURES, dir)).filter(name => name.endsWith('.json'));
const testnet = () => readFixture('good', 'testnet-full.json');

describe('fixtures', () => {
  for (const name of fixtureNames('good')) {
    it(`accepts good/${name}`, () => {
      const { config, errors } = parseBridgeConfigDetailed(readFixture('good', name), 'testnet');
      assert.deepEqual(errors, []);
      assert.notEqual(config, null);
      assert.deepEqual(switchErrors(config), []);
      assert.deepEqual(swapErrors(config), []);
      assert.deepEqual(countdownErrors(readFixture('good', name)), []);
    });
  }

  for (const name of fixtureNames('bad')) {
    it(`refuses bad/${name} for its stated reason`, () => {
      const body = readFixture('bad', name);
      const { config, errors } = parseBridgeConfigDetailed(body, 'testnet');
      const reasons = config === null ? errors : [...switchErrors(config), ...swapErrors(config), ...countdownErrors(body)];
      assert.ok(reasons.includes(body._expect), `expected "${body._expect}", got ${JSON.stringify(reasons)}`);
    });
  }
});

describe('validateFile', () => {
  for (const name of ['swap-tokens-one.json', 'swap-tokens-without-eta-url.json', 'countdown-impossible-day.json', 'countdown-on-without-launch-at.json']) {
    it(`enforces publication policy in bad/${name}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'wallet-config-validate-'));
      try {
        copyFileSync(path.join(FIXTURES, 'bad', name), path.join(root, 'testnet.json'));
        const { errors } = await validateFile('testnet.json', { root, smoke: false });
        assert.deepEqual(errors, [readFixture('bad', name)._expect]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('parseBridgeConfig', () => {
  it('refuses a body that is not an object', () => {
    for (const body of [null, [], 'testnet', 1]) assert.equal(parseBridgeConfig(body, 'testnet'), null);
  });

  it('lowercases addresses and ids and strips trailing slashes', () => {
    const body = testnet();
    body.epoch.allocatorUrl = 'https://testnet-dev.epochprotocol.xyz//';
    body.agglayer.midenBridge = '0x3B66E20B5088F25133B69216484652';
    const config = parseBridgeConfig(body, 'testnet');
    assert.equal(config.epoch.evmUsdc, '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69');
    assert.equal(config.agglayer.midenBridge, '0x3b66e20b5088f25133b69216484652');
    assert.equal(config.epoch.allocatorUrl, 'https://testnet-dev.epochprotocol.xyz');
    assert.equal(config.agglayer.indexerUrl, 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api');
  });

  it('returns a URL as its origin and path, the way the wallet does', () => {
    const body = testnet();
    body.epoch.allocatorUrl = 'https://Testnet-Dev.EpochProtocol.xyz:443/v1//';
    assert.equal(parseBridgeConfig(body, 'testnet').epoch.allocatorUrl, 'https://testnet-dev.epochprotocol.xyz/v1');
  });

  it('accepts local http only when asked to, the way an E2E build does', () => {
    const body = { network: 'localnet', version: 1, epoch: { allocatorUrl: 'http://127.0.0.1:8548' } };
    assert.equal(parseBridgeConfig(body, 'localnet'), null);
    assert.equal(
      parseBridgeConfig(body, 'localnet', { allowLocalHttp: true }).epoch.allocatorUrl,
      'http://127.0.0.1:8548'
    );
    body.epoch.allocatorUrl = 'http://localhost:8548/';
    assert.equal(
      parseBridgeConfig(body, 'localnet', { allowLocalHttp: true }).epoch.allocatorUrl,
      'http://localhost:8548'
    );
    body.epoch.allocatorUrl = 'http://example.com';
    assert.equal(parseBridgeConfig(body, 'localnet', { allowLocalHttp: true }), null);
  });

  it('drops an unsupported chain, protocol, logo or price symbol instead of refusing the document', () => {
    const { config, dropped } = parseBridgeConfigDetailed(
      readFixture('good', 'testnet-unsupported-values.json'),
      'testnet'
    );
    assert.equal(config.evm.chainId, undefined);
    assert.equal(config.epoch.earnProtocol, undefined);
    assert.deepEqual(config.swap.tokens[0], { symbol: 'ISOL', faucetId: '0x750052a4af10cd51141f52c0ec2ada', decimals: 8 });
    assert.equal(dropped.length, 4);
  });

  it('reads a missing switch, or a missing features section, as off', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-minimal.json'), 'testnet');
    assert.deepEqual(config.features, {
      earn: false,
      fastBridge: false,
      bridgeIn: false,
      bridgeOut: false,
      usdcxIn: false,
      usdcxOut: false
    });
    assert.deepEqual(config.agglayer, { l1Bridge: undefined, midenBridge: undefined, indexerUrl: undefined });
  });

  it('reads the swap tokens in order, lowercasing faucet ids, and a missing swap section as no tokens', () => {
    const config = parseBridgeConfig(testnet(), 'testnet');
    assert.deepEqual(
      config.swap.tokens.map(token => token.symbol),
      ['IMIDEN', 'IETH', 'IUSDT', 'IBTC']
    );
    assert.deepEqual(config.swap.tokens[1], {
      symbol: 'IETH',
      faucetId: '0xe33498f1176661512b5ac4ded86ec7',
      decimals: 8,
      logo: 'ETH',
      priceSymbol: 'ETH'
    });
    assert.deepEqual(config.swap.tokens[0].priceSymbol, undefined);
    assert.equal(config.swap.etaUrl, 'https://35-175-40-181.sslip.io');
    assert.deepEqual(parseBridgeConfig(readFixture('good', 'testnet-minimal.json'), 'testnet').swap, {
      tokens: [],
      etaUrl: undefined
    });
  });

  it('reads a missing mainnetCountdown section as off with no moment', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-minimal.json'), 'testnet');
    assert.deepEqual(config.mainnetCountdown, { enabled: false });
  });

  it('keeps bridge config and turns off an invalid countdown, as the wallet does', () => {
    const body = testnet();
    body.mainnetCountdown = { enabled: true, launchAt: '2026-02-30T00:00:00Z' };
    const { config, errors } = parseBridgeConfigDetailed(body, 'testnet');
    assert.deepEqual(errors, []);
    assert.notEqual(config, null);
    assert.deepEqual(config.mainnetCountdown, { enabled: false });
  });

  it('reads the countdown switch and its moment', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-countdown.json'), 'testnet');
    assert.deepEqual(config.mainnetCountdown, { enabled: true, launchAt: Date.parse('2026-10-26T00:00:00Z') });
  });

  it('turns off a countdown moment in any spelling but RFC 3339 UTC', () => {
    for (const launchAt of ['2026-10-26', '2026-10-26T00:00:00+02:00', '2026-10-26 00:00:00Z', 1_792_000_000_000, '2026-13-40T00:00:00Z', '2026-02-30T00:00:00Z']) {
      const body = { network: 'testnet', version: 1, mainnetCountdown: { enabled: true, launchAt } };
      const { config, errors } = parseBridgeConfigDetailed(body, 'testnet');
      assert.deepEqual(errors, []);
      assert.deepEqual(config.mainnetCountdown, { enabled: false });
      assert.ok(countdownErrors(body).some(e => e.startsWith('mainnetCountdown.launchAt must be')), `${launchAt}`);
    }
  });

  it('accepts a countdown moment with fractional seconds', () => {
    const body = { network: 'testnet', version: 1, mainnetCountdown: { enabled: true, launchAt: '2026-10-26T00:00:00.000Z' } };
    assert.equal(parseBridgeConfig(body, 'testnet').mainnetCountdown.launchAt, Date.parse('2026-10-26T00:00:00.000Z'));
  });

  it('reads a missing onboarding section, or one without inviteOnly, as no Welcome choice', () => {
    assert.deepEqual(parseBridgeConfig(readFixture('good', 'testnet-minimal.json'), 'testnet').onboarding, {});
    const body = { network: 'testnet', version: 1, onboarding: {} };
    assert.deepEqual(parseBridgeConfig(body, 'testnet').onboarding, {});
  });

  it('reads the invite-only switch either way', () => {
    assert.deepEqual(parseBridgeConfig(readFixture('good', 'testnet-onboarding.json'), 'testnet').onboarding, {
      inviteOnly: true
    });
    const body = { network: 'testnet', version: 1, onboarding: { inviteOnly: false } };
    assert.deepEqual(parseBridgeConfig(body, 'testnet').onboarding, { inviteOnly: false });
  });
});

describe('usdcx', () => {
  const usdcx = () => readFixture('good', 'testnet-usdcx.json');

  it('reads a missing usdcx section as not configured', () => {
    assert.equal(parseBridgeConfig(readFixture('good', 'testnet-minimal.json'), 'testnet').usdcx, undefined);
  });

  it('keeps the chains in the document order, lowercases addresses and strips a trailing slash', () => {
    const config = parseBridgeConfig(usdcx(), 'testnet');
    assert.deepEqual(
      config.usdcx.chains.map(chain => chain.name),
      ['arc-testnet', 'sepolia', 'base-sepolia', 'arbitrum-sepolia']
    );
    assert.equal(config.usdcx.midenDomain, 10007);
    assert.equal(config.usdcx.attestationUrl, 'https://xreserve-api-testnet.circle.com');
    assert.equal(config.usdcx.irisUrl, 'https://iris-api-sandbox.circle.com');
    assert.deepEqual(config.usdcx.chains[0], {
      name: 'arc-testnet',
      chainId: 5042002,
      domain: 26,
      usdc: '0x3600000000000000000000000000000000000000',
      deposit: { route: 'xreserve', xReserve: '0x008888878f94c0d87defdf0b07f46b93c1934442' },
      executor: {
        address: '0xedc81040756accff070c21d37b265b9d0b5ba45e',
        handler: '0xd05e7d2e7d30b92c5f17d7d0fc575fce231f1a48'
      }
    });
    assert.equal(config.usdcx.chains[1].domain, 0);
    assert.ok(config.usdcx.chains.every(chain => isUsdcxDepositSource(config.usdcx, chain)));
  });

  it('drops an unsupported chain and an unknown route instead of refusing the document', () => {
    const { config, dropped } = parseBridgeConfigDetailed(
      readFixture('good', 'testnet-usdcx-unsupported-values.json'),
      'testnet'
    );
    assert.deepEqual(
      config.usdcx.chains.map(chain => chain.name),
      ['arc-testnet', 'sepolia']
    );
    assert.equal(config.usdcx.chains[1].deposit, undefined);
    assert.equal(isUsdcxDepositSource(config.usdcx, config.usdcx.chains[1]), false);
    assert.equal(dropped.length, 2);
  });

  it('counts an unsupported chain in the duplicate chain id and the one-executor rules, as the wallet does', () => {
    const body = usdcx();
    body.usdcx.chains.ethereum = { chainId: 1, domain: 0, usdc: body.usdcx.chains.sepolia.usdc };
    body.usdcx.chains.mainnet = { chainId: 1, domain: 0, usdc: body.usdcx.chains.sepolia.usdc };
    assert.deepEqual(parseBridgeConfigDetailed(body, 'testnet').errors, ['usdcx.chains names chain id 1 twice']);
    delete body.usdcx.chains.mainnet;
    body.usdcx.chains.ethereum.deposit = body.usdcx.chains['arc-testnet'].deposit;
    body.usdcx.chains.ethereum.executor = body.usdcx.chains['arc-testnet'].executor;
    assert.deepEqual(parseBridgeConfigDetailed(body, 'testnet').errors, [
      'usdcx.chains must name at most one chain with an executor'
    ]);
  });

  it('refuses an executor on a chain whose route the wallet does not know', () => {
    const body = usdcx();
    body.usdcx.chains['arc-testnet'].deposit = { route: 'teleport' };
    assert.deepEqual(parseBridgeConfigDetailed(body, 'testnet').errors, [
      'usdcx.chains.arc-testnet.executor is valid only on a chain whose deposit.route is "xreserve"'
    ]);
  });

  it('accepts the bounds of a domain and refuses a null where a value is required', () => {
    const body = usdcx();
    body.usdcx.midenDomain = 0xffffffff;
    body.usdcx.chains.sepolia.domain = 0;
    assert.notEqual(parseBridgeConfig(body, 'testnet'), null);
    for (const edit of [
      b => (b.usdcx.midenDomain = null),
      b => (b.usdcx.midenDomain = -1),
      b => (b.usdcx.midenDomain = 1.5),
      b => (b.usdcx.attestationUrl = null),
      b => (b.usdcx.irisUrl = 'https://iris-api-sandbox.circle.com?key=1'),
      b => (b.usdcx.chains = null),
      b => (b.usdcx.chains.sepolia = null),
      b => (b.usdcx.chains.sepolia.chainId = 0),
      b => (b.usdcx.chains.sepolia.deposit = null),
      b => (b.usdcx.chains['arc-testnet'].executor = null),
      b => delete b.usdcx.chains['arc-testnet'].executor.handler,
      b => (b.usdcx.chains['base--sepolia'] = { chainId: 10, domain: 2, usdc: b.usdcx.chains.sepolia.usdc }),
      b => (b.usdcx.chains[''] = { chainId: 10, domain: 2, usdc: b.usdcx.chains.sepolia.usdc }),
      b => (b.usdcx = null)
    ]) {
      const edited = usdcx();
      edit(edited);
      assert.equal(parseBridgeConfig(edited, 'testnet'), null, edit.toString());
    }
  });

  it('needs the Iris API and the executor chain for an executor deposit', () => {
    const body = usdcx();
    delete body.usdcx.irisUrl;
    const config = parseBridgeConfig(body, 'testnet');
    assert.deepEqual(
      config.usdcx.chains.filter(chain => isUsdcxDepositSource(config.usdcx, chain)).map(chain => chain.name),
      ['arc-testnet']
    );
    assert.deepEqual(switchErrors(config), []);
    const noExecutor = usdcx();
    delete noExecutor.usdcx.chains['arc-testnet'];
    assert.deepEqual(switchErrors(parseBridgeConfig(noExecutor, 'testnet')), [
      'features.usdcxIn is on but usdcx.chains[].deposit is missing or unsupported'
    ]);
  });

  it('finds a key that an object names twice, only at the path it is asked about', () => {
    const text = `{
      "swap": { "tokens": [{ "a": 1, "a": 2 }] },
      "usdcx": {
        "note": "a \\"quoted\\" } brace",
        "chains": {
          "sepolia": { "chainId": 1, "deposit": { "route": "x", "route": "y" } },
          "arc-testnet": { "chainId": 2 },
          "sepolia": { "chainId": 3 }
        }
      }
    }`;
    assert.deepEqual(duplicateKeys(text, ['usdcx', 'chains']), ['sepolia']);
    assert.deepEqual(duplicateKeys(text, ['usdcx', 'chains', 'sepolia', 'deposit']), ['route']);
    assert.deepEqual(duplicateKeys(text, ['usdcx']), []);
    assert.deepEqual(duplicateKeys(readFileSync(path.join(FIXTURES, 'good', 'testnet-usdcx.json'), 'utf8'), ['usdcx', 'chains']), []);
    assert.deepEqual(duplicateKeys('{"usdcx":{"chains":{"a":{},"a":[],"b":1,"a":null}}}', ['usdcx', 'chains']), ['a']);
  });

  it('refuses a document that names one chain twice, which JSON.parse hides', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wallet-config-validate-'));
    try {
      const text = readFileSync(path.join(FIXTURES, 'good', 'testnet-usdcx-staged.json'), 'utf8');
      const renamed = text.replace('"arc-testnet"', '"sepolia"');
      assert.notEqual(renamed, text);
      writeFileSync(path.join(root, 'testnet.json'), renamed);
      const { errors } = await validateFile('testnet.json', { root, smoke: false });
      assert.deepEqual(errors, ['usdcx.chains names chain "sepolia" twice']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('versionError', () => {
  const base = JSON.stringify({ network: 'testnet', version: 3 });
  it('passes an unchanged file and a new file', () => {
    assert.equal(versionError(base, 3, base), null);
    assert.equal(versionError(base, 1, null), null);
  });
  it('refuses a changed file that keeps or lowers the version', () => {
    const changed = JSON.stringify({ network: 'testnet', version: 3, features: {} });
    assert.match(versionError(changed, 3, base), /greater than 3/);
    assert.match(versionError(changed, 2, base), /greater than 3/);
  });
  it('passes a changed file with a higher version', () => {
    assert.equal(versionError(JSON.stringify({ version: 4 }), 4, base), null);
  });
});

describe('evmRpc', () => {
  it('falls back to the next RPC when one fails', async () => {
    const seen = [];
    const fetchImpl = async url => {
      seen.push(url);
      if (seen.length === 1) throw new Error('down');
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0xaa36a7' });
    };
    assert.equal(await evmRpc(11155111, 'eth_chainId', [], fetchImpl), '0xaa36a7');
    assert.equal(seen.length, 2);
  });
  it('fails only when every RPC fails', async () => {
    await assert.rejects(
      evmRpc(11155111, 'eth_chainId', [], async () => Response.json({ error: { message: 'no' } })),
      /no RPC/
    );
  });
});

describe('plannedChecks', () => {
  it('plans nothing while every switch is off, so values can be staged', () => {
    assert.deepEqual(plannedChecks(parseBridgeConfig(readFixture('good', 'testnet-staged.json'), 'testnet')), []);
  });
  it('plans only the Agglayer checks for bridge out', () => {
    const config = parseBridgeConfig(testnet(), 'testnet');
    config.features = { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: true };
    const kinds = plannedChecks(config).map(check => check.key);
    assert.ok(kinds.includes('indexer'));
    assert.ok(kinds.includes('l1-network-id'));
    assert.ok(!kinds.includes('allocator'));
  });
  it('plans no USDCx check while both USDCx switches are off', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-usdcx-staged.json'), 'testnet');
    assert.deepEqual(plannedChecks(config), []);
  });
  it('plans only the USDC contract of each destination for a withdrawal', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-usdcx-staged.json'), 'testnet');
    config.features.usdcxOut = true;
    assert.deepEqual(
      plannedChecks(config).map(check => check.label),
      ['USDCx arc-testnet RPC', 'USDCx arc-testnet USDC', 'USDCx sepolia RPC', 'USDCx sepolia USDC']
    );
  });
  it('plans the deposit contracts of each source, and the executor, for a deposit', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-usdcx-staged.json'), 'testnet');
    config.features.usdcxIn = true;
    assert.deepEqual(
      plannedChecks(config).map(check => check.label),
      [
        'USDCx arc-testnet RPC',
        'USDCx arc-testnet USDC',
        'USDCx arc-testnet xReserve',
        'USDCx arc-testnet executor',
        'USDCx arc-testnet executor handler',
        'USDCx sepolia RPC',
        'USDCx sepolia USDC',
        'USDCx sepolia TokenMessenger',
        'USDCx sepolia TokenMessenger with fees'
      ]
    );
    // Without the Iris API the executor route is not usable, so nothing reads its contracts.
    config.usdcx.irisUrl = undefined;
    assert.deepEqual(
      plannedChecks(config).map(check => check.label),
      ['USDCx arc-testnet RPC', 'USDCx arc-testnet USDC', 'USDCx arc-testnet xReserve']
    );
  });
});

/** A fake world in which every service and chain answers like testnet does. */
function testnetWorld({ emptyCode = false, allocatorStatus = 'healthy' } = {}) {
  return async (url, init) => {
    const target = String(url);
    if (target.endsWith('/health') && target.includes('positions')) return Response.json({ ok: true });
    if (target.endsWith('/health')) return Response.json({ status: allocatorStatus, allocatorAddresses: {} });
    if (target.endsWith('/healthz')) return Response.json({ status: 'SERVING' });
    const { method } = JSON.parse(init.body);
    if (method === 'eth_chainId') return Response.json({ result: '0xaa36a7' });
    if (method === 'eth_getCode') return Response.json({ result: emptyCode ? '0x' : '0x6080' });
    return Response.json({ result: `0x${'0'.repeat(62)}12` });
  };
}

describe('smokeTest', () => {
  it('passes every check against a healthy deployment', async () => {
    const results = await smokeTest(parseBridgeConfig(testnet(), 'testnet'), testnetWorld());
    assert.deepEqual(
      results.filter(result => !result.ok),
      []
    );
    assert.equal(results.length, 8);
  });
  it('fails a contract with no code', async () => {
    const results = await smokeTest(parseBridgeConfig(testnet(), 'testnet'), testnetWorld({ emptyCode: true }));
    assert.ok(results.some(result => !result.ok && /has no code/.test(result.detail)));
  });
  it('fails an allocator whose /health does not say healthy', async () => {
    // The wallet's own rule (derive.ts): an object body with status 'healthy'; allocatorAddresses alone is not enough.
    const world = testnetWorld({ allocatorStatus: 'degraded' });
    const results = await smokeTest(parseBridgeConfig(testnet(), 'testnet'), world);
    assert.ok(results.some(result => !result.ok && result.label === 'Epoch allocator'));
  });

  /** A fake world in which each RPC answers for its own chain, and `empty` lists addresses with no code. */
  function usdcxWorld({ empty = [] } = {}) {
    const chainOf = url => Object.keys(EVM_RPCS).find(chainId => EVM_RPCS[chainId].includes(String(url)));
    return async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method === 'eth_chainId') return Response.json({ result: `0x${Number(chainOf(url)).toString(16)}` });
      return Response.json({ result: empty.includes(`${chainOf(url)}:${params[0]}`) ? '0x' : '0x6080' });
    };
  }
  const usdcxOnly = () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-usdcx.json'), 'testnet');
    config.features = { usdcxIn: true, usdcxOut: true };
    return config;
  };

  it('reads each USDCx contract on its own chain', async () => {
    const results = await smokeTest(usdcxOnly(), usdcxWorld());
    assert.deepEqual(
      results.filter(result => !result.ok),
      []
    );
    // Four chains: RPC and USDC each. Arc: xReserve, executor, handler. Three chains: two TokenMessengers each.
    assert.equal(results.length, 8 + 3 + 6);
  });
  it('fails a USDCx contract with no code on its chain only', async () => {
    const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
    const results = await smokeTest(usdcxOnly(), usdcxWorld({ empty: [`84532:${usdc}`] }));
    assert.deepEqual(
      results.filter(result => !result.ok),
      [{ label: 'USDCx base-sepolia USDC', ok: false, detail: `${usdc} has no code on chain 84532` }]
    );
  });
});
