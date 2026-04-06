import express from 'express';

export function createHttpServer({ config, bindingStore, whatsappService, bridgeManager }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/v1/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'batlink-gateway',
      ts: Math.floor(Date.now() / 1000),
      wa: whatsappService.getStatus(),
      bridge: bridgeManager.getStatus(),
      ownerConfigured: Boolean(config.batlink.ownerPublicKey)
    });
  });

  app.get('/v1/whatsapp/status', (_req, res) => {
    res.json(whatsappService.getStatus());
  });

  app.get('/v1/whatsapp/qr', (_req, res) => {
    const dataUrl = whatsappService.getQrDataUrl();
    if (!dataUrl) {
      res.status(404).json({ ok: false, message: 'qr_not_available' });
      return;
    }
    res.json({ ok: true, qrDataUrl: dataUrl });
  });

  app.get('/v1/whatsapp/qr.png', (_req, res) => {
    const dataUrl = whatsappService.getQrDataUrl();
    if (!dataUrl) {
      res.status(404).json({ ok: false, message: 'qr_not_available' });
      return;
    }
    const marker = 'base64,';
    const index = dataUrl.indexOf(marker);
    if (index < 0) {
      res.status(500).json({ ok: false, message: 'invalid_qr_data_url' });
      return;
    }
    const raw = Buffer.from(dataUrl.slice(index + marker.length), 'base64');
    res.setHeader('content-type', 'image/png');
    res.send(raw);
  });

  app.get('/v1/whatsapp/qr/view', (_req, res) => {
    const dataUrl = whatsappService.getQrDataUrl();
    if (!dataUrl) {
      res.status(404).send('qr_not_available');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp QR</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #111;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      }
      main {
        text-align: center;
      }
      img {
        width: min(80vw, 420px);
        height: auto;
        background: white;
        padding: 16px;
        border-radius: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <img src="${dataUrl}" alt="WhatsApp QR" />
    </main>
  </body>
</html>`);
  });

  app.get('/v1/bindings', (_req, res) => {
    res.json({
      ok: true,
      items: bindingStore.all().map(item => ({
        waJid: item.waJid,
        pushName: item.pushName,
        fullName: item.fullName,
        headPhotoUrl: item.headPhotoUrl || '',
        bridgePublicKey: item.bridgePublicKey,
        translation: item.translation || { enabled: false, peerLanguage: '', myLanguage: '' },
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }))
    });
  });

  return app;
}
