import fs from 'node:fs';
import path from 'node:path';
import { generateBridgeIdentity } from '../utils/key-format.js';

export class BindingStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.bindings = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      return;
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    for (const binding of raw) {
      binding.translation = this.normalizeTranslation(binding.translation);
      this.bindings.set(binding.waJid, binding);
    }
    console.log(`[BAG] bindings loaded count=${this.bindings.size} file=${this.filePath}`);
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify([...this.bindings.values()], null, 2));
  }

  normalizeTranslation(value) {
    return {
      enabled: Boolean(value?.enabled),
      peerLanguage: typeof value?.peerLanguage === 'string' ? value.peerLanguage : '',
      myLanguage: typeof value?.myLanguage === 'string' ? value.myLanguage : ''
    };
  }

  all() {
    return [...this.bindings.values()];
  }

  getByWaJid(waJid) {
    return this.bindings.get(waJid) || null;
  }

  getOrCreateWhatsAppBinding({ waJid, pushName, fullName, headPhotoUrl }) {
    const existing = this.bindings.get(waJid);
    const now = Math.floor(Date.now() / 1000);
    if (existing) {
      existing.pushName = pushName || existing.pushName || '';
      existing.fullName = fullName || existing.fullName || '';
      existing.headPhotoUrl = headPhotoUrl || existing.headPhotoUrl || '';
      existing.translation = this.normalizeTranslation(existing.translation);
      existing.updatedAt = now;
      this.save();
      return existing;
    }
    const identity = generateBridgeIdentity();
    const binding = {
      waJid,
      pushName: pushName || '',
      fullName: fullName || '',
      headPhotoUrl: headPhotoUrl || '',
      bridgePrivateKey: identity.privateKey,
      bridgePublicKey: identity.publicKey,
      translation: this.normalizeTranslation(null),
      createdAt: now,
      updatedAt: now,
      introSent: false
    };
    this.bindings.set(waJid, binding);
    this.save();
    console.log(`[BAG] binding created waJid=${waJid} bridgePub=${binding.bridgePublicKey}`);
    return binding;
  }

  updateTranslation(waJid, translation) {
    const existing = this.bindings.get(waJid);
    if (!existing) return null;
    existing.translation = this.normalizeTranslation(translation);
    existing.updatedAt = Math.floor(Date.now() / 1000);
    this.save();
    return existing;
  }
}
