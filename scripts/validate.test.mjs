import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  countdownErrors,
  evmRpc,
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
    assert.deepEqual(config.features, { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false });
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
});
