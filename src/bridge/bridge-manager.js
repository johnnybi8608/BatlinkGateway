import { NodeClient } from '../batlink/node-client.js';
import { BatlinkSession } from '../batlink/session.js';
import { OpenAITranslationService } from '../translation/openai-translation-service.js';

export class BridgeManager {
  constructor({ config, bindingStore, whatsappService }) {
    this.config = config;
    this.bindingStore = bindingStore;
    this.whatsappService = whatsappService;
    this.nodeClient = new NodeClient(config.batlink);
    this.translationService = new OpenAITranslationService(config.openai || {});
    this.sessions = new Map();
  }

  async start() {
    if (!this.config.batlink.ownerPublicKey) {
      console.warn('[BAG] owner public key is empty; WA->Batlink forwarding is disabled until configured');
    }
    this.whatsappService.setMessageHandler(payload => this.handleWhatsAppInbound(payload));
    await this.whatsappService.start();
    if (this.config.batlink.ownerPublicKey) {
      for (const binding of this.bindingStore.all()) {
        await this.ensureSession(binding);
      }
    }
    setInterval(() => {
      for (const session of this.sessions.values()) {
        session.syncPull().catch(error => {
          console.warn(`[BAG] sync pull loop failed waJid=${session.binding.waJid} err=${error}`);
        });
        session.ensureConnected().catch(error => {
          console.warn(`[BAG] ensure connected loop failed waJid=${session.binding.waJid} err=${error}`);
        });
      }
    }, 15000).unref();
  }

  getStatus() {
    return {
      bindings: this.bindingStore.all().length,
      sessions: this.sessions.size,
      openaiConfigured: this.translationService.isConfigured()
    };
  }

  buildSource(binding) {
    return {
      client: 'BATLINKWHATSAPP',
      displayName: binding.fullName || binding.pushName || '',
      headPhotoUrl: binding.headPhotoUrl || '',
      translation: {
        enabled: Boolean(binding.translation?.enabled),
        peerLanguage: binding.translation?.peerLanguage || '',
        myLanguage: binding.translation?.myLanguage || ''
      }
    };
  }

  async maybeTranslate({ text, targetLanguage, sourceLanguage, direction, waJid }) {
    if (!targetLanguage) return text;
    try {
      const translated = await this.translationService.translate({
        text,
        targetLanguage,
        sourceLanguage
      });
      console.log(`[BAG] translation ok direction=${direction} waJid=${waJid} target=${targetLanguage}`);
      const normalized = typeof translated === 'string' ? translated.trim() : '';
      return normalized || text.trim();
    } catch (error) {
      console.warn(`[BAG] translation fallback direction=${direction} waJid=${waJid} target=${targetLanguage} err=${error}`);
      return text.trim();
    }
  }

  async maybeTranscribeAudio({ audioData, mimeType, filename, waJid, direction }) {
    try {
      const transcript = await this.translationService.transcribeAudio({
        audioData,
        mimeType,
        filename
      });
      console.log(`[BAG] transcription ok direction=${direction} waJid=${waJid} textLen=${transcript.length}`);
      return transcript.trim();
    } catch (error) {
      console.warn(`[BAG] transcription fallback direction=${direction} waJid=${waJid} err=${error}`);
      return '';
    }
  }

  async handleWhatsAppInbound(payload) {
    const { waJid, pushName, fullName, headPhotoUrl } = payload;
    if (!this.config.batlink.ownerPublicKey) {
      console.warn(`[BAG] skip WA->Batlink owner public key not configured waJid=${waJid}`);
      return;
    }
    const binding = this.bindingStore.getOrCreateWhatsAppBinding({ waJid, pushName, fullName, headPhotoUrl });
    const session = await this.ensureSession(binding);
    if (payload.kind === 'image') {
      const captionText = typeof payload.caption === 'string' ? payload.caption.trim() : '';
      const translatedCaption = captionText
        ? (binding.translation?.enabled
            ? await this.maybeTranslate({
                text: captionText,
                targetLanguage: binding.translation.myLanguage,
                sourceLanguage: binding.translation.peerLanguage,
                direction: 'wa_to_batlink_caption',
                waJid
              })
            : captionText)
        : '';
      const baseCreatedAt = Math.floor(Date.now() / 1000);
      const imageSendPromise = session.sendImageToOwner({
        imageData: payload.imageData,
        mime: payload.mime,
        width: payload.width,
        height: payload.height
      }, { createdAt: baseCreatedAt });
      let captionSendPromise = Promise.resolve();
      if (translatedCaption) {
        captionSendPromise = session.sendTextToOwner(
          translatedCaption,
          this.buildSource(binding),
          binding.translation?.enabled
            ? {
                bridgeOriginalText: captionText,
                bridgeTranslatedText: translatedCaption,
                bridgeTranslationDirection: 'inbound'
              }
            : {},
          { createdAt: baseCreatedAt + 1 }
        );
      }
      await imageSendPromise;
      console.log(`[BAG] forwarded WA->Batlink image waJid=${waJid} bytes=${payload.imageData.length} mime=${payload.mime} size=${payload.width}x${payload.height} caption=${captionText ? 'yes' : 'no'}`);
      if (translatedCaption) {
        await captionSendPromise;
        console.log(`[BAG] forwarded WA->Batlink image caption waJid=${waJid} textLen=${translatedCaption.length}`);
      }
      return;
    }
    if (payload.kind === 'voice') {
      let translatedTranscript = '';
      let transcript = '';
      if (binding.translation?.enabled) {
        transcript = await this.maybeTranscribeAudio({
          audioData: payload.audioData,
          mimeType: payload.mime || 'audio/ogg',
          filename: 'voice.ogg',
          waJid,
          direction: 'wa_to_batlink_voice'
        });
        if (transcript) {
          translatedTranscript = await this.maybeTranslate({
            text: transcript,
            targetLanguage: binding.translation.myLanguage,
            sourceLanguage: binding.translation.peerLanguage,
            direction: 'wa_to_batlink_voice_text',
            waJid
          });
        }
      }
      await session.sendVoiceToOwner({
        audioData: payload.audioData,
        durationMs: payload.durationMs,
        waveform: payload.waveform
      },
      this.buildSource(binding),
      translatedTranscript
        ? {
            bridgeOriginalText: transcript,
            bridgeTranslatedText: translatedTranscript,
            bridgeTranslationDirection: 'inbound'
          }
        : {},
      null);
      console.log(`[BAG] forwarded WA->Batlink voice waJid=${waJid} bytes=${payload.audioData.length} mime=${payload.mime} durationMs=${payload.durationMs}`);
      return;
    }
    if (payload.kind === 'placeholder') {
      await session.sendPlaceholderToOwner(payload.placeholderKind || 'whatsapp_special', this.buildSource(binding));
      console.log(`[BAG] forwarded WA->Batlink special placeholder waJid=${waJid} subtype=${payload.specialSubtype || 'unknown'}`);
      return;
    }
    if (payload.kind === 'location') {
      const lat = Number(payload.latitude);
      const lng = Number(payload.longitude);
      const titleBase = payload.name || payload.address || (payload.isLive ? '__whatsapp_live_location__' : '__whatsapp_location__');
      const label = encodeURIComponent(titleBase);
      const mapUrl = `http://maps.apple.com/?ll=${lat},${lng}&q=${label}`;
      await session.sendSiteToOwner({
        title: titleBase,
        url: mapUrl,
        iconUrl: null
      });
      console.log(`[BAG] forwarded WA->Batlink location waJid=${waJid} lat=${lat} lng=${lng} live=${Boolean(payload.isLive)}`);
      return;
    }
    if (payload.kind !== 'text') {
      console.log(`[BAG] skip unsupported inbound kind=${payload.kind} waJid=${waJid}`);
      return;
    }
    const inboundText = payload.text.trim();
    const translatedText = binding.translation?.enabled
      ? await this.maybeTranslate({
          text: inboundText,
          targetLanguage: binding.translation.myLanguage,
          sourceLanguage: binding.translation.peerLanguage,
          direction: 'wa_to_batlink',
          waJid
        })
      : inboundText;
    await session.sendTextToOwner(
      translatedText,
      this.buildSource(binding),
      binding.translation?.enabled
        ? {
            bridgeOriginalText: inboundText,
            bridgeTranslatedText: translatedText,
            bridgeTranslationDirection: 'inbound'
          }
        : {}
    );
    console.log(`[BAG] forwarded WA->Batlink text waJid=${waJid} textLen=${translatedText.length}`);
  }

  async ensureSession(binding) {
    if (!this.config.batlink.ownerPublicKey) {
      throw new Error('owner_public_key_not_configured');
    }
    if (this.sessions.has(binding.waJid)) {
      return this.sessions.get(binding.waJid);
    }
    const session = new BatlinkSession({
      config: this.config.batlink,
      nodeClient: this.nodeClient,
      binding,
      ownerPublicKey: this.config.batlink.ownerPublicKey,
      onOwnerMessage: async payload => {
        if (payload?.type === 'bridge.control') {
          await this.handleOwnerControl(binding, session, payload);
          return;
        }
        const latestBinding = this.bindingStore.getByWaJid(binding.waJid) || binding;
        if (payload?.type === 'image' && typeof payload.imageB64 === 'string') {
          const imageData = Buffer.from(payload.imageB64, 'base64url');
          const mime = typeof payload.imageMime === 'string' && payload.imageMime ? payload.imageMime : 'image/jpeg';
          await this.whatsappService.sendImage(latestBinding.waJid, imageData, mime);
          console.log(`[BAG] forwarded Batlink->WA image waJid=${latestBinding.waJid} bytes=${imageData.length} mime=${mime}`);
          return;
        }
        if (payload?.type === 'voice' && typeof payload.voiceB64 === 'string') {
          const audioData = Buffer.from(payload.voiceB64, 'base64url');
          const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 0;
          let translatedTranscript = '';
          if (latestBinding.translation?.enabled) {
            const transcript = await this.maybeTranscribeAudio({
              audioData,
              mimeType: 'audio/mp4',
              filename: 'voice.m4a',
              waJid: latestBinding.waJid,
              direction: 'batlink_to_wa_voice'
            });
            if (transcript) {
              translatedTranscript = await this.maybeTranslate({
                text: transcript,
                targetLanguage: latestBinding.translation.peerLanguage,
                sourceLanguage: latestBinding.translation.myLanguage,
                direction: 'batlink_to_wa_voice_text',
                waJid: latestBinding.waJid
              });
            }
          }
          if (translatedTranscript) {
            await this.whatsappService.sendText(latestBinding.waJid, translatedTranscript);
            console.log(`[BAG] forwarded Batlink->WA voice transcript waJid=${latestBinding.waJid} textLen=${translatedTranscript.length}`);
            if (payload.clientMessageId && typeof payload.clientMessageId === 'string') {
              await session.sendTranslationPatchToOwner({
                targetClientMessageId: payload.clientMessageId,
                translatedText: translatedTranscript,
                source: this.buildSource(latestBinding)
              });
              console.log(`[BAG] returned voice translation patch waJid=${latestBinding.waJid} target=${payload.clientMessageId}`);
            }
          } else {
            await this.whatsappService.sendVoice(latestBinding.waJid, audioData, 'audio/mp4');
            console.log(`[BAG] forwarded Batlink->WA voice waJid=${latestBinding.waJid} bytes=${audioData.length} durationMs=${durationMs}`);
          }
          return;
        }
        if (payload?.type !== 'text' || typeof payload.text !== 'string') {
          return;
        }
        const originalOutboundText = payload.text;
        const outboundText = latestBinding.translation?.enabled
          ? await this.maybeTranslate({
            text: originalOutboundText,
            targetLanguage: latestBinding.translation.peerLanguage,
            sourceLanguage: latestBinding.translation.myLanguage,
            direction: 'batlink_to_wa',
            waJid: latestBinding.waJid
          })
          : originalOutboundText;
        await this.whatsappService.sendText(latestBinding.waJid, outboundText);
        console.log(`[BAG] forwarded Batlink->WA waJid=${latestBinding.waJid} textLen=${outboundText.length}`);
        if (latestBinding.translation?.enabled && payload.clientMessageId && typeof payload.clientMessageId === 'string') {
          await session.sendTranslationPatchToOwner({
            targetClientMessageId: payload.clientMessageId,
            translatedText: outboundText,
            source: this.buildSource(latestBinding)
          });
          console.log(`[BAG] returned translation patch waJid=${latestBinding.waJid} target=${payload.clientMessageId}`);
        }
      }
    });
    this.sessions.set(binding.waJid, session);
    await session.start();
    return session;
  }

  async handleOwnerControl(binding, session, payload) {
    const action = payload?.action || '';
    const requestId = payload?.requestId || '';
    if (action !== 'translation.update' || !requestId) {
      await session.sendControlAckToOwner({
        action,
        requestId,
        ok: false,
        error: 'unsupported_action'
      });
      return;
    }
    const next = {
      enabled: Boolean(payload?.translation?.enabled),
      peerLanguage: typeof payload?.translation?.peerLanguage === 'string' ? payload.translation.peerLanguage : '',
      myLanguage: typeof payload?.translation?.myLanguage === 'string' ? payload.translation.myLanguage : ''
    };
    if (next.enabled && (!next.peerLanguage || !next.myLanguage)) {
      await session.sendControlAckToOwner({
        action,
        requestId,
        ok: false,
        error: 'language_missing'
      });
      return;
    }
    const updated = this.bindingStore.updateTranslation(binding.waJid, next);
    if (!updated) {
      await session.sendControlAckToOwner({
        action,
        requestId,
        ok: false,
        error: 'binding_not_found'
      });
      return;
    }
    session.binding = updated;
    await session.sendControlAckToOwner({
      action,
      requestId,
      ok: true,
      payload: updated.translation
    });
    console.log(`[BAG] translation settings updated waJid=${updated.waJid} enabled=${updated.translation.enabled} peer=${updated.translation.peerLanguage} my=${updated.translation.myLanguage}`);
  }
}
