export function encodeTextPayload(text, senderEncPubkey, source = null, options = {}) {
  return JSON.stringify({
    v: 2,
    type: 'text',
    text,
    clientMessageId: options.clientMessageId || null,
    bridgeOriginalText: options.bridgeOriginalText || null,
    bridgeTranslatedText: options.bridgeTranslatedText || null,
    bridgeTranslationDirection: options.bridgeTranslationDirection || null,
    senderEncPubkey,
    source,
    hasPeerWalletCard: null,
    walletCard: null
  });
}

export function encodeImagePayload({
  imageData,
  mime,
  width,
  height,
  senderEncPubkey
}) {
  return JSON.stringify({
    v: 2,
    type: 'image',
    imageB64: Buffer.from(imageData).toString('base64url'),
    imageMime: mime,
    imageWidth: width,
    imageHeight: height,
    imageBytes: imageData.length,
    senderEncPubkey,
    hasPeerWalletCard: null,
    walletCard: null
  });
}

export function encodeVoicePayload({
  audioData,
  durationMs,
  waveform = null,
  senderEncPubkey,
  source = null,
  options = {}
}) {
  return JSON.stringify({
    v: 2,
    type: 'voice',
    voiceB64: Buffer.from(audioData).toString('base64url'),
    durationMs,
    voiceWaveform: Array.isArray(waveform) ? waveform : null,
    clientMessageId: options.clientMessageId || null,
    bridgeOriginalText: options.bridgeOriginalText || null,
    bridgeTranslatedText: options.bridgeTranslatedText || null,
    bridgeTranslationDirection: options.bridgeTranslationDirection || null,
    senderEncPubkey,
    source,
    hasPeerWalletCard: null,
    walletCard: null
  });
}

export function encodeSitePayload({
  title,
  url,
  iconUrl = null,
  senderEncPubkey
}) {
  return JSON.stringify({
    v: 2,
    type: 'site',
    siteTitle: title,
    siteUrl: url,
    siteIconUrl: iconUrl,
    senderEncPubkey,
    hasPeerWalletCard: null,
    walletCard: null
  });
}

export function encodeBridgeControlPayload(action, requestId, translation, senderEncPubkey) {
  return JSON.stringify({
    v: 2,
    type: 'bridge.control',
    action,
    requestId,
    translation,
    senderEncPubkey
  });
}

export function encodeBridgeControlAckPayload(action, requestId, ok, translation, error, senderEncPubkey) {
  return JSON.stringify({
    v: 2,
    type: 'bridge.control.ack',
    action,
    requestId,
    ok,
    translation,
    error,
    senderEncPubkey
  });
}

export function encodeBridgeTranslationPatchPayload(targetClientMessageId, translatedText, senderEncPubkey, source = null) {
  return JSON.stringify({
    v: 2,
    type: 'bridge.translation.patch',
    targetClientMessageId,
    bridgeTranslatedText: translatedText,
    senderEncPubkey,
    source
  });
}

export function encodeBridgePlaceholderPayload(placeholderKind, senderEncPubkey, source = null) {
  return JSON.stringify({
    v: 2,
    type: 'bridge.placeholder',
    placeholderKind,
    senderEncPubkey,
    source
  });
}

export function parsePayload(plain) {
  try {
    const payload = JSON.parse(plain);
    if (payload && typeof payload === 'object' && typeof payload.type === 'string') {
      return payload;
    }
    return { type: 'text', text: plain, source: null };
  } catch {
    return { type: 'text', text: plain, source: null };
  }
}

export function decodeTextPayload(plain) {
  const payload = parsePayload(plain);
  if (payload.type === 'text' && typeof payload.text === 'string') {
    return {
      text: payload.text,
      source: payload.source ?? null
    };
  }
  if (payload.type === 'image') return '[Image]';
  if (payload.type === 'voice') return '[Voice]';
  if (payload.type === 'transfer') return '[Transfer]';
  if (payload.type === 'site') return '[Site]';
  if (payload.type === 'bridge.placeholder') return '[Placeholder]';
  return plain;
}
