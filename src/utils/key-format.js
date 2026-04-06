import crypto from 'node:crypto';
import { encodeBase64Url, decodeBase64Url } from './base64url.js';

const PRIVATE_PREFIX_V1 = 'windra_sk_';
const PRIVATE_PREFIX_V2 = 'windra_sk_v2_';
const PUBLIC_PREFIX_V1 = 'windra_pk_';
const PUBLIC_PREFIX_V2 = 'windra_pk_v2_';
const CHECKSUM_LEN = 6;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function checksum(raw) {
  return encodeBase64Url(crypto.createHash('sha256').update(raw).digest()).slice(0, CHECKSUM_LEN);
}

function encodeKey(raw, prefix) {
  return `${prefix}${encodeBase64Url(raw)}_${checksum(raw)}`;
}

function decodeBody(body) {
  if (body.length <= CHECKSUM_LEN + 1) throw new Error('invalid_key_body');
  const sep = body.length - CHECKSUM_LEN - 1;
  if (body[sep] !== '_') throw new Error('invalid_key_checksum_separator');
  const payload = body.slice(0, sep);
  const actualChecksum = body.slice(sep + 1);
  const raw = decodeBase64Url(payload);
  if (checksum(raw) !== actualChecksum) throw new Error('invalid_key_checksum');
  return raw;
}

export function decodePrivateComponents(input) {
  const trimmed = `${input || ''}`.trim();
  if (trimmed.startsWith(PRIVATE_PREFIX_V2)) {
    const raw = decodeBody(trimmed.slice(PRIVATE_PREFIX_V2.length));
    if (raw.length !== 64) throw new Error('invalid_v2_private_key_length');
    return { signPrivateKey: raw.subarray(0, 32), encPrivateKey: raw.subarray(32, 64) };
  }
  if (trimmed.startsWith(PRIVATE_PREFIX_V1)) {
    const raw = decodeBody(trimmed.slice(PRIVATE_PREFIX_V1.length));
    if (raw.length !== 32) throw new Error('invalid_v1_private_key_length');
    return { signPrivateKey: raw, encPrivateKey: null };
  }
  throw new Error('unsupported_private_key_prefix');
}

export function decodePublicComponents(input) {
  const trimmed = `${input || ''}`.trim();
  if (trimmed.startsWith(PUBLIC_PREFIX_V2)) {
    const raw = decodeBody(trimmed.slice(PUBLIC_PREFIX_V2.length));
    if (raw.length !== 64) throw new Error('invalid_v2_public_key_length');
    return { signPublicKey: raw.subarray(0, 32), encPublicKey: raw.subarray(32, 64) };
  }
  if (trimmed.startsWith(PUBLIC_PREFIX_V1)) {
    const raw = decodeBody(trimmed.slice(PUBLIC_PREFIX_V1.length));
    if (raw.length !== 32) throw new Error('invalid_v1_public_key_length');
    return { signPublicKey: raw, encPublicKey: null };
  }
  const raw = decodeBase64Url(trimmed);
  if (raw.length !== 32) throw new Error('invalid_raw_public_key_length');
  return { signPublicKey: raw, encPublicKey: null };
}

export function generateBridgeIdentity() {
  const sign = crypto.generateKeyPairSync('ed25519');
  const enc = crypto.generateKeyPairSync('x25519');

  const signPrivateRaw = sign.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const signPublicRaw = sign.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const encPrivateRaw = enc.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const encPublicRaw = enc.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  const combinedPrivate = Buffer.concat([signPrivateRaw, encPrivateRaw]);
  const combinedPublic = Buffer.concat([signPublicRaw, encPublicRaw]);

  return {
    privateKey: encodeKey(combinedPrivate, PRIVATE_PREFIX_V2),
    publicKey: encodeKey(combinedPublic, PUBLIC_PREFIX_V2),
    signPublicRaw: encodeBase64Url(signPublicRaw),
    encPublicRaw: encodeBase64Url(encPublicRaw)
  };
}

export function ed25519PrivateKeyFromSeed(seed) {
  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8'
  });
}

export function ed25519PublicKeyFromRaw(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki'
  });
}

export function x25519PrivateKeyFromSeed(seed) {
  return crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8'
  });
}

export function x25519PublicKeyFromRaw(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki'
  });
}
