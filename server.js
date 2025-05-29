import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();
app.use(cors());
app.use(express.json());

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Endpoint de verificación
app.get('/api/status', (req, res) => {
  res.json({ status: '✅ API levantada correctamente' });
});

// Endpoint de autologin
app.post('/api/autologin', async (req, res) => {
  const { username, password, tenantUrl, webIntegrationId } = req.body;
  const returnto = req.headers.origin || 'http://localhost:5173';

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ]
    });

    const page = await browser.newPage();

    const loginUrl = new URL(`${tenantUrl}/login`);
    loginUrl.searchParams.append('returnto', returnto);
    loginUrl.searchParams.append('qlik-web-integration-id', webIntegrationId);

    await page.goto(loginUrl.toString(), { waitUntil: 'networkidle2', timeout: 60000 });

    await delay(5000); // espera carga de ADFS

    await page.type('#userNameInput', username);
    await page.type('#passwordInput', password);
    await page.click('#submitButton');

    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });

    await browser.close();

    res.json({ success: true, loggedViaPuppeteer: true });
  } catch (error) {
    console.error('🛑 Error en Puppeteer:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Escuchar en puerto dinámico para Render
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend Qlik Demo corriendo en http://localhost:${PORT}`);
});
