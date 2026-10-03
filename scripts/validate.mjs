#!/usr/bin/env node
/**
 * Validates the per-network documents the Miden wallet reads at runtime.
 *
 *   node scripts/validate.mjs                      # every <network>.json at the repo root
 *   node scripts/validate.mjs testnet.json         # one document
 *   node scripts/validate.mjs --no-smoke           # parse and version rules only, no network
 *   BASE_REF=origin/main node scripts/validate.mjs # also require a version bump against that ref
 *
 * Three layers, in order: the wallet's own parse rules (ported from the wallet's
 * src/lib/remote-config/schema.ts; the two must agree on every rule), the repo rules (file name,
 * version bump, a switched-on feature has every value it needs), and a deploy smoke test that, for
 * every switched-on feature, finds its Miden accounts and EVM contracts on chain and gets an answer
 * from its services' health routes. No dependencies: Node 22 only.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_SWITCHES = ['earn', 'fastBridge', 'bridgeIn', 'bridgeOut'];
export const SUPPORTED_EVM_CHAIN_IDS = [11155111];
export const SUPPORTED_EARN_PROTOCOLS = ['dummy-lending'];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;

/** Miden node per network, as the wallet's src/lib/miden-chain/networks-config.ts has it. */
export const MIDEN_RPC = {
  testnet: 'https://rpc.testnet.miden.io',
  devnet: 'https://rpc.devnet.miden.io'
};

/** Public RPCs per supported EVM chain, tried in order: one failing provider must not fail a deploy. */
export const EVM_RPCS = {
  11155111: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://1rpc.io/sepolia',
    'https://11155111.rpc.thirdweb.com'
  ]
};

const REGISTRY_SLOT = 'agglayer::bridge::faucet_registry_map';
const REQUEST_TIMEOUT_MS = 15_000;

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function readSection(body, name, errors) {
  const value = body[name];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push(`${name} must be an object`);
    return {};
  }
  return value;
}

function readPattern(section, label, field, pattern, kind, errors) {
  const value = section[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    errors.push(`${label}.${field} must be ${kind}`);
    return undefined;
  }
  return value.toLowerCase();
}

function readUrl(section, label, field, allowLocalHttp, errors) {
  const value = section[field];
  if (value === undefined) return undefined;
  const name = `${label}.${field}`;
  if (typeof value !== 'string') {
    errors.push(`${name} must be a URL string`);
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${name} is not a URL`);
    return undefined;
  }
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !(allowLocalHttp && local)) {
    errors.push(`${name} must use https:`);
    return undefined;
  }
  // The wallet appends routes to these (`${allocatorUrl}/health`), which a query or fragment would break.
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    errors.push(`${name} must not carry credentials, a query or a fragment`);
    return undefined;
  }
  // The wallet's form exactly (schema.ts baseUrl): lowercase host, no default port, no trailing slash.
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The wallet's `parseBridgeConfig`, with the reasons it rejects and the values it drops.
 * `config` is null exactly when the wallet would ignore the document.
 */
export function parseBridgeConfigDetailed(body, network, options = {}) {
  const allowLocalHttp = options.allowLocalHttp === true;
  const errors = [];
  const dropped = [];
  if (!isRecord(body)) return { config: null, errors: ['the document must be a JSON object'], dropped };

  if (typeof body.network !== 'string' || body.network !== network) {
    errors.push(`network must be "${network}"`);
  }
  const version = body.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    errors.push('version must be a positive safe integer');
  }

  const evmIn = readSection(body, 'evm', errors);
  const agglayerIn = readSection(body, 'agglayer', errors);
  const epochIn = readSection(body, 'epoch', errors);
  const featuresIn = readSection(body, 'features', errors);

  const evm = {};
  if (evmIn.chainId !== undefined) {
    const chainId = evmIn.chainId;
    if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) {
      errors.push('evm.chainId must be a positive safe integer');
    } else if (SUPPORTED_EVM_CHAIN_IDS.includes(chainId)) {
      evm.chainId = chainId;
    } else {
      dropped.push(`evm.chainId ${chainId} is not a chain the wallet supports (${SUPPORTED_EVM_CHAIN_IDS.join(', ')})`);
    }
  }

  const agglayer = {
    l1Bridge: readPattern(agglayerIn, 'agglayer', 'l1Bridge', EVM_ADDRESS, 'a 20-byte 0x address', errors),
    midenBridge: readPattern(
      agglayerIn,
      'agglayer',
      'midenBridge',
      MIDEN_ACCOUNT_ID,
      'a 15-byte 0x account id',
      errors
    ),
    indexerUrl: readUrl(agglayerIn, 'agglayer', 'indexerUrl', allowLocalHttp, errors)
  };

  const epoch = {
    allocatorUrl: readUrl(epochIn, 'epoch', 'allocatorUrl', allowLocalHttp, errors),
    positionsUrl: readUrl(epochIn, 'epoch', 'positionsUrl', allowLocalHttp, errors),
    midenUsdcFaucet: readPattern(
      epochIn,
      'epoch',
      'midenUsdcFaucet',
      MIDEN_ACCOUNT_ID,
      'a 15-byte 0x account id',
      errors
    ),
    evmUsdc: readPattern(epochIn, 'epoch', 'evmUsdc', EVM_ADDRESS, 'a 20-byte 0x address', errors),
    earnProtocol: undefined
  };
  if (epochIn.earnProtocol !== undefined) {
    if (typeof epochIn.earnProtocol !== 'string') {
      errors.push('epoch.earnProtocol must be a string');
    } else if (SUPPORTED_EARN_PROTOCOLS.includes(epochIn.earnProtocol)) {
      epoch.earnProtocol = epochIn.earnProtocol;
    } else {
      dropped.push(`epoch.earnProtocol "${epochIn.earnProtocol}" is not one the wallet supports`);
    }
  }

  const features = {};
  for (const name of BRIDGE_SWITCHES) {
    const value = featuresIn[name];
    if (value === undefined) features[name] = false;
    else if (typeof value === 'boolean') features[name] = value;
    else errors.push(`features.${name} must be true or false`);
  }

  if (errors.length > 0) return { config: null, errors, dropped };
  return { config: { network, version, evm, agglayer, epoch, features }, errors, dropped };
}

export function parseBridgeConfig(body, network, options) {
  return parseBridgeConfigDetailed(body, network, options).config;
}

/** What a switched-on feature needs from the document; a switch on without them is a mistake. */
export const FEATURE_REQUIREMENTS = {
  earn: [
    'evm.chainId',
    'epoch.allocatorUrl',
    'epoch.positionsUrl',
    'epoch.midenUsdcFaucet',
    'epoch.evmUsdc',
    'epoch.earnProtocol'
  ],
  fastBridge: ['evm.chainId', 'epoch.allocatorUrl', 'epoch.midenUsdcFaucet', 'epoch.evmUsdc'],
  bridgeIn: ['evm.chainId', 'agglayer.l1Bridge', 'agglayer.midenBridge', 'agglayer.indexerUrl'],
  // The L1 bridge gives the destination network id; the indexer is what Claim polls afterwards.
  bridgeOut: ['evm.chainId', 'agglayer.l1Bridge', 'agglayer.midenBridge', 'agglayer.indexerUrl']
};

const valueAt = (config, dotted) => {
  const [section, field] = dotted.split('.');
  return config[section][field];
};

export function switchErrors(config) {
  const errors = [];
  for (const name of BRIDGE_SWITCHES) {
    if (!config.features[name]) continue;
    for (const field of FEATURE_REQUIREMENTS[name]) {
      if (valueAt(config, field) === undefined) {
        errors.push(`features.${name} is on but ${field} is missing or unsupported`);
      }
    }
  }
  return errors;
}

/**
 * A changed document must carry a higher version than the base branch's, so a wallet that already
 * holds the base version accepts the new one. A revert to older values is a new, higher version too.
 */
export function versionError(currentText, currentVersion, baseText) {
  if (baseText === null || baseText === currentText) return null;
  let baseVersion;
  try {
    baseVersion = JSON.parse(baseText).version;
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(baseVersion)) return null;
  if (currentVersion > baseVersion) return null;
  return `version must be greater than ${baseVersion}, the base branch's version (a revert is a new, higher version)`;
}

/** The checks the switched-on features need, one per distinct target. */
export function plannedChecks(config) {
  const checks = new Map();
  const add = check => checks.set(check.key, check);
  const { evm, agglayer, epoch, features } = config;
  const epochOn = features.earn || features.fastBridge;
  const agglayerOn = features.bridgeIn || features.bridgeOut;

  if (epochOn || agglayerOn) add({ key: 'evm-chain', kind: 'evm-chain', label: 'EVM RPC', chainId: evm.chainId });
  if (epochOn) {
    add({
      key: 'allocator',
      kind: 'http',
      label: 'Epoch allocator',
      url: `${epoch.allocatorUrl}/health`,
      healthy: body => body?.status === 'healthy'
    });
    add({
      key: `miden:${epoch.midenUsdcFaucet}`,
      kind: 'miden-account',
      label: 'Miden USDC faucet',
      id: epoch.midenUsdcFaucet
    });
    add({ key: `code:${epoch.evmUsdc}`, kind: 'evm-code', label: 'EVM USDC', address: epoch.evmUsdc });
    add({
      key: 'evm-usdc-decimals',
      kind: 'evm-uint',
      label: 'EVM USDC decimals()',
      address: epoch.evmUsdc,
      data: '0x313ce567'
    });
  }
  if (features.earn) {
    add({
      key: 'positions',
      kind: 'http',
      label: 'Epoch positions',
      url: `${epoch.positionsUrl}/health`,
      healthy: body => body?.ok === true
    });
  }
  if (agglayerOn) {
    add({
      key: `registry:${agglayer.midenBridge}`,
      kind: 'miden-registry',
      label: 'Miden bridge registry',
      id: agglayer.midenBridge
    });
    add({ key: `code:${agglayer.l1Bridge}`, kind: 'evm-code', label: 'L1 bridge', address: agglayer.l1Bridge });
    add({
      key: 'l1-network-id',
      kind: 'evm-uint',
      label: 'L1 bridge networkID()',
      address: agglayer.l1Bridge,
      data: '0xbab161bf'
    });
    add({
      key: 'indexer',
      kind: 'http',
      label: 'Agglayer indexer',
      url: `${agglayer.indexerUrl}/healthz`,
      healthy: body => body?.status === 'SERVING'
    });
  }
  return [...checks.values()];
}

async function fetchWithTimeout(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function httpHealth(check, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, check.url, { headers: { accept: 'application/json' } });
  if (res.status !== 200) return { ok: false, detail: `${check.url} answered HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, detail: `${check.url} did not answer JSON` };
  }
  return check.healthy(body)
    ? { ok: true, detail: `${check.url} healthy` }
    : { ok: false, detail: `${check.url} answered ${JSON.stringify(body).slice(0, 160)}` };
}

/** JSON-RPC against each of the chain's RPCs in turn; the first answer wins. */
export async function evmRpc(chainId, method, params, fetchImpl) {
  const failures = [];
  for (const url of EVM_RPCS[chainId] ?? []) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      const body = await res.json();
      if (isRecord(body) && typeof body.result === 'string') return body.result;
      failures.push(`${url}: ${JSON.stringify(body?.error ?? body).slice(0, 120)}`);
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`no RPC for chain ${chainId} answered ${method}: ${failures.join('; ')}`);
}

// `rpc.Api/GetAccount` with no accept header, which the node accepts for any client version. The
// request fields are the same in node 0.16 and 0.17 (account_id = 1 { id = 1 }, details = 3).

function varint(value) {
  const out = [];
  let n = value;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

const lengthDelimited = (fieldNo, payload) =>
  Buffer.concat([varint((fieldNo << 3) | 2), varint(payload.length), payload]);

/** The GetAccount request body, framed for gRPC-web. With `mapSlot`, asks for that storage map whole. */
export function getAccountFrame(accountIdHex, mapSlot) {
  const id = Buffer.from(accountIdHex.slice(2), 'hex');
  let details = Buffer.alloc(0);
  if (mapSlot !== undefined) {
    const mapRequest = Buffer.concat([lengthDelimited(1, Buffer.from(mapSlot, 'utf8')), Buffer.from([0x10, 0x01])]);
    details = lengthDelimited(4, lengthDelimited(1, mapRequest));
  }
  const message = Buffer.concat([lengthDelimited(1, lengthDelimited(1, id)), lengthDelimited(3, details)]);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

function* protoFields(buffer) {
  let offset = 0;
  const readVarint = () => {
    let value = 0n;
    let shift = 0n;
    let byte;
    do {
      byte = buffer[offset++];
      if (byte === undefined) throw new Error('truncated protobuf');
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return value;
  };
  while (offset < buffer.length) {
    const key = Number(readVarint());
    const fieldNo = key >>> 3;
    const wireType = key & 7;
    if (wireType === 0) yield [fieldNo, readVarint()];
    else if (wireType === 1) {
      yield [fieldNo, buffer.readBigUInt64LE(offset)];
      offset += 8;
    } else if (wireType === 5) {
      yield [fieldNo, buffer.readUInt32LE(offset)];
      offset += 4;
    } else if (wireType === 2) {
      const length = Number(readVarint());
      yield [fieldNo, buffer.subarray(offset, offset + length)];
      offset += length;
    } else throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
}

const fieldsNamed = (buffer, fieldNo) => [...protoFields(buffer)].filter(([no]) => no === fieldNo).map(([, v]) => v);

/** Splits a gRPC-web body into its message and the grpc-status it ends with. */
export function readGrpcWeb(headers, body) {
  let message = null;
  let status = headers.get('grpc-status');
  let statusMessage = headers.get('grpc-message');
  let offset = 0;
  while (offset + 5 <= body.length) {
    const flag = body[offset];
    const length = body.readUInt32BE(offset + 1);
    const frame = body.subarray(offset + 5, offset + 5 + length);
    if (flag & 0x80) {
      for (const line of frame.toString('utf8').split('\r\n')) {
        const [name, ...rest] = line.split(':');
        if (name === 'grpc-status') status = rest.join(':').trim();
        if (name === 'grpc-message') statusMessage = rest.join(':').trim();
      }
    } else message = frame;
    offset += 5 + length;
  }
  return { message, status, statusMessage: statusMessage === null ? '' : decodeURIComponent(statusMessage) };
}

/** Counts registry entries whose value word starts with 1 (registered), from a GetAccount reply. */
export function countRegisteredFaucets(message, slot = REGISTRY_SLOT) {
  let registered = 0;
  for (const details of fieldsNamed(message, 3)) {
    for (const storage of fieldsNamed(details, 2)) {
      for (const map of fieldsNamed(storage, 2)) {
        if (fieldsNamed(map, 1)[0]?.toString('utf8') !== slot) continue;
        if (fieldsNamed(map, 2).some(tooMany => tooMany === 1n))
          throw new Error(`${slot} has too many entries to read whole`);
        for (const all of fieldsNamed(map, 3)) {
          for (const entry of fieldsNamed(all, 1)) {
            const value = fieldsNamed(entry, 2)[0];
            const first = value === undefined ? undefined : fieldsNamed(value, 1)[0];
            if (first === 1n) registered++;
          }
        }
      }
    }
  }
  return registered;
}

export async function midenGetAccount(rpcUrl, accountIdHex, mapSlot, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, `${rpcUrl}/rpc.Api/GetAccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: getAccountFrame(accountIdHex, mapSlot)
  });
  if (res.status !== 200) return { state: 'error', detail: `HTTP ${res.status}` };
  const { message, status, statusMessage } = readGrpcWeb(res.headers, Buffer.from(await res.arrayBuffer()));
  if (status === '0' && message !== null) return { state: 'ok', message };
  if (status === '5' || /not found/i.test(statusMessage)) return { state: 'absent', detail: statusMessage };
  return { state: 'error', detail: `grpc-status ${status ?? 'missing'}: ${statusMessage}` };
}

async function runCheck(check, config, fetchImpl) {
  const midenRpc = MIDEN_RPC[config.network];
  switch (check.kind) {
    case 'http':
      return httpHealth(check, fetchImpl);
    case 'evm-chain': {
      const answered = Number(await evmRpc(check.chainId, 'eth_chainId', [], fetchImpl));
      return answered === check.chainId
        ? { ok: true, detail: `RPC answers chain ${answered}` }
        : { ok: false, detail: `RPC answers chain ${answered}, expected ${check.chainId}` };
    }
    case 'evm-code': {
      const code = await evmRpc(config.evm.chainId, 'eth_getCode', [check.address, 'latest'], fetchImpl);
      return code.length > 2
        ? { ok: true, detail: `${check.address} has ${(code.length - 2) / 2} bytes of code` }
        : { ok: false, detail: `${check.address} has no code on chain ${config.evm.chainId}` };
    }
    case 'evm-uint': {
      const result = await evmRpc(
        config.evm.chainId,
        'eth_call',
        [{ to: check.address, data: check.data }, 'latest'],
        fetchImpl
      );
      return /^0x[0-9a-fA-F]{64}$/.test(result)
        ? { ok: true, detail: `answers ${BigInt(result)}` }
        : { ok: false, detail: `answered ${result.slice(0, 80)}, not a uint` };
    }
    case 'miden-account':
    case 'miden-registry': {
      if (midenRpc === undefined)
        return { ok: false, detail: `no Miden RPC known for "${config.network}"; add it to MIDEN_RPC` };
      const reply = await midenGetAccount(
        midenRpc,
        check.id,
        check.kind === 'miden-registry' ? REGISTRY_SLOT : undefined,
        fetchImpl
      );
      if (reply.state === 'absent')
        return { ok: false, detail: `${check.id} does not exist on ${config.network} (${reply.detail})` };
      if (reply.state === 'error') return { ok: false, detail: `${check.id}: ${reply.detail}` };
      if (check.kind === 'miden-account') return { ok: true, detail: `${check.id} exists` };
      const registered = countRegisteredFaucets(reply.message);
      return registered > 0
        ? { ok: true, detail: `${check.id} registers ${registered} faucet(s)` }
        : { ok: false, detail: `${check.id} registers no faucet` };
    }
    default:
      return { ok: false, detail: `unknown check kind ${check.kind}` };
  }
}

export async function smokeTest(config, fetchImpl = fetch) {
  const results = [];
  for (const check of plannedChecks(config)) {
    try {
      results.push({ label: check.label ?? check.key, ...(await runCheck(check, config, fetchImpl)) });
    } catch (error) {
      results.push({ label: check.label ?? check.key, ok: false, detail: error.message });
    }
  }
  return results;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function baseText(baseRef, file, root) {
  if (!baseRef) return null;
  try {
    return execFileSync('git', ['show', `${baseRef}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null; // a new file has no base
  }
}

/** `file` is relative to `root`, the way `git show <ref>:<file>` names it. */
export async function validateFile(file, { baseRef, smoke, root = REPO_ROOT, fetchImpl = fetch }) {
  const errors = [];
  const notes = [];
  const network = path.basename(file, '.json');
  const text = readFileSync(path.join(root, file), 'utf8');
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return { errors: [`not JSON: ${error.message}`], notes };
  }
  const parsed = parseBridgeConfigDetailed(body, network);
  errors.push(...parsed.errors);
  notes.push(...parsed.dropped.map(reason => `dropped: ${reason}`));
  if (parsed.config === null) return { errors, notes };
  errors.push(...switchErrors(parsed.config));
  const bump = versionError(text, parsed.config.version, baseText(baseRef, file, root));
  if (bump !== null) errors.push(bump);
  if (smoke && errors.length === 0) {
    for (const result of await smokeTest(parsed.config, fetchImpl)) {
      if (result.ok) notes.push(`ok: ${result.label}: ${result.detail}`);
      else errors.push(`${result.label}: ${result.detail}`);
    }
  }
  return { errors, notes };
}

async function main(argv) {
  const smoke = !argv.includes('--no-smoke');
  const named = argv.filter(arg => !arg.startsWith('--')).map(file => path.relative(REPO_ROOT, path.resolve(file)));
  const files = named.length > 0 ? named : readdirSync(REPO_ROOT).filter(name => name.endsWith('.json'));
  if (files.length === 0) {
    console.error('no <network>.json documents found');
    return 1;
  }
  let failed = 0;
  for (const file of files) {
    const { errors, notes } = await validateFile(file, { baseRef: process.env.BASE_REF, smoke });
    console.log(`\n${file}`);
    for (const note of notes) console.log(`  · ${note}`);
    for (const error of errors) console.log(`  ✗ ${error}`);
    if (errors.length > 0) failed++;
    else console.log('  ✓ valid');
  }
  return failed === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      console.error(error);
      process.exit(1);
    }
  );
}
