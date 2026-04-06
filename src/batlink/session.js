import crypto from 'node:crypto';
import WebSocket from 'ws';
import { decodePrivateComponents, decodePublicComponents, ed25519PrivateKeyFromSeed } from '../utils/key-format.js';
import { encodeBase64Url } from '../utils/base64url.js';
import { encryptMessage, decryptMessage } from '../utils/message-crypto.js';
import {
  encodeTextPayload,
  encodeImagePayload,
  encodeVoicePayload,
  encodeSitePayload,
  encodeBridgeControlAckPayload,
  encodeBridgeTranslationPatchPayload,
  encodeBridgePlaceholderPayload,
  parsePayload
} from '../utils/text-payload.js';

export class BatlinkSession {
  constructor({ config, nodeClient, binding, ownerPublicKey, onOwnerMessage }) {
    this.config = config;
    this.nodeClient = nodeClient;
    this.binding = binding;
    this.ownerPublicKey = ownerPublicKey;
    this.onOwnerMessage = onOwnerMessage;
    this.privateParts = decodePrivateComponents(binding.bridgePrivateKey);
    this.publicParts = decodePublicComponents(binding.bridgePublicKey);
    this.ownerParts = decodePublicComponents(ownerPublicKey);
    this.signPrivateKey = ed25519PrivateKeyFromSeed(this.privateParts.signPrivateKey);
    this.token = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.connecting = false;
    this.deliveredIds = new Set();
  }

  async start() {
    await this.ensureConnected();
  }

  async ensureConnected() {
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.ensureAuthenticated();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connectWebSocket();
      }
    } finally {
      this.connecting = false;
    }
  }

  async ensureAuthenticated() {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.tokenExpiresAt > now + 30) return;
    const challenge = await this.nodeClient.challenge();
    const signature = crypto.sign(null, Buffer.from(challenge.challenge, 'utf8'), this.signPrivateKey);
    const verify = await this.nodeClient.verify({
      pubkey: encodeBase64Url(this.publicParts.signPublicKey),
      signature: encodeBase64Url(signature),
      challenge: challenge.challenge
    });
    this.token = verify.token;
    this.tokenExpiresAt = verify.expiresAt;
    console.log(`[BAG] batlink auth ok waJid=${this.binding.waJid} bridgePub=${this.binding.bridgePublicKey}`);
  }

  async sendPayloadToOwner(payloadText, notifyType = 'message_delivered', timing = null) {
    await this.ensureAuthenticated();
    const createdAt = typeof timing?.createdAt === 'number' ? timing.createdAt : Math.floor(Date.now() / 1000);
    const expiresAt = typeof timing?.expiresAt === 'number' ? timing.expiresAt : (createdAt + this.config.messageTtlSeconds);
    const messageId = crypto.randomUUID().toLowerCase();
    const ciphertext = encryptMessage(payloadText, encodeBase64Url(this.ownerParts.encPublicKey));
    const signingPayload = `${messageId}|${encodeBase64Url(this.ownerParts.signPublicKey)}|${createdAt}|${expiresAt}|${ciphertext}`;
    const signature = crypto.sign(null, Buffer.from(signingPayload, 'utf8'), this.signPrivateKey);
    await this.nodeClient.sendMessage(this.token, {
      recipient_pubkey: encodeBase64Url(this.ownerParts.signPublicKey),
      message_id: messageId,
      created_at: createdAt,
      expires_at: expiresAt,
      ciphertext,
      sender_pubkey: encodeBase64Url(this.publicParts.signPublicKey),
      sender_sig: encodeBase64Url(signature),
      notify_type: notifyType
    });
  }

  async sendTextToOwner(text, source = null, options = {}, timing = null) {
    const payload = encodeTextPayload(text, encodeBase64Url(this.publicParts.encPublicKey), source, options);
    await this.sendPayloadToOwner(payload, 'message_delivered', timing);
  }

  async sendImageToOwner({ imageData, mime, width, height }, source = null, timing = null) {
    const payload = encodeImagePayload({
      imageData,
      mime,
      width,
      height,
      senderEncPubkey: encodeBase64Url(this.publicParts.encPublicKey),
      source
    });
    await this.sendPayloadToOwner(payload, 'message_delivered', timing);
  }

  async sendVoiceToOwner({ audioData, durationMs, waveform }, source = null, options = {}, timing = null) {
    const payload = encodeVoicePayload({
      audioData,
      durationMs,
      waveform,
      senderEncPubkey: encodeBase64Url(this.publicParts.encPublicKey),
      source,
      options
    });
    await this.sendPayloadToOwner(payload, 'message_delivered', timing);
  }

  async sendSiteToOwner({ title, url, iconUrl = null }, source = null, timing = null) {
    const payload = encodeSitePayload({
      title,
      url,
      iconUrl,
      senderEncPubkey: encodeBase64Url(this.publicParts.encPublicKey),
      source
    });
    await this.sendPayloadToOwner(payload, 'message_delivered', timing);
  }

  async sendControlAckToOwner({ action, requestId, ok, payload = null, error = null }) {
    const wire = encodeBridgeControlAckPayload(
      action,
      requestId,
      ok,
      payload,
      error,
      encodeBase64Url(this.publicParts.encPublicKey)
    );
    await this.sendPayloadToOwner(wire);
  }

  async sendTranslationPatchToOwner({ targetClientMessageId, translatedText, source = null }) {
    const wire = encodeBridgeTranslationPatchPayload(
      targetClientMessageId,
      translatedText,
      encodeBase64Url(this.publicParts.encPublicKey),
      source
    );
    await this.sendPayloadToOwner(wire, 'bridge_translation_patch');
  }

  async sendPlaceholderToOwner(placeholderKind, source = null) {
    const wire = encodeBridgePlaceholderPayload(
      placeholderKind,
      encodeBase64Url(this.publicParts.encPublicKey),
      source
    );
    await this.sendPayloadToOwner(wire);
  }

  async syncPull() {
    try {
      await this.ensureAuthenticated();
      const response = await this.nodeClient.pullMessages(this.token);
      const messages = response.messages || [];
      if (!messages.length) return;
      for (const item of messages) {
        await this.handleIncoming(item.messageId, item.senderPubkey, item.ciphertext);
      }
      await this.nodeClient.ackBatch(this.token, messages.map(item => item.messageId));
    } catch (error) {
      console.warn(`[BAG] batlink pull failed waJid=${this.binding.waJid} err=${error}`);
    }
  }

  connectWebSocket() {
    const wsUrl = `${this.config.nodeBaseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}${this.config.wsPath}?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.on('open', () => {
      console.log(`[BAG] batlink ws open waJid=${this.binding.waJid}`);
    });
    ws.on('message', async raw => {
      try {
        const payload = JSON.parse(raw.toString('utf8'));
        if (payload.type === 'server.ping') {
          ws.send(JSON.stringify({ type: 'client.pong' }));
          return;
        }
        if (payload.type === 'server.inbox.new') {
          await this.handleIncoming(payload.message_id, payload.sender_pubkey, payload.ciphertext);
          if (this.token) {
            await this.nodeClient.ackBatch(this.token, [payload.message_id]);
          }
        }
      } catch (error) {
        console.warn(`[BAG] batlink ws message parse failed waJid=${this.binding.waJid} err=${error}`);
      }
    });
    ws.on('close', () => {
      console.warn(`[BAG] batlink ws closed waJid=${this.binding.waJid}`);
      this.ws = null;
    });
    ws.on('error', error => {
      console.warn(`[BAG] batlink ws error waJid=${this.binding.waJid} err=${error}`);
      this.ws = null;
    });
  }

  async handleIncoming(messageId, senderPubkey, ciphertext) {
    if (!messageId || this.deliveredIds.has(messageId)) {
      if (messageId) console.log(`[BAG] skip duplicate inbound waJid=${this.binding.waJid} messageId=${messageId}`);
      return;
    }
    if (senderPubkey !== encodeBase64Url(this.ownerParts.signPublicKey)) {
      return;
    }
    this.deliveredIds.add(messageId);
    try {
      const plain = decryptMessage(ciphertext, this.privateParts.encPrivateKey);
      const payload = parsePayload(plain);
      await this.onOwnerMessage(payload);
    } catch (error) {
      this.deliveredIds.delete(messageId);
      console.warn(`[BAG] inbound owner message failed waJid=${this.binding.waJid} err=${error}`);
    }
  }
}
