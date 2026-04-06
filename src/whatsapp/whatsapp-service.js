import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, { DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

function unwrapMessage(message) {
  let current = message;
  for (;;) {
    if (!current || typeof current !== 'object') return current;
    if (current.associatedChildMessage?.message) {
      current = current.associatedChildMessage.message;
      continue;
    }
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    if (current.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }
    return current;
  }
}

function extractText(message) {
  const raw = unwrapMessage(message);
  return raw?.conversation
    || raw?.extendedTextMessage?.text
    || raw?.imageMessage?.caption
    || raw?.videoMessage?.caption
    || raw?.documentMessage?.caption
    || raw?.documentWithCaptionMessage?.message?.documentMessage?.caption
    || raw?.editedMessage?.message?.protocolMessage?.editedMessage?.extendedTextMessage?.text
    || '';
}

function summarizeMessageTree(message) {
  const raw = unwrapMessage(message);
  const summary = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!value || typeof value !== 'object') {
      summary[key] = typeof value;
      continue;
    }
    summary[key] = Object.keys(value).slice(0, 12);
  }
  return summary;
}

function extractImageInfo(message) {
  const raw = unwrapMessage(message);
  const image = raw?.imageMessage;
  if (!image) return null;
  return {
    mime: image.mimetype || 'image/jpeg',
    width: Number(image.width || 0),
    height: Number(image.height || 0),
    caption: image.caption || ''
  };
}

function extractStickerInfo(message) {
  const raw = unwrapMessage(message);
  const sticker = raw?.stickerMessage;
  if (!sticker) return null;
  return {
    mime: sticker.mimetype || 'image/webp',
    width: Number(sticker.width || 0),
    height: Number(sticker.height || 0),
    isAnimated: Boolean(sticker.isAnimated)
  };
}

function extractContactInfo(message) {
  const raw = unwrapMessage(message);
  if (raw?.contactMessage) {
    return { kind: 'contact', count: 1 };
  }
  if (raw?.contactsArrayMessage) {
    const contacts = Array.isArray(raw.contactsArrayMessage.contacts) ? raw.contactsArrayMessage.contacts : [];
    return { kind: 'contact', count: contacts.length || 1 };
  }
  return null;
}

function extractLocationInfo(message) {
  const raw = unwrapMessage(message);
  const location = raw?.locationMessage || raw?.liveLocationMessage;
  if (!location) return null;
  const latitude = Number(location.degreesLatitude ?? location.degreesLatitudeE7 / 1e7 ?? 0);
  const longitude = Number(location.degreesLongitude ?? location.degreesLongitudeE7 / 1e7 ?? 0);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) return null;
  return {
    latitude,
    longitude,
    name: location.name || '',
    address: location.address || '',
    isLive: Boolean(raw?.liveLocationMessage)
  };
}

function extractAudioInfo(message) {
  const raw = unwrapMessage(message);
  const audio = raw?.audioMessage;
  if (!audio) return null;
  return {
    mime: audio.mimetype || '',
    seconds: Number(audio.seconds || 0),
    ptt: Boolean(audio.ptt),
    fileLength: Number(audio.fileLength || 0)
  };
}

function normalizeWaveform(rawWaveform) {
  if (!rawWaveform) return null;
  if (Array.isArray(rawWaveform)) {
    return rawWaveform.map(value => Number(value) || 0).slice(0, 64);
  }
  if (ArrayBuffer.isView(rawWaveform)) {
    return Array.from(rawWaveform).map(value => Number(value) || 0).slice(0, 64);
  }
  return null;
}

function extractSpecialPlaceholderInfo(message) {
  const raw = unwrapMessage(message);
  if (raw?.contactMessage || raw?.contactsArrayMessage) {
    return { placeholderKind: 'whatsapp_special', subtype: 'contact' };
  }
  if (raw?.pollCreationMessage || raw?.pollCreationMessageV2 || raw?.pollCreationMessageV3) {
    return { placeholderKind: 'whatsapp_special', subtype: 'poll' };
  }
  if (raw?.eventMessage) {
    return { placeholderKind: 'whatsapp_special', subtype: 'event' };
  }
  return null;
}

function isPrivateChatJid(remoteJid) {
  return remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
}

export class WhatsAppService {
  constructor(sessionPath) {
    this.sessionPath = sessionPath;
    this.sock = null;
    this.qrText = '';
    this.qrDataUrl = '';
    this.status = 'idle';
    this.lastError = '';
    this.messageHandler = null;
    fs.mkdirSync(path.resolve(sessionPath), { recursive: true });
  }

  setMessageHandler(handler) {
    this.messageHandler = handler;
  }

  getStatus() {
    return {
      status: this.status,
      qrAvailable: Boolean(this.qrDataUrl),
      lastError: this.lastError || ''
    };
  }

  getQrDataUrl() {
    return this.qrDataUrl;
  }

  async start() {
    await this.connect();
  }

  async fetchProfilePhotoUrl(remoteJid) {
    if (!this.sock) return '';
    try {
      const url = await this.sock.profilePictureUrl(remoteJid, 'image');
      return url || '';
    } catch {
      return '';
    }
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    this.status = 'connecting';
    console.log(`[WA] connecting version=${version.join('.')}`);
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['BatlinkGateway', 'Chrome', '1.0.0']
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.qrText = qr;
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 8 });
        this.status = 'qr';
        console.log('[WA] qr updated');
      }
      if (connection === 'open') {
        this.status = 'connected';
        this.qrText = '';
        this.qrDataUrl = '';
        this.lastError = '';
        console.log('[WA] connected');
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        this.status = 'disconnected';
        this.lastError = String(statusCode || 'unknown');
        console.warn(`[WA] closed statusCode=${statusCode || 'unknown'}`);
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => this.connect().catch(err => {
            this.lastError = String(err);
            console.warn(`[WA] reconnect failed err=${err}`);
          }), 2000);
        }
      }
    });

    sock.ev.on('messages.upsert', async event => {
      console.log(`[WA] upsert type=${event.type} count=${(event.messages || []).length}`);
      if (event.type !== 'notify') return;
      for (const item of event.messages || []) {
        const remoteJid = item.key.remoteJid || '';
        const fromMe = Boolean(item.key.fromMe);
        const messageType = item.message ? Object.keys(item.message).join(',') : 'none';
        console.log(`[WA] message jid=${remoteJid} fromMe=${fromMe} type=${messageType}`);
        if (!item.message) continue;
        if (fromMe) continue;
        if (remoteJid === 'status@broadcast') continue;
        if (!isPrivateChatJid(remoteJid)) continue;
        const pushName = item.pushName || '';
        const headPhotoUrl = await this.fetchProfilePhotoUrl(remoteJid);
        const imageInfo = extractImageInfo(item.message);
        if (imageInfo) {
          try {
            const imageData = await downloadMediaMessage(
              item,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }), reuploadRequest: this.sock.updateMediaMessage }
            );
            console.log(`[WA] inbound private image jid=${remoteJid} bytes=${imageData.length} mime=${imageInfo.mime} size=${imageInfo.width}x${imageInfo.height} captionLen=${imageInfo.caption.length}`);
            await this.messageHandler?.({
              kind: 'image',
              waJid: remoteJid,
              pushName,
              fullName: pushName,
              headPhotoUrl,
              imageData,
              mime: imageInfo.mime,
              width: imageInfo.width,
              height: imageInfo.height,
              caption: imageInfo.caption,
              messageId: item.key.id || ''
            });
            continue;
          } catch (error) {
            console.warn(`[WA] image download failed jid=${remoteJid} err=${error}`);
          }
        }
        const stickerInfo = extractStickerInfo(item.message);
        if (stickerInfo) {
          try {
            const imageData = await downloadMediaMessage(
              item,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }), reuploadRequest: this.sock.updateMediaMessage }
            );
            console.log(`[WA] inbound private sticker jid=${remoteJid} bytes=${imageData.length} mime=${stickerInfo.mime} size=${stickerInfo.width}x${stickerInfo.height} animated=${stickerInfo.isAnimated}`);
            await this.messageHandler?.({
              kind: 'image',
              waJid: remoteJid,
              pushName,
              fullName: pushName,
              headPhotoUrl,
              imageData,
              mime: stickerInfo.mime,
              width: stickerInfo.width,
              height: stickerInfo.height,
              caption: '',
              messageId: item.key.id || '',
              mediaKind: 'sticker',
              isAnimated: stickerInfo.isAnimated
            });
            continue;
          } catch (error) {
            console.warn(`[WA] sticker download failed jid=${remoteJid} err=${error}`);
          }
        }
        const specialInfo = extractSpecialPlaceholderInfo(item.message);
        if (specialInfo) {
          console.log(`[WA] inbound private special jid=${remoteJid} subtype=${specialInfo.subtype}`);
          await this.messageHandler?.({
            kind: 'placeholder',
            waJid: remoteJid,
            pushName,
            fullName: pushName,
            headPhotoUrl,
            placeholderKind: specialInfo.placeholderKind,
            specialSubtype: specialInfo.subtype,
            messageId: item.key.id || ''
          });
          continue;
        }
        const locationInfo = extractLocationInfo(item.message);
        if (locationInfo) {
          console.log(`[WA] inbound private location jid=${remoteJid} lat=${locationInfo.latitude} lng=${locationInfo.longitude} live=${locationInfo.isLive}`);
          await this.messageHandler?.({
            kind: 'location',
            waJid: remoteJid,
            pushName,
            fullName: pushName,
            headPhotoUrl,
            latitude: locationInfo.latitude,
            longitude: locationInfo.longitude,
            name: locationInfo.name,
            address: locationInfo.address,
            isLive: locationInfo.isLive,
            messageId: item.key.id || ''
          });
          continue;
        }
        const audioInfo = extractAudioInfo(item.message);
        if (audioInfo) {
          console.log(`[WADEBUG] audio jid=${remoteJid} mime=${audioInfo.mime || 'unknown'} seconds=${audioInfo.seconds} ptt=${audioInfo.ptt} fileLength=${audioInfo.fileLength}`);
          try {
            const audioData = await downloadMediaMessage(
              item,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }), reuploadRequest: this.sock.updateMediaMessage }
            );
            const waveform = normalizeWaveform(unwrapMessage(item.message)?.audioMessage?.waveform);
            console.log(`[WA] inbound private voice jid=${remoteJid} bytes=${audioData.length} mime=${audioInfo.mime || 'unknown'} seconds=${audioInfo.seconds} ptt=${audioInfo.ptt}`);
            await this.messageHandler?.({
              kind: 'voice',
              waJid: remoteJid,
              pushName,
              fullName: pushName,
              headPhotoUrl,
              audioData,
              mime: audioInfo.mime || 'audio/ogg',
              durationMs: Math.max(0, audioInfo.seconds) * 1000,
              waveform,
              messageId: item.key.id || ''
            });
            continue;
          } catch (error) {
            console.warn(`[WA] voice download failed jid=${remoteJid} err=${error}`);
          }
        }
        const text = extractText(item.message).trim();
        if (text) {
          console.log(`[WA] inbound private text jid=${remoteJid} textLen=${text.length}`);
          await this.messageHandler?.({
            kind: 'text',
            waJid: remoteJid,
            pushName,
            fullName: pushName,
            headPhotoUrl,
            text,
            messageId: item.key.id || ''
          });
          continue;
        }
        console.log(`[WADEBUG] non-text jid=${remoteJid} type=${messageType} summary=${JSON.stringify(summarizeMessageTree(item.message))}`);
      }
    });
  }

  async sendText(waJid, text) {
    if (!this.sock || this.status !== 'connected') throw new Error('whatsapp_not_connected');
    await this.sock.sendMessage(waJid, { text });
  }

  async sendImage(waJid, imageData, mime, caption = '') {
    if (!this.sock || this.status !== 'connected') throw new Error('whatsapp_not_connected');
    await this.sock.sendMessage(waJid, {
      image: Buffer.from(imageData),
      mimetype: mime || 'image/jpeg',
      caption: caption || undefined
    });
  }

  async sendVoice(waJid, audioData, mime = 'audio/mp4') {
    if (!this.sock || this.status !== 'connected') throw new Error('whatsapp_not_connected');
    await this.sock.sendMessage(waJid, {
      audio: Buffer.from(audioData),
      mimetype: mime || 'audio/mp4',
      ptt: true
    });
  }
}
