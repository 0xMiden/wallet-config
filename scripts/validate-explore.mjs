#!/usr/bin/env node
/**
 * Validates the per-network Explore catalogs the Miden wallet reads at runtime.
 *
 *   node scripts/validate-explore.mjs                      # every explore/<network>.json
 *   node scripts/validate-explore.mjs explore/testnet.json         # one document
 *   BASE_REF=origin/main node scripts/validate-explore.mjs # also require a version bump against that ref
 *
 * Two layers, in order: the wallet's own parse rules (ported from the wallet's src/lib/explore-config/schema.ts; the
 * two must agree on every rule), then the repo rules (file name, version bump, document size, icons). No
 * dependencies: Node 22 only.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPLORE_CATEGORIES = ['finance', 'arcade', 'others'];
export const EXPLORE_SECTION_KINDS = ['featured', 'list'];
/** The ids of the sections the wallet adds itself (Recents, the search results). */
export const RESERVED_SECTION_IDS = ['recents', 'search-results'];
/** The wallet's locale codes, as its public/_locales directories name them. */
export const EXPLORE_LOCALES = ['de', 'en', 'en_GB', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh_CN', 'zh_TW'];
export const NAME_MAX_CHARS = 40;
export const TAGLINE_MAX_CHARS = 120;
/** The most a wallet reads of a document. */
export const MAX_DOCUMENT_BYTES = 32 * 1024;
export const MAX_ICON_BYTES = 32 * 1024;
export const MAX_ICON_SIDE = 256;

const ID = /^[a-z0-9-]+$/;
const ICON = /^icons\/[a-z0-9-]+\.png$/;
const BRAND_COLOR = /^#[0-9a-fA-F]{6}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_HTTP_HOSTS = ['127.0.0.1', 'localhost'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An IP literal, a local name or a punycode label can pass for a host the user knows.
 * A domain keeps its trailing dot when parsed, and "localhost." still reaches this machine.
 */
export function isDisguisedHost(hostname) {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return (
    host.startsWith('[') ||
    IPV4.test(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.split('.').some(label => label.startsWith('xn--'))
  );
}

function readId(value, label, errors) {
  if (typeof value === 'string' && ID.test(value)) return value;
  errors.push(`${label} must match ^[a-z0-9-]+$`);
  return undefined;
}

// Literal text by wallet locale code. A key that is no wallet locale is ignored, so a document can add a language
// before every wallet ships it.
function readText(value, label, maxChars, errors, dropped) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object of strings by locale code`);
    return undefined;
  }
  const text = {};
  for (const [locale, entry] of Object.entries(value)) {
    if (!EXPLORE_LOCALES.includes(locale)) dropped.push(`${label}.${locale} is not a wallet locale`);
    else if (typeof entry !== 'string' || entry.trim() === '') errors.push(`${label}.${locale} must be a non-empty string`);
    else if (Array.from(entry).length > maxChars) errors.push(`${label}.${locale} is longer than ${maxChars} characters`);
    else text[locale] = entry;
  }
  if (value.en === undefined) errors.push(`${label}.en is required`);
  return text;
}

// Kept exactly as written: Recents match an opened app by the exact string.
function readItemUrl(value, label, allowLocalHttp, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label} must be a URL string`);
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${label} is not a URL`);
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    errors.push(`${label} must not carry credentials`);
    return undefined;
  }
  if (allowLocalHttp && url.protocol === 'http:' && LOCAL_HTTP_HOSTS.includes(url.hostname)) return value;
  if (url.protocol !== 'https:') {
    errors.push(`${label} must use https:`);
    return undefined;
  }
  if (isDisguisedHost(url.hostname)) {
    errors.push(`${label} must not name an IP address, localhost or a punycode host`);
    return undefined;
  }
  return value;
}

function readItem(value, label, allowLocalHttp, errors, dropped) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return { id: undefined, item: null };
  }
  const id = readId(value.id, `${label}.id`, errors);
  const name = readText(value.name, `${label}.name`, NAME_MAX_CHARS, errors, dropped);
  const tagline = readText(value.tagline, `${label}.tagline`, TAGLINE_MAX_CHARS, errors, dropped);
  const url = readItemUrl(value.url, `${label}.url`, allowLocalHttp, errors);
  const { category, icon, brandColor, isExchange } = value;
  if (typeof category !== 'string') errors.push(`${label}.category must be a string`);
  if (icon !== undefined && (typeof icon !== 'string' || !ICON.test(icon))) {
    errors.push(`${label}.icon must be icons/<name>.png, <name> in a-z, 0-9 and -`);
  }
  if (brandColor !== undefined && (typeof brandColor !== 'string' || !BRAND_COLOR.test(brandColor))) {
    errors.push(`${label}.brandColor must be #RRGGBB`);
  }
  if (typeof isExchange !== 'boolean') errors.push(`${label}.isExchange must be true or false`);
  if (typeof category === 'string' && !EXPLORE_CATEGORIES.includes(category)) {
    dropped.push(`${label} is in category "${category}", which the wallet does not know`);
    return { id, item: null };
  }
  return { id, item: { id, name, tagline, url, category, icon, brandColor, isExchange } };
}

function readList(body, name, errors) {
  if (Array.isArray(body[name])) return body[name];
  errors.push(`${name} must be an array`);
  return [];
}

function readItemIds(value, label, ids, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of item ids`);
    return [];
  }
  const listed = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !ids.has(entry)) {
      errors.push(`${label} names ${JSON.stringify(entry)}, which is not an item`);
    } else if (listed.includes(entry)) {
      errors.push(`${label} lists "${entry}" twice`);
    } else {
      listed.push(entry);
    }
  }
  return listed;
}

function readSection(value, label, ids, kept, errors, dropped) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return { id: undefined, section: null };
  }
  const id = readId(value.id, `${label}.id`, errors);
  if (id !== undefined && RESERVED_SECTION_IDS.includes(id)) {
    errors.push(`${label}.id "${id}" is reserved for a section the wallet adds`);
  }
  const { kind } = value;
  if (typeof kind !== 'string') errors.push(`${label}.kind must be a string`);
  const title = readText(value.title, `${label}.title`, Infinity, errors, dropped);
  const itemIds = readItemIds(value.itemIds, `${label}.itemIds`, ids, errors);
  if (typeof kind === 'string' && !EXPLORE_SECTION_KINDS.includes(kind)) {
    dropped.push(`${label} is of kind "${kind}", which the wallet does not know`);
    return { id, section: null };
  }
  // An item the wallet leaves out leaves every section with it.
  return { id, section: { id, kind, title, itemIds: itemIds.filter(itemId => kept.has(itemId)) } };
}

/**
 * The wallet's `parseExploreConfig`, with the reasons it refuses and what it leaves out.
 * `catalog` is null exactly when the wallet would ignore the document.
 */
export function parseExploreConfigDetailed(body, network, options = {}) {
  const allowLocalHttp = options.allowLocalHttp === true;
  const errors = [];
  const dropped = [];
  if (!isRecord(body)) return { catalog: null, errors: ['the document must be a JSON object'], dropped };
  if (body.network !== network) errors.push(`network must be "${network}"`);
  const { version } = body;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    errors.push('version must be a positive safe integer');
  }
  const ids = new Set();
  const items = [];
  readList(body, 'items', errors).forEach((entry, index) => {
    const label = `items[${index}]`;
    const { id, item } = readItem(entry, label, allowLocalHttp, errors, dropped);
    if (id !== undefined && ids.has(id)) errors.push(`${label}.id "${id}" is listed twice`);
    if (id !== undefined) ids.add(id);
    if (item) items.push(item);
  });
  const kept = new Set(items.map(item => item.id));
  const sectionIds = new Set();
  const sections = [];
  readList(body, 'sections', errors).forEach((entry, index) => {
    const label = `sections[${index}]`;
    const { id, section } = readSection(entry, label, ids, kept, errors, dropped);
    if (id !== undefined && sectionIds.has(id)) errors.push(`${label}.id "${id}" is listed twice`);
    if (id !== undefined) sectionIds.add(id);
    if (section) sections.push(section);
  });
  if (errors.length > 0) return { catalog: null, errors, dropped };
  return { catalog: { network, version, items, sections }, errors, dropped };
}

export function parseExploreConfig(body, network, options) {
  return parseExploreConfigDetailed(body, network, options).catalog;
}

/**
 * A changed document must carry a higher version than the base branch's, so a wallet that already
 * holds the base version accepts the new one. A revert to an older catalog is a new, higher version too.
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

/** Why `icon`, a path relative to `root`, is not an icon the wallet can draw, or null when it is one. */
export function iconError(root, icon) {
  const file = path.join(realpathSync(root), icon);
  let bytes;
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return `${icon} is missing`;
    // GitHub serves the git tree and follows no link, so neither the file nor a directory above it may be one.
    if (!stat.isFile() || realpathSync(file) !== file) return `${icon} is not a regular file`;
    if (stat.size > MAX_ICON_BYTES) return `${icon} is larger than 32 KiB`;
    bytes = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return `${icon} is missing`;
    return `${icon} cannot be read (${error.code})`;
  }
  const signed = bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  if (!signed || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    return `${icon} is not a PNG`;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || width !== height) return `${icon} is not square`;
  if (width > MAX_ICON_SIDE) return `${icon} is larger than 256x256`;
  return null;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `file` as `baseRef` holds it, or null when the file is new there. An unresolvable `baseRef` throws, so the
 * version rule fails closed instead of being skipped by a mistyped or unfetched ref.
 */
export function baseText(baseRef, file, root) {
  if (!baseRef) return null;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch {
    throw new Error(`BASE_REF ${baseRef} does not resolve to a commit, so the version rule cannot run`);
  }
  try {
    return execFileSync('git', ['show', `${baseRef}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null; // a resolvable ref that lacks the file: a new file has no base
  }
}

/** `file` is relative to `root`, the way `git show <ref>:<file>` names it. */
export function validateFile(file, { baseRef, root = REPO_ROOT } = {}) {
  const errors = [];
  const notes = [];
  const network = path.basename(file, '.json');
  const location = path.join(realpathSync(root), file);
  const stat = lstatSync(location, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || realpathSync(location) !== location) {
    return { errors: [`${file} is not a regular file`], notes };
  }
  const raw = readFileSync(location);
  if (raw.length > MAX_DOCUMENT_BYTES) errors.push('the document is larger than 32 KiB, the most a wallet reads');
  const text = raw.toString('utf8');
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return { errors: [...errors, `not JSON: ${error.message}`], notes };
  }
  const parsed = parseExploreConfigDetailed(body, network);
  errors.push(...parsed.errors);
  notes.push(...parsed.dropped.map(reason => `dropped: ${reason}`));
  if (parsed.catalog === null) return { errors, notes };
  // Publication is stricter than the forward-compatible reader: do not silently publish invisible listings.
  for (const [index, item] of body.items.entries()) {
    if (!EXPLORE_CATEGORIES.includes(item.category)) {
      errors.push(`items[${index}].category must be finance, arcade or others (All is an aggregate)`);
    }
  }
  try {
    const bump = versionError(text, parsed.catalog.version, baseText(baseRef, file, root));
    if (bump !== null) errors.push(bump);
  } catch (error) {
    errors.push(error.message);
  }
  // Every item's icon, a left-out item's too: a wallet that knows its category draws it.
  for (const icon of new Set(body.items.map(item => item.icon).filter(icon => icon !== undefined))) {
    const problem = iconError(path.dirname(path.join(root, file)), icon);
    if (problem !== null) errors.push(problem);
  }
  return { errors, notes };
}

function main(argv) {
  const named = argv.map(file => path.relative(REPO_ROOT, path.resolve(file)));
  const files = named.length > 0 ? named : readdirSync(path.join(REPO_ROOT, 'explore')).filter(name => name.endsWith('.json')).sort().map(name => `explore/${name}`);
  if (files.length === 0) {
    console.error('no explore/<network>.json documents found');
    return 1;
  }
  let failed = 0;
  for (const file of files) {
    const { errors, notes } = validateFile(file, { baseRef: process.env.BASE_REF });
    console.log(`\n${file}`);
    for (const note of notes) console.log(`  · ${note}`);
    for (const error of errors) console.log(`  ✗ ${error}`);
    if (errors.length > 0) failed++;
    else console.log('  ✓ valid');
  }
  return failed === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
