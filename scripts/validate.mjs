#!/usr/bin/env node
/**
 * Validate network documents, version changes, and enabled routes with Node 22, and ask every
 * listed Guardian operator for its key.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_SWITCHES = ["earn"];
export const CHAIN_IDS = {
  sepolia: 11155111,
  "arc-testnet": 5042002,
  "base-sepolia": 84532,
  "arbitrum-sepolia": 421614,
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  arc: 5042,
};
export const SUPPORTED_EVM_CHAIN_IDS = Object.values(CHAIN_IDS);
/** The marks the wallet ships for a swap token's logo (components/TokenLogo). */
export const SUPPORTED_SWAP_TOKEN_LOGOS = ["MIDEN", "ETH", "USDC", "BTC"];
/** The assets the wallet's price feed quotes (lib/prices/constant.ts KNOWN_SYMBOLS). */
export const SUPPORTED_PRICE_SYMBOLS = ["ETH", "BTC", "USDC"];
/** A fungible faucet's decimals: the protocol allows up to 12 (miden-objects BasicFungibleFaucet::MAX_DECIMALS). */
export const MAX_SWAP_TOKEN_DECIMALS = 12;
/** The swap form opens on the first two tokens, so a list needs at least two. */
export const MIN_SWAP_TOKENS = 2;
/** The wallet pings every listed Guardian operator on the picker, so the list is bounded. */
export const MAX_GUARDIANS = 16;
/** The longest operator id, and the longest name, operator or location the wallet shows. */
export const MAX_GUARDIAN_ID_LENGTH = 32;
export const MAX_GUARDIAN_LABEL_LENGTH = 48;
/** Ids the wallet gives its own entries: the developer's custom endpoint and the no-Guardian choice. */
export const RESERVED_GUARDIAN_IDS = ["custom", "no-guardian"];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MIDEN_ACCOUNT_ID = /^0x[0-9a-fA-F]{30}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// A token symbol as the protocol's TokenSymbol allows it: 1 to 6 upper-case ASCII letters.
const TOKEN_SYMBOL = /^[A-Z]{1,6}$/;
// A Guardian operator id: lower-case letters and digits in groups joined by single hyphens.
const GUARDIAN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A Guardian's key commitment as `GET /pubkey` serves it: a 32-byte 0x word.
const GUARDIAN_COMMITMENT = /^0x[0-9a-fA-F]{64}$/;
// C0 controls, DEL and C1 controls: none belongs in a line of text the wallet shows.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** Public RPCs per supported EVM chain, tried in order: one failing provider must not fail a deploy. */
export const EVM_RPCS = {
  5042002: ["https://rpc.testnet.arc.io"],
  84532: ["https://sepolia.base.org"],
  421614: ["https://sepolia-rollup.arbitrum.io/rpc"],
  1: ["https://ethereum-rpc.publicnode.com"],
  8453: ["https://mainnet.base.org"],
  42161: ["https://arb1.arbitrum.io/rpc"],
  10: ["https://mainnet.optimism.io"],
  5042: ["https://rpc.arc.network"],
  11155111: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://1rpc.io/sepolia",
    "https://11155111.rpc.thirdweb.com",
  ],
};

const REQUEST_TIMEOUT_MS = 15_000;

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function utcTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
    ? parsed
    : undefined;
}

function readCountdown(value) {
  if (!isRecord(value)) return { enabled: false };
  const { enabled, launchAt } = value;
  if (enabled !== undefined && typeof enabled !== "boolean")
    return { enabled: false };
  const moment = launchAt === undefined ? undefined : utcTimestamp(launchAt);
  if (launchAt !== undefined && moment === undefined) return { enabled: false };
  return {
    enabled: enabled === true,
    ...(moment === undefined ? {} : { launchAt: moment }),
  };
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
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${label}.${field} must be ${kind}`);
    return undefined;
  }
  return value.toLowerCase();
}

function readUrl(section, label, field, allowLocalHttp, errors) {
  const value = section[field];
  if (value === undefined) return undefined;
  const name = `${label}.${field}`;
  if (typeof value !== "string") {
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
  const local =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !(allowLocalHttp && local)) {
    errors.push(`${name} must use https:`);
    return undefined;
  }
  // The wallet appends routes to these (`${allocatorUrl}/health`), which a query or fragment would break.
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    errors.push(`${name} must not carry credentials, a query or a fragment`);
    return undefined;
  }
  // The wallet's form exactly (schema.ts baseUrl): lowercase host, no default port, no trailing slash.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The wallet's `parseBridgeConfig`, with the reasons it rejects and the values it drops.
 * `config` is null exactly when the wallet would ignore the document.
 */
export function parseBridgeConfigDetailed(body, network, options = {}) {
  const errors = [];
  const dropped = [];
  if (!isRecord(body))
    return {
      config: null,
      errors: ["the document must be an object"],
      dropped,
    };
  if (body.network !== network) errors.push(`network must be "${network}"`);
  if (!Number.isSafeInteger(body.version) || body.version < 1)
    errors.push("version must be a positive safe integer");
  const featuresIn = readSection(body, "features", errors);
  const featureNames = ["earn", "fastBridge", "bridgeIn", "bridgeOut"];
  for (const name of featureNames) {
    if (featuresIn[name] !== undefined && typeof featuresIn[name] !== "boolean")
      errors.push(`features.${name} must be boolean`);
  }
  const providers = readSection(body, "bridge-providers", errors);
  const chains = readSection(body, "supportedEvmChains", errors);
  const required = (object, key, label, pattern) => {
    if (typeof object[key] !== "string" || !pattern.test(object[key]))
      errors.push(`${label}.${key} is missing or invalid`);
  };
  const url = (object, key, label) => {
    if (object[key] === undefined) errors.push(`${label}.${key} is required`);
    readUrl(object, label, key, options.allowLocalHttp === true, errors);
  };
  for (const [name, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      errors.push(`bridge-providers.${name} must be an object`);
      continue;
    }
    switch (name) {
      case "epoch":
        url(provider, "allocatorUrl", name);
        url(provider, "positionsUrl", name);
        if (provider.outputs !== undefined && !isRecord(provider.outputs))
          errors.push("epoch.outputs must be an object");
        for (const [key, output] of Object.entries(
          isRecord(provider.outputs) ? provider.outputs : {},
        )) {
          if (network !== "testnet" || key !== "usdc-testnet-output")
            errors.push(
              `epoch.outputs.${key} is not a supported output on this network`,
            );
          if (!isRecord(output))
            errors.push(`epoch.outputs.${key} must be an object`);
          else
            required(
              output,
              "faucetId",
              `epoch.outputs.${key}`,
              MIDEN_ACCOUNT_ID,
            );
        }
        break;
      case "agglayer":
        url(provider, "indexerUrl", name);
        break;
      case "usdcx":
        if (
          !Number.isInteger(provider.midenDomain) ||
          provider.midenDomain < 0 ||
          provider.midenDomain > 0xffffffff
        )
          errors.push("usdcx.midenDomain must be uint32");
        url(provider, "attestationUrl", name);
        url(provider, "irisUrl", name);
        break;
    }
  }
  const seenIds = new Set();
  for (const [name, chain] of Object.entries(chains)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !isRecord(chain)) {
      errors.push(`invalid chain ${name}`);
      continue;
    }
    if (CHAIN_IDS[name] !== chain.chainId)
      errors.push(`${name}.chainId does not match the wallet registry`);
    if (seenIds.has(chain.chainId))
      errors.push(`duplicate chain id ${chain.chainId}`);
    seenIds.add(chain.chainId);
    if (!isRecord(chain.bridges)) {
      errors.push(`${name}.bridges must be an object`);
      continue;
    }
    for (const [kind, bridge] of Object.entries(chain.bridges)) {
      const label = `${name}.bridges.${kind}`;
      if (!isRecord(bridge)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      if (!isRecord(providers[kind]))
        errors.push(`${label} requires bridge-providers.${kind}`);
      for (const direction of ["depositEnabled", "withdrawalEnabled"])
        if (typeof bridge[direction] !== "boolean")
          errors.push(`${label}.${direction} must be boolean`);
      switch (kind) {
        case "epoch":
        case "usdcx": {
          const token = bridge.tokens?.USDC;
          if (!isRecord(token)) {
            errors.push(`${label}.tokens.USDC is required`);
            break;
          }
          required(token, "contractAddress", label, EVM_ADDRESS);
          if (kind === "epoch") {
            if (
              token.outputs !== undefined &&
              (!Array.isArray(token.outputs) ||
                new Set(token.outputs).size !== token.outputs.length ||
                token.outputs.some(
                  (key) =>
                    typeof key !== "string" ||
                    !isRecord(providers.epoch?.outputs?.[key]),
                ))
            )
              errors.push(`${label} has an invalid output reference`);
            break;
          }
          if (
            !Number.isInteger(bridge.domain) ||
            bridge.domain < 0 ||
            bridge.domain > 0xffffffff
          )
            errors.push(`${label}.domain must be uint32`);
          if (bridge.executor !== undefined) {
            if (!isRecord(bridge.executor))
              errors.push(`${label}.executor must be an object`);
            else
              for (const field of ["address", "handler"])
                required(bridge.executor, field, label, EVM_ADDRESS);
          }
          const deposit = bridge.deposit;
          if (bridge.depositEnabled && deposit === undefined)
            errors.push(`${label}.deposit is required while enabled`);
          if (deposit === undefined) break;
          if (!isRecord(deposit)) {
            errors.push(`${label}.deposit must be an object`);
            break;
          }
          switch (deposit.route) {
            case "xreserve":
              required(deposit, "xReserve", label, EVM_ADDRESS);
              break;
            case "executor": {
              for (const field of ["tokenMessenger", "tokenMessengerWithFees"])
                required(deposit, field, label, EVM_ADDRESS);
              const target = chains[deposit.executorChain]?.bridges?.usdcx;
              if (!target?.executor || target.deposit?.route !== "xreserve")
                errors.push(
                  `${label}.executorChain must name an xreserve chain with an executor`,
                );
              break;
            }
            default:
              errors.push(`${label}.deposit.route is invalid`);
          }
          if (bridge.executor && deposit.route !== "xreserve")
            errors.push(`${label}.executor requires xreserve`);
          break;
        }
        case "agglayer":
          required(bridge, "contractAddress", label, EVM_ADDRESS);
          required(bridge, "midenBridgeId", label, MIDEN_ACCOUNT_ID);
          break;
        default:
          errors.push(`${label} is not a supported bridge`);
      }
    }
  }
  if (featuresIn.earn && !providers.epoch)
    errors.push("Earn requires the Epoch provider");
  const swapIn = readSection(body, "swap", errors);
  const swap = {
    tokens: readSwapTokens(swapIn.tokens, errors, dropped),
    etaUrl: readUrl(
      swapIn,
      "swap",
      "etaUrl",
      options.allowLocalHttp === true,
      errors,
    ),
  };
  const guardians = readGuardians(
    body.guardians,
    options.allowLocalHttp === true,
    errors,
  );
  const onboarding = readSection(body, "onboarding", errors);
  if (
    onboarding.inviteOnly !== undefined &&
    typeof onboarding.inviteOnly !== "boolean"
  )
    errors.push("onboarding.inviteOnly must be boolean");
  return {
    config: errors.length
      ? null
      : {
          ...body,
          features: { ...featuresIn, earn: featuresIn.earn === true },
          "bridge-providers": providers,
          supportedEvmChains: chains,
          swap,
          mainnetCountdown: readCountdown(body.mainnetCountdown),
          onboarding,
          ...(guardians === undefined ? {} : { guardians }),
        },
    errors,
    dropped,
  };
}

function readGuardianLabel(entry, label, field, errors) {
  const value = entry[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_GUARDIAN_LABEL_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    errors.push(
      `${label}.${field} must be 1 to ${MAX_GUARDIAN_LABEL_LENGTH} characters with no control character and no space at either end`,
    );
    return undefined;
  }
  return value;
}

/**
 * The wallet's Guardian operators (schema.ts readGuardians): the list the Guardian picker shows, in
 * order, with the first as the default. A bad entry rejects the document. Absent means the wallet
 * uses the list it ships with; an empty list is refused, because it would leave a new wallet with
 * no operator to choose. An endpoint is kept in the wallet's form, so a trailing slash is dropped.
 */
function readGuardians(value, allowLocalHttp, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push("guardians must be an array");
    return undefined;
  }
  if (value.length === 0 || value.length > MAX_GUARDIANS) {
    errors.push(
      `guardians must name 1 to ${MAX_GUARDIANS} operators, or be omitted`,
    );
    return undefined;
  }
  const guardians = [];
  value.forEach((entry, index) => {
    const label = `guardians[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const { id } = entry;
    const idOk =
      typeof id === "string" &&
      id.length <= MAX_GUARDIAN_ID_LENGTH &&
      GUARDIAN_ID.test(id);
    if (!idOk) {
      errors.push(
        `${label}.id must be 1 to ${MAX_GUARDIAN_ID_LENGTH} lower-case letters, digits and single hyphens`,
      );
    } else if (RESERVED_GUARDIAN_IDS.includes(id)) {
      errors.push(`${label}.id "${id}" is reserved by the wallet`);
    }
    const name = readGuardianLabel(entry, label, "name", errors);
    const operatedBy = readGuardianLabel(entry, label, "operatedBy", errors);
    const location = readGuardianLabel(entry, label, "location", errors);
    const endpoint = readUrl(entry, label, "endpoint", allowLocalHttp, errors);
    if (endpoint === undefined && entry.endpoint === undefined)
      errors.push(`${label}.endpoint is required`);
    guardians.push({ id, name, operatedBy, location, endpoint });
  });
  const ids = new Set();
  const endpoints = new Set();
  for (const guardian of guardians) {
    if (typeof guardian.id === "string" && ids.has(guardian.id)) {
      errors.push(`guardians names id ${guardian.id} twice`);
    }
    if (guardian.endpoint !== undefined && endpoints.has(guardian.endpoint)) {
      errors.push(`guardians names endpoint ${guardian.endpoint} twice`);
    }
    ids.add(guardian.id);
    endpoints.add(guardian.endpoint);
  }
  return guardians;
}

/**
 * The wallet's swap registry (schema.ts readSwapTokens): the list the swap token picker shows, in
 * order. A bad entry rejects the document; a logo or price symbol the wallet lacks is dropped from
 * its entry only. Absent means no swap tokens, so the wallet shows Swap as unavailable.
 */
function readSwapTokens(value, errors, dropped) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push("swap.tokens must be an array");
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
    if (typeof symbol !== "string" || !TOKEN_SYMBOL.test(symbol)) {
      errors.push(`${label}.symbol must be 1 to 6 upper-case letters`);
    }
    const faucetId = readPattern(
      entry,
      label,
      "faucetId",
      MIDEN_ACCOUNT_ID,
      "a 15-byte 0x account id",
      errors,
    );
    if (faucetId === undefined && entry.faucetId === undefined)
      errors.push(`${label}.faucetId is required`);
    if (
      !Number.isSafeInteger(decimals) ||
      decimals < 0 ||
      decimals > MAX_SWAP_TOKEN_DECIMALS
    ) {
      errors.push(
        `${label}.decimals must be an integer from 0 to ${MAX_SWAP_TOKEN_DECIMALS}`,
      );
    }
    const token = { symbol, faucetId, decimals };
    if (entry.logo !== undefined) {
      if (typeof entry.logo !== "string")
        errors.push(`${label}.logo must be a string`);
      else if (SUPPORTED_SWAP_TOKEN_LOGOS.includes(entry.logo))
        token.logo = entry.logo;
      else
        dropped.push(
          `${label}.logo "${entry.logo}" is not a mark the wallet ships`,
        );
    }
    if (entry.priceSymbol !== undefined) {
      if (typeof entry.priceSymbol !== "string")
        errors.push(`${label}.priceSymbol must be a string`);
      else if (SUPPORTED_PRICE_SYMBOLS.includes(entry.priceSymbol))
        token.priceSymbol = entry.priceSymbol;
      else
        dropped.push(
          `${label}.priceSymbol "${entry.priceSymbol}" is not an asset the wallet's price feed quotes`,
        );
    }
    tokens.push(token);
  });
  const faucetIds = new Set();
  const symbols = new Set();
  for (const token of tokens) {
    if (token.faucetId !== undefined && faucetIds.has(token.faucetId)) {
      errors.push(`swap.tokens names faucet ${token.faucetId} twice`);
    }
    if (typeof token.symbol === "string" && symbols.has(token.symbol)) {
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
    errors.push(
      `swap.tokens must name at least ${MIN_SWAP_TOKENS} tokens, or none`,
    );
  }
  if (count > 0 && config.swap.etaUrl === undefined) {
    errors.push("swap.tokens is set but swap.etaUrl is missing");
  }
  return errors;
}

export function parseBridgeConfig(body, network, options) {
  return parseBridgeConfigDetailed(body, network, options).config;
}

export function switchErrors() {
  return [];
}

/** The wallet safely ignores a bad banner; publishing one is still a configuration mistake. */
export function countdownErrors(body) {
  const countdown = body.mainnetCountdown;
  if (countdown === undefined) return [];
  if (!isRecord(countdown)) return ["mainnetCountdown must be an object"];
  const errors = [];
  if (
    countdown.enabled !== undefined &&
    typeof countdown.enabled !== "boolean"
  ) {
    errors.push("mainnetCountdown.enabled must be true or false");
  }
  if (
    countdown.launchAt !== undefined &&
    utcTimestamp(countdown.launchAt) === undefined
  ) {
    errors.push(
      "mainnetCountdown.launchAt must be an RFC 3339 UTC timestamp such as 2026-10-26T00:00:00Z",
    );
  }
  if (countdown.enabled === true && countdown.launchAt === undefined) {
    errors.push(
      "mainnetCountdown.enabled is on but mainnetCountdown.launchAt is missing",
    );
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

/**
 * The checks the switched-on features need, one per distinct target, and one per Guardian operator:
 * no switch covers the operators, so each one is asked every time. `publishedGuardians` is the
 * endpoints the base branch's document lists. An outage of one of those must not block an
 * unrelated publication, so its check is advisory; an endpoint the base does not list must answer.
 */
export function plannedChecks(config, { publishedGuardians = [] } = {}) {
  const checks = new Map();
  const add = (check) => checks.set(check.key, check);
  for (const guardian of config.guardians ?? []) {
    add({
      key: `guardian:${guardian.endpoint}`,
      kind: "guardian",
      label: `Guardian ${guardian.id}`,
      url: `${guardian.endpoint}/pubkey?scheme=ecdsa`,
      advisory: publishedGuardians.includes(guardian.endpoint),
    });
  }
  const providers = config["bridge-providers"];
  const code = (chainId, address, label) =>
    add({
      key: `code:${chainId}:${address}`,
      kind: "evm-code",
      chainId,
      address,
      label,
    });
  const service = (key, url, healthy) =>
    add({ key, kind: "http", url, healthy });
  for (const [name, chain] of Object.entries(config.supportedEvmChains)) {
    for (const [kind, bridge] of Object.entries(chain.bridges)) {
      if (!bridge.depositEnabled && !bridge.withdrawalEnabled) continue;
      add({
        key: `chain:${chain.chainId}`,
        kind: "evm-chain",
        chainId: chain.chainId,
      });
      switch (kind) {
        case "epoch":
          service(
            "allocator",
            `${providers.epoch.allocatorUrl}/health`,
            (body) => body?.status === "healthy",
          );
          code(
            chain.chainId,
            bridge.tokens.USDC.contractAddress,
            `${name} Epoch USDC`,
          );
          add({
            key: `decimals:${chain.chainId}:${bridge.tokens.USDC.contractAddress}`,
            kind: "evm-uint",
            chainId: chain.chainId,
            address: bridge.tokens.USDC.contractAddress,
            data: "0x313ce567",
            label: `${name} Epoch USDC decimals()`,
          });
          break;
        case "agglayer":
          service(
            "indexer",
            `${providers.agglayer.indexerUrl}/healthz`,
            (body) => body?.status === "SERVING",
          );
          code(chain.chainId, bridge.contractAddress, `${name} Agglayer`);
          add({
            key: `network:${chain.chainId}:${bridge.contractAddress}`,
            kind: "evm-uint",
            chainId: chain.chainId,
            address: bridge.contractAddress,
            data: "0xbab161bf",
            label: `${name} Agglayer networkID()`,
          });
          break;
        case "usdcx": {
          code(
            chain.chainId,
            bridge.tokens.USDC.contractAddress,
            `${name} USDCx USDC`,
          );
          if (!bridge.depositEnabled) break;
          const deposit = bridge.deposit;
          switch (deposit.route) {
            case "xreserve":
              code(chain.chainId, deposit.xReserve, `${name} xReserve`);
              break;
            case "executor": {
              code(
                chain.chainId,
                deposit.tokenMessenger,
                `${name} TokenMessenger`,
              );
              code(
                chain.chainId,
                deposit.tokenMessengerWithFees,
                `${name} TokenMessenger with fees`,
              );
              const target = config.supportedEvmChains[deposit.executorChain];
              const route = target.bridges.usdcx;
              add({
                key: `chain:${target.chainId}`,
                kind: "evm-chain",
                chainId: target.chainId,
              });
              code(target.chainId, route.deposit.xReserve, "executor xReserve");
              code(target.chainId, route.executor.address, "executor");
              code(target.chainId, route.executor.handler, "executor handler");
              break;
            }
          }
          break;
        }
      }
    }
  }
  if (config.features.earn) {
    service(
      "allocator",
      `${providers.epoch.allocatorUrl}/health`,
      (body) => body?.status === "healthy",
    );
    service(
      "positions",
      `${providers.epoch.positionsUrl}/health`,
      (body) => body?.ok === true,
    );
  }
  return [...checks.values()];
}

async function fetchWithTimeout(fetchImpl, url, init = {}) {
  return fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function httpHealth(check, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, check.url, {
    headers: { accept: "application/json" },
  });
  if (res.status !== 200)
    return { ok: false, detail: `${check.url} answered HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, detail: `${check.url} did not answer JSON` };
  }
  return check.healthy(body)
    ? { ok: true, detail: `${check.url} healthy` }
    : {
        ok: false,
        detail: `${check.url} answered ${JSON.stringify(body).slice(0, 160)}`,
      };
}

/** A Guardian answers `GET /pubkey` with its key commitment. The wallet reads the ECDSA key, so the check does too. */
async function guardianPubkey(check, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, check.url, {
    headers: { accept: "application/json" },
  });
  if (res.status !== 200)
    return { ok: false, detail: `${check.url} answered HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, detail: `${check.url} did not answer JSON` };
  }
  const commitment = isRecord(body) ? body.commitment : undefined;
  if (typeof commitment !== "string" || !GUARDIAN_COMMITMENT.test(commitment))
    return {
      ok: false,
      detail: `${check.url} answered ${JSON.stringify(body).slice(0, 160)}, not a key commitment`,
    };
  const key = commitment.toLowerCase();
  return {
    ok: true,
    detail: `${check.url} serves commitment ${key}`,
    commitment: key,
  };
}

/** JSON-RPC against each of the chain's RPCs in turn; the first answer wins. */
export async function evmRpc(chainId, method, params, fetchImpl) {
  const failures = [];
  for (const url of EVM_RPCS[chainId] ?? []) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (isRecord(body) && typeof body.result === "string") return body.result;
      failures.push(
        `${url}: ${JSON.stringify(body?.error ?? body).slice(0, 120)}`,
      );
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(
    `no RPC for chain ${chainId} answered ${method}: ${failures.join("; ")}`,
  );
}

async function runCheck(check, config, fetchImpl) {
  switch (check.kind) {
    case "http":
      return httpHealth(check, fetchImpl);
    case "guardian":
      return guardianPubkey(check, fetchImpl);
    case "evm-chain": {
      const answered = Number(
        await evmRpc(check.chainId, "eth_chainId", [], fetchImpl),
      );
      return answered === check.chainId
        ? { ok: true, detail: `RPC answers chain ${answered}` }
        : {
            ok: false,
            detail: `RPC answers chain ${answered}, expected ${check.chainId}`,
          };
    }
    case "evm-code": {
      const code = await evmRpc(
        check.chainId,
        "eth_getCode",
        [check.address, "latest"],
        fetchImpl,
      );
      return code.length > 2
        ? {
            ok: true,
            detail: `${check.address} has ${(code.length - 2) / 2} bytes of code`,
          }
        : {
            ok: false,
            detail: `${check.address} has no code on chain ${config.evm.chainId}`,
          };
    }
    case "evm-uint": {
      const result = await evmRpc(
        check.chainId,
        "eth_call",
        [{ to: check.address, data: check.data }, "latest"],
        fetchImpl,
      );
      return /^0x[0-9a-fA-F]{64}$/.test(result)
        ? { ok: true, detail: `answers ${BigInt(result)}` }
        : { ok: false, detail: `answered ${result.slice(0, 80)}, not a uint` };
    }
    default:
      return { ok: false, detail: `unknown check kind ${check.kind}` };
  }
}

export async function smokeTest(config, fetchImpl = fetch, options = {}) {
  const results = [];
  // The wallet names neither of two operators that serve one key, so a shared key is a mistake.
  const commitments = new Map();
  for (const check of plannedChecks(config, options)) {
    const label = check.label ?? check.key;
    const advisory = check.advisory === true;
    try {
      const { commitment, ...result } = await runCheck(
        check,
        config,
        fetchImpl,
      );
      const holder =
        commitment === undefined ? undefined : commitments.get(commitment);
      if (holder !== undefined) {
        results.push({
          label,
          ok: false,
          advisory: false,
          detail: `serves the key commitment ${holder} serves`,
        });
        continue;
      }
      if (commitment !== undefined) commitments.set(commitment, label);
      results.push({ label, advisory, ...result });
    } catch (error) {
      results.push({ label, ok: false, advisory, detail: error.message });
    }
  }
  return results;
}

/** The Guardian endpoints the base branch's document lists, in the wallet's form; none when it has no usable list. */
export function publishedGuardianEndpoints(baseText, network) {
  if (baseText === null) return [];
  try {
    const guardians =
      parseBridgeConfig(JSON.parse(baseText), network)?.guardians ?? [];
    return guardians.map((guardian) => guardian.endpoint);
  } catch {
    return [];
  }
}

export function duplicateKeys(text, target) {
  const duplicates = [];
  let at = 0;
  const skipSpace = () => {
    while (at < text.length && " \t\n\r".includes(text[at])) at++;
  };
  const readString = () => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at++;
    return JSON.parse(text.slice(start, at));
  };
  // An array index is a number in the path, so it never equals a key of `target`.
  const readValue = (path) => {
    skipSpace();
    switch (text[at]) {
      case "{": {
        const watched =
          path.length === target.length &&
          path.every((key, index) => key === target[index]);
        const seen = new Set();
        at++;
        skipSpace();
        while (text[at] !== "}") {
          const key = readString();
          if (watched && seen.has(key) && !duplicates.includes(key))
            duplicates.push(key);
          seen.add(key);
          skipSpace();
          at++; // the colon
          readValue([...path, key]);
          skipSpace();
          if (text[at] === ",") at++;
          skipSpace();
        }
        at++;
        return;
      }
      case "[": {
        at++;
        skipSpace();
        for (let index = 0; text[at] !== "]"; index++) {
          readValue([...path, index]);
          skipSpace();
          if (text[at] === ",") at++;
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
        while (at < text.length && !",]} \t\n\r".includes(text[at])) at++;
    }
  };
  readValue([]);
  return duplicates;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function baseText(baseRef, file, root) {
  if (!baseRef) return null;
  try {
    return execFileSync("git", ["show", `${baseRef}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // a new file has no base
  }
}

/** `file` is relative to `root`, the way `git show <ref>:<file>` names it. */
export async function validateFile(
  file,
  { baseRef, smoke, root = REPO_ROOT, fetchImpl = fetch },
) {
  const errors = [];
  const notes = [];
  const network = path.basename(file, ".json");
  const text = readFileSync(path.join(root, file), "utf8");
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return { errors: [`not JSON: ${error.message}`], notes };
  }
  const parsed = parseBridgeConfigDetailed(body, network);
  errors.push(...parsed.errors);
  notes.push(...parsed.dropped.map((reason) => `dropped: ${reason}`));
  if (parsed.config === null) return { errors, notes };
  errors.push(
    ...switchErrors(parsed.config),
    ...swapErrors(parsed.config),
    ...countdownErrors(body),
    ...duplicateKeys(text, ["supportedEvmChains"]).map(
      (key) => `supportedEvmChains repeats ${key}`,
    ),
  );
  const base = baseText(baseRef, file, root);
  const bump = versionError(text, parsed.config.version, base);
  if (bump !== null) errors.push(bump);
  if (smoke && errors.length === 0) {
    const publishedGuardians = publishedGuardianEndpoints(base, network);
    for (const result of await smokeTest(parsed.config, fetchImpl, {
      publishedGuardians,
    })) {
      if (result.ok) notes.push(`ok: ${result.label}: ${result.detail}`);
      else if (result.advisory)
        notes.push(`warning: ${result.label}: ${result.detail}`);
      else errors.push(`${result.label}: ${result.detail}`);
    }
  }
  return { errors, notes };
}

async function main(argv) {
  const smoke = !argv.includes("--no-smoke");
  const named = argv
    .filter((arg) => !arg.startsWith("--"))
    .map((file) => path.relative(REPO_ROOT, path.resolve(file)));
  const files =
    named.length > 0
      ? named
      : readdirSync(REPO_ROOT).filter((name) => name.endsWith(".json"));
  if (files.length === 0) {
    console.error("no <network>.json documents found");
    return 1;
  }
  let failed = 0;
  for (const file of files) {
    const { errors, notes } = await validateFile(file, {
      baseRef: process.env.BASE_REF,
      smoke,
    });
    console.log(`\n${file}`);
    for (const note of notes) console.log(`  · ${note}`);
    for (const error of errors) console.log(`  ✗ ${error}`);
    if (errors.length > 0) failed++;
    else console.log("  ✓ valid");
  }
  return failed === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
