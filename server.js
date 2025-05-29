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

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'shell',
      executablePath: puppeteer.executablePath(), // No necesitas process.env en este caso
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36');

    const loginUrl = new URL(`${tenantUrl}/login`);
    loginUrl.searchParams.append('returnto', returnto);
    loginUrl.searchParams.append('qlik-web-integration-id', webIntegrationId);

    let success = false;
    for (let i = 0; i < 5; i++) {
      console.log(`🔁 Intento ${i + 1}: navegando a ${loginUrl}`);
      try {
        await page.goto(loginUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 60000 + i * 20000,
        });

        console.log('✅ Página cargada');

        await delay(5000); // Espera que cargue el ADFS

        const userInput = await page.$('#userNameInput');
        const passInput = await page.$('#passwordInput');
        const submitButton = await page.$('#submitButton');

        if (!userInput || !passInput || !submitButton) {
          throw new Error('No se encontraron los campos de login');
        }

        await userInput.type(username, { delay: 50 });
        await passInput.type(password, { delay: 50 });
        await submitButton.click();

        console.log('🚀 Formulario enviado, esperando redirección...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

        console.log('✅ Login exitoso');
        success = true;
        break;
      } catch (e) {
        console.warn(`⚠️ Fallo intento ${i + 1}: ${e.message}`);
        await delay(3000);
      }
    }

    await browser.close();

    if (!success) {
      throw new Error('No se pudo completar el login tras múltiples intentos');
    }

    res.json({ success: true, loggedViaPuppeteer: true });
  } catch (error) {
    console.error('🛑 Error final en Puppeteer:', error.message);
    if (browser) await browser.close();
    res.status(500).json({ success: false, message: error.message });
  }
});

// Escuchar en puerto dinámico para Render
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend Qlik Demo corriendo en http://localhost:${PORT}`);
});
