import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) {
    return extra ?? base;
  }
  if (base && typeof base === 'object' && extra && typeof extra === 'object') {
    const out = { ...base };
    for (const key of Object.keys(extra)) {
      out[key] = deepMerge(base[key], extra[key]);
    }
    return out;
  }
  return extra ?? base;
}

export function loadConfig() {
  const defaultPath = path.join(projectRoot, 'config', 'default.json');
  const localPath = path.join(projectRoot, 'config', 'local.json');
  const defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const merged = deepMerge(defaults, local);
  return {
    ...merged,
    projectRoot,
    storage: {
      ...merged.storage,
      bindingsFile: path.resolve(projectRoot, merged.storage.bindingsFile)
    },
    whatsapp: {
      ...merged.whatsapp,
      sessionPath: path.resolve(projectRoot, merged.whatsapp.sessionPath)
    }
  };
}
