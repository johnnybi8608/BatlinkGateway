import crypto from 'node:crypto';
import { encodeBase64Url, decodeBase64Url } from './base64url.js';
import { x25519PrivateKeyFromSeed, x25519PublicKeyFromRaw } from './key-format.js';

const SALT = Buffer.from('windra.e2e.v1', 'utf8');

function deriveKey(sharedSecret) {
  return crypto.hkdfSync('sha256', sharedSecret, SALT, Buffer.alloc(0), 32);
}

export function encryptMessage(plainText, recipientEncRawB64Url) {
  const recipientPublicKey = x25519PublicKeyFromRaw(decodeBase64Url(recipientEncRawB64Url));
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralPublicRaw = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const sharedSecret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey });
  const key = deriveKey(sharedSecret);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    v: 1,
    epk: encodeBase64Url(ephemeralPublicRaw),
    nonce: encodeBase64Url(nonce),
    ct: encodeBase64Url(ciphertext)
  };
  return encodeBase64Url(Buffer.from(JSON.stringify(envelope), 'utf8'));
}

export function decryptMessage(ciphertextB64Url, receiverEncPrivateSeed) {
  const envelope = JSON.parse(decodeBase64Url(ciphertextB64Url).toString('utf8'));
  if (envelope.v !== 1) throw new Error('unsupported_envelope_version');
  const senderPublicKey = x25519PublicKeyFromRaw(decodeBase64Url(envelope.epk));
  const receiverPrivateKey = x25519PrivateKeyFromSeed(receiverEncPrivateSeed);
  const sharedSecret = crypto.diffieHellman({ privateKey: receiverPrivateKey, publicKey: senderPublicKey });
  const key = deriveKey(sharedSecret);
  const nonce = decodeBase64Url(envelope.nonce);
  const raw = decodeBase64Url(envelope.ct);
  const cipher = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return plain.toString('utf8');
}
