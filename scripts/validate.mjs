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
 * version bump, valid countdown publication, switched-on features have every value they need,
 * no USDCx chain name given twice),
 * and a deploy smoke test that finds EVM contracts and service health routes for enabled features.
 * No dependencies: Node 22 only.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_SWITCHES = ['earn', 'fastBridge', 'bridgeIn', 'bridgeOut', 'usdcxIn', 'usdcxOut'];
export const SUPPORTED_EVM_CHAIN_IDS = [11155111];
/** The EVM chains the wallet ships a definition for, which a `usdcx.chains` entry can name. */
export const SUPPORTED_USDCX_CHAIN_IDS = [11155111, 5042002, 84532, 421614];
export const SUPPORTED_EARN_PROTOCOLS = ['dummy-lending'];
/** The marks the wallet ships for a swap token's logo (components/TokenLogo). */
export const SUPPORTED_SWAP_TOKEN_LOGOS = ['MIDEN', 'ETH', 'USDC', 'BTC'];
/** The assets the wallet's price feed quotes (lib/prices/constant.ts KNOWN_SYMBOLS). */
export const SUPPORTED_PRICE_SYMBOLS = ['ETH', 'BTC', 'USDC'];
/** A fungible faucet's decimals: the protocol allows up to 12 (miden-objects BasicFungibleFaucet::MAX_DECIMALS). */
export const MAX_SWAP_TOKEN_DECIMALS = 12;
/** The swap form opens on the first two tokens, so a list needs at least two. */
export const MIN_SWAP_TOKENS = 2;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// A token symbol as the protocol's TokenSymbol allows it: 1 to 6 upper-case ASCII letters.
const TOKEN_SYMBOL = /^[A-Z]{1,6}$/;
// A usdcx.chains key: lowercase letters and digits, in groups joined by one hyphen.
const USDCX_CHAIN_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A Circle domain is a uint32 in the contracts.
const MAX_UINT32 = 0xffffffff;

/**
 * Public RPCs per supported EVM chain, tried in order: one failing provider must not fail a deploy.
 * The chains after Sepolia carry only the RPC of their public chain definition. The smoke test skips
 * a USDCx chain that has no entry here.
 */
export const EVM_RPCS = {
  11155111: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://1rpc.io/sepolia',
    'https://11155111.rpc.thirdweb.com'
  ],
  5042002: ['https://rpc.testnet.arc.io'],
  84532: ['https://sepolia.base.org'],
  421614: ['https://sepolia-rollup.arbitrum.io/rpc']
};

const REQUEST_TIMEOUT_MS = 15_000;

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function utcTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : undefined;
}

function readCountdown(value) {
  if (!isRecord(value)) return { enabled: false };
  const { enabled, launchAt } = value;
  if (enabled !== undefined && typeof enabled !== 'boolean') return { enabled: false };
  const moment = launchAt === undefined ? undefined : utcTimestamp(launchAt);
  if (launchAt !== undefined && moment === undefined) return { enabled: false };
  return { enabled: enabled === true, ...(moment === undefined ? {} : { launchAt: moment }) };
}

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

  const swapIn = readSection(body, 'swap', errors);
  const swap = {
    tokens: readSwapTokens(swapIn.tokens, errors, dropped),
    etaUrl: readUrl(swapIn, 'swap', 'etaUrl', allowLocalHttp, errors)
  };

  const usdcx = readUsdcx(body.usdcx, allowLocalHttp, errors, dropped);

  const mainnetCountdown = readCountdown(body.mainnetCountdown);

  // The wallet's onboarding read (schema.ts): absent means the wallet's own default, a wrong type
  // rejects the document.
  const onboardingIn = readSection(body, 'onboarding', errors);
  const onboarding = {};
  if (onboardingIn.inviteOnly !== undefined) {
    if (typeof onboardingIn.inviteOnly === 'boolean') onboarding.inviteOnly = onboardingIn.inviteOnly;
    else errors.push('onboarding.inviteOnly must be true or false');
  }

  if (errors.length > 0) return { config: null, errors, dropped };
  return {
    config: { network, version, evm, agglayer, epoch, features, swap, usdcx, mainnetCountdown, onboarding },
    errors,
    dropped
  };
}

/** A required 20-byte address: readPattern reports a bad one, this reports a missing one. */
function readRequiredAddress(section, label, field, errors) {
  const address = readPattern(section, label, field, EVM_ADDRESS, 'a 20-byte 0x address', errors);
  if (section[field] === undefined) errors.push(`${label}.${field} is required`);
  return address;
}

const isUint32 = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32;

/**
 * How a deposit starts on a chain (schema.ts readUsdcxDeposit). A route the wallet does not know is
 * dropped, not an error: the chain is then a withdrawal destination only.
 */
function readUsdcxDeposit(value, label, errors, dropped) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  switch (value.route) {
    case 'xreserve':
      return { route: 'xreserve', xReserve: readRequiredAddress(value, label, 'xReserve', errors) };
    case 'executor':
      return {
        route: 'executor',
        tokenMessenger: readRequiredAddress(value, label, 'tokenMessenger', errors),
        tokenMessengerWithFees: readRequiredAddress(value, label, 'tokenMessengerWithFees', errors)
      };
    default:
      if (typeof value.route !== 'string') errors.push(`${label}.route must be a string`);
      else dropped.push(`${label}.route "${value.route}" is not a route the wallet supports`);
      return undefined;
  }
}

function readUsdcxExecutor(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  return {
    address: readRequiredAddress(value, label, 'address', errors),
    handler: readRequiredAddress(value, label, 'handler', errors)
  };
}

/** One chain of the USDCx routes (schema.ts readUsdcxChain). `chainId` is the document's value, supported or not. */
function readUsdcxChain(name, value, errors, dropped) {
  const label = `usdcx.chains.${name}`;
  if (!USDCX_CHAIN_NAME.test(name)) {
    errors.push(`usdcx.chains key "${name}" must be lowercase letters and digits, in groups joined by one hyphen`);
  }
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  const { chainId, domain } = value;
  if (!Number.isSafeInteger(chainId) || chainId < 1) errors.push(`${label}.chainId must be a positive safe integer`);
  if (!isUint32(domain)) errors.push(`${label}.domain must be an integer from 0 to ${MAX_UINT32}`);
  const usdc = readRequiredAddress(value, label, 'usdc', errors);
  const deposit =
    value.deposit === undefined ? undefined : readUsdcxDeposit(value.deposit, `${label}.deposit`, errors, dropped);
  const hasExecutor = value.executor !== undefined;
  const executor = hasExecutor ? readUsdcxExecutor(value.executor, `${label}.executor`, errors) : undefined;
  // The executor deposits into the xReserve of its own chain.
  if (hasExecutor && deposit?.route !== 'xreserve') {
    errors.push(`${label}.executor is valid only on a chain whose deposit.route is "xreserve"`);
  }
  return { name, chainId, domain, usdc, deposit, executor, hasExecutor };
}

/**
 * The chains in the document's order, which is the wallet's picker order (schema.ts readUsdcxChains).
 * Two entries for one chain id, or two executors, reject the document. A chain the wallet ships no
 * definition for is dropped after those two checks, as the wallet does.
 */
function readUsdcxChains(value, errors, dropped) {
  if (!isRecord(value)) {
    errors.push('usdcx.chains must be an object');
    return [];
  }
  const read = Object.entries(value)
    .map(([name, chain]) => readUsdcxChain(name, chain, errors, dropped))
    .filter(chain => chain !== undefined);
  const chainIds = new Set();
  for (const { chainId } of read) {
    if (!Number.isSafeInteger(chainId)) continue;
    if (chainIds.has(chainId)) errors.push(`usdcx.chains names chain id ${chainId} twice`);
    chainIds.add(chainId);
  }
  if (read.filter(chain => chain.hasExecutor).length > 1) {
    errors.push('usdcx.chains must name at most one chain with an executor');
  }
  const chains = [];
  for (const { hasExecutor, ...chain } of read) {
    if (SUPPORTED_USDCX_CHAIN_IDS.includes(chain.chainId)) {
      chains.push(chain);
    } else if (Number.isSafeInteger(chain.chainId) && chain.chainId >= 1) {
      dropped.push(
        `usdcx.chains.${chain.name}: chain id ${chain.chainId} is not a chain the wallet supports ` +
          `(${SUPPORTED_USDCX_CHAIN_IDS.join(', ')})`
      );
    }
  }
  return chains;
}

/**
 * The wallet's USDCx read (schema.ts readUsdcx). Undefined means the document has no `usdcx`
 * section: USDCx deposits and withdrawals are not configured.
 */
function readUsdcx(value, allowLocalHttp, errors, dropped) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push('usdcx must be an object');
    return undefined;
  }
  if (value.midenDomain === undefined) errors.push('usdcx.midenDomain is required');
  else if (!isUint32(value.midenDomain)) errors.push(`usdcx.midenDomain must be an integer from 0 to ${MAX_UINT32}`);
  if (value.attestationUrl === undefined) errors.push('usdcx.attestationUrl is required');
  if (value.chains === undefined) errors.push('usdcx.chains is required');
  return {
    midenDomain: value.midenDomain,
    attestationUrl: readUrl(value, 'usdcx', 'attestationUrl', allowLocalHttp, errors),
    irisUrl: readUrl(value, 'usdcx', 'irisUrl', allowLocalHttp, errors),
    chains: value.chains === undefined ? [] : readUsdcxChains(value.chains, errors, dropped)
  };
}

/** The chain every `executor` deposit goes to (schema.ts usdcxExecutorChain). */
export function usdcxExecutorChain(usdcx) {
  return usdcx.chains.find(chain => chain.executor && chain.deposit?.route === 'xreserve');
}

/**
 * Whether a deposit can start on `chain` (schema.ts isUsdcxDepositSource). An `executor` deposit
 * needs the executor chain and Circle's Iris API.
 */
export function isUsdcxDepositSource(usdcx, chain) {
  switch (chain.deposit?.route) {
    case 'xreserve':
      return true;
    case 'executor':
      return usdcx.irisUrl !== undefined && usdcxExecutorChain(usdcx) !== undefined;
    default:
      return false;
  }
}

/**
 * The keys an object in `text` names more than once. `target` is the path of the object from the
 * document's root. JSON.parse keeps the last of two equal keys without a word, so only the text can
 * show the mistake. `text` must be valid JSON.
 */
export function duplicateKeys(text, target) {
  const duplicates = [];
  let at = 0;
  const skipSpace = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at])) at++;
  };
  const readString = () => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    at++;
    return JSON.parse(text.slice(start, at));
  };
  // An array index is a number in the path, so it never equals a key of `target`.
  const readValue = path => {
    skipSpace();
    switch (text[at]) {
      case '{': {
        const watched = path.length === target.length && path.every((key, index) => key === target[index]);
        const seen = new Set();
        at++;
        skipSpace();
        while (text[at] !== '}') {
          const key = readString();
          if (watched && seen.has(key) && !duplicates.includes(key)) duplicates.push(key);
          seen.add(key);
          skipSpace();
          at++; // the colon
          readValue([...path, key]);
          skipSpace();
          if (text[at] === ',') at++;
          skipSpace();
        }
        at++;
        return;
      }
      case '[': {
        at++;
        skipSpace();
        for (let index = 0; text[at] !== ']'; index++) {
          readValue([...path, index]);
          skipSpace();
          if (text[at] === ',') at++;
          skipSpace();
        }
        at++;
        return;
      }
      case '"':
        readString();
        return;
      default:
        // A number, true, false or null.
        while (at < text.length && !',]} \t\n\r'.includes(text[at])) at++;
    }
  };
  readValue([]);
  return duplicates;
}

/** A repo rule: the wallet cannot see a chain name that the document gives twice, so the document must not. */
export function usdcxDuplicateErrors(text) {
  return duplicateKeys(text, ['usdcx', 'chains']).map(name => `usdcx.chains names chain "${name}" twice`);
}

/**
 * The wallet's swap registry (schema.ts readSwapTokens): the list the swap token picker shows, in
 * order. A bad entry rejects the document; a logo or price symbol the wallet lacks is dropped from
 * its entry only. Absent means no swap tokens, so the wallet shows Swap as unavailable.
 */
function readSwapTokens(value, errors, dropped) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push('swap.tokens must be an array');
    return [];
  }
  const tokens = [];
  value.forEach((entry, index) => {
    const label = `swap.tokens[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const { symbol, decimals } = entry;
    if (typeof symbol !== 'string' || !TOKEN_SYMBOL.test(symbol)) {
      errors.push(`${label}.symbol must be 1 to 6 upper-case letters`);
    }
    const faucetId = readPattern(entry, label, 'faucetId', MIDEN_ACCOUNT_ID, 'a 15-byte 0x account id', errors);
    if (faucetId === undefined && entry.faucetId === undefined) errors.push(`${label}.faucetId is required`);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_SWAP_TOKEN_DECIMALS) {
      errors.push(`${label}.decimals must be an integer from 0 to ${MAX_SWAP_TOKEN_DECIMALS}`);
    }
    const token = { symbol, faucetId, decimals };
    if (entry.logo !== undefined) {
      if (typeof entry.logo !== 'string') errors.push(`${label}.logo must be a string`);
      else if (SUPPORTED_SWAP_TOKEN_LOGOS.includes(entry.logo)) token.logo = entry.logo;
      else dropped.push(`${label}.logo "${entry.logo}" is not a mark the wallet ships`);
    }
    if (entry.priceSymbol !== undefined) {
      if (typeof entry.priceSymbol !== 'string') errors.push(`${label}.priceSymbol must be a string`);
      else if (SUPPORTED_PRICE_SYMBOLS.includes(entry.priceSymbol)) token.priceSymbol = entry.priceSymbol;
      else dropped.push(`${label}.priceSymbol "${entry.priceSymbol}" is not an asset the wallet's price feed quotes`);
    }
    tokens.push(token);
  });
  const faucetIds = new Set();
  const symbols = new Set();
  for (const token of tokens) {
    if (token.faucetId !== undefined && faucetIds.has(token.faucetId)) {
      errors.push(`swap.tokens names faucet ${token.faucetId} twice`);
    }
    if (typeof token.symbol === 'string' && symbols.has(token.symbol)) {
      errors.push(`swap.tokens names symbol ${token.symbol} twice`);
    }
    faucetIds.add(token.faucetId);
    symbols.add(token.symbol);
  }
  return tokens;
}

/**
 * Repo rules, not parse rules: one swap token gives the wallet nothing to open the form on, and a
 * list without the quote service leaves every pair unquoted.
 */
export function swapErrors(config) {
  const errors = [];
  const count = config.swap.tokens.length;
  if (count > 0 && count < MIN_SWAP_TOKENS) {
    errors.push(`swap.tokens must name at least ${MIN_SWAP_TOKENS} tokens, or none`);
  }
  if (count > 0 && config.swap.etaUrl === undefined) {
    errors.push('swap.tokens is set but swap.etaUrl is missing');
  }
  return errors;
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
  bridgeOut: ['evm.chainId', 'agglayer.l1Bridge', 'agglayer.midenBridge', 'agglayer.indexerUrl'],
  // The wallet's own two requirements (availability.ts usdcxSource and usdcxDestination).
  usdcxIn: ['usdcx.chains[].deposit'],
  usdcxOut: ['usdcx.chains']
};

// Undefined reads as missing. A chain the wallet does not support is not in the parsed list.
const some = found => (found ? true : undefined);

/** The USDCx requirements are facts about the whole chain list, not one field. */
const COMPUTED_VALUES = {
  'usdcx.chains[].deposit': ({ usdcx }) => some(usdcx?.chains.some(chain => isUsdcxDepositSource(usdcx, chain))),
  'usdcx.chains': ({ usdcx }) => some(usdcx !== undefined && usdcx.chains.length > 0)
};

const valueAt = (config, dotted) => {
  const computed = COMPUTED_VALUES[dotted];
  if (computed) return computed(config);
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

/** The wallet safely ignores a bad banner; publishing one is still a configuration mistake. */
export function countdownErrors(body) {
  const countdown = body.mainnetCountdown;
  if (countdown === undefined) return [];
  if (!isRecord(countdown)) return ['mainnetCountdown must be an object'];
  const errors = [];
  if (countdown.enabled !== undefined && typeof countdown.enabled !== 'boolean') {
    errors.push('mainnetCountdown.enabled must be true or false');
  }
  if (countdown.launchAt !== undefined && utcTimestamp(countdown.launchAt) === undefined) {
    errors.push('mainnetCountdown.launchAt must be an RFC 3339 UTC timestamp such as 2026-10-26T00:00:00Z');
  }
  if (countdown.enabled === true && countdown.launchAt === undefined) {
    errors.push('mainnetCountdown.enabled is on but mainnetCountdown.launchAt is missing');
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
  for (const check of plannedUsdcxChecks(config)) add(check);
  return [...checks.values()];
}

/**
 * The USDCx contract checks. A withdrawal needs USDC on each destination; a deposit needs the
 * contracts of each chain it can start on, and an `executor` deposit needs the executor chain's too.
 * Circle's two services publish no health route, so no check reads them.
 */
function plannedUsdcxChecks(config) {
  const { usdcx, features } = config;
  if (usdcx === undefined || !(features.usdcxIn || features.usdcxOut)) return [];
  const checks = [];
  const code = (chain, what, address) =>
    checks.push({
      key: `code:${chain.chainId}:${address}`,
      kind: 'evm-code',
      label: `USDCx ${chain.name} ${what}`,
      chainId: chain.chainId,
      address
    });
  const sources = features.usdcxIn ? usdcx.chains.filter(chain => isUsdcxDepositSource(usdcx, chain)) : [];
  const executorChain = sources.some(chain => chain.deposit.route === 'executor') ? usdcxExecutorChain(usdcx) : undefined;
  for (const chain of usdcx.chains) {
    const isSource = sources.includes(chain);
    // A chain with no RPC here is not checked. A chain that is only a deposit source is not read while usdcxIn is off.
    if (EVM_RPCS[chain.chainId] === undefined || !(features.usdcxOut || isSource)) continue;
    checks.push({
      key: `evm-chain:${chain.chainId}`,
      kind: 'evm-chain',
      label: `USDCx ${chain.name} RPC`,
      chainId: chain.chainId
    });
    code(chain, 'USDC', chain.usdc);
    if (isSource && chain.deposit.route === 'xreserve') code(chain, 'xReserve', chain.deposit.xReserve);
    if (isSource && chain.deposit.route === 'executor') {
      code(chain, 'TokenMessenger', chain.deposit.tokenMessenger);
      code(chain, 'TokenMessenger with fees', chain.deposit.tokenMessengerWithFees);
    }
    if (chain === executorChain) {
      code(chain, 'executor', chain.executor.address);
      code(chain, 'executor handler', chain.executor.handler);
    }
  }
  return checks;
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

async function runCheck(check, config, fetchImpl) {
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
      // A USDCx check names its own chain; the others read the document's one EVM chain.
      const chainId = check.chainId ?? config.evm.chainId;
      const code = await evmRpc(chainId, 'eth_getCode', [check.address, 'latest'], fetchImpl);
      return code.length > 2
        ? { ok: true, detail: `${check.address} has ${(code.length - 2) / 2} bytes of code` }
        : { ok: false, detail: `${check.address} has no code on chain ${chainId}` };
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
  errors.push(
    ...switchErrors(parsed.config),
    ...swapErrors(parsed.config),
    ...countdownErrors(body),
    ...usdcxDuplicateErrors(text)
  );
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
