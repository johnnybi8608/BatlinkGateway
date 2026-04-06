import { loadConfig } from './config/load-config.js';
import { BindingStore } from './store/binding-store.js';
import { WhatsAppService } from './whatsapp/whatsapp-service.js';
import { BridgeManager } from './bridge/bridge-manager.js';
import { createHttpServer } from './http/server.js';

const config = loadConfig();
const bindingStore = new BindingStore(config.storage.bindingsFile);
const whatsappService = new WhatsAppService(config.whatsapp.sessionPath);
const bridgeManager = new BridgeManager({ config, bindingStore, whatsappService });
const app = createHttpServer({ config, bindingStore, whatsappService, bridgeManager });

await bridgeManager.start();

app.listen(config.http.port, config.http.host, () => {
  console.log(`[BAG] http listening host=${config.http.host} port=${config.http.port}`);
});
