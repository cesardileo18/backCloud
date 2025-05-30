import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
const app = express();
app.use(cors());
app.use(express.json());
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
// Healthcheck
app.get('/api/status', (req, res) => {
  res.json({ status: ':marca_de_verificación_blanca: API levantada correctamente' });
});
// Función para extraer tokens específicos de Qlik
const extractQlikTokens = async (page) => {
  try {
    // 1. Capturar localStorage y sessionStorage
    const storageData = await page.evaluate(() => {
      const localStorage = {};
      const sessionStorage = {};
      // LocalStorage
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        localStorage[key] = window.localStorage.getItem(key);
      }
      // SessionStorage
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        sessionStorage[key] = window.sessionStorage.getItem(key);
      }
      return { localStorage, sessionStorage };
    });
    // 2. Buscar tokens específicos de Qlik en el almacenamiento
    const qlikTokens = {
      accessToken: null,
      csrfToken: null,
      sessionToken: null,
      bearerToken: null,
      qlikTicket: null
    };
    // Buscar en localStorage
    Object.keys(storageData.localStorage).forEach(key => {
      const value = storageData.localStorage[key];
      if (key.toLowerCase().includes('token') || key.toLowerCase().includes('csrf')) {
        qlikTokens[key] = value;
      }
      // Buscar patrones comunes de Qlik
      if (key.includes('qlik') || key.includes('sense')) {
        qlikTokens[key] = value;
      }
    });
    // Buscar en sessionStorage
    Object.keys(storageData.sessionStorage).forEach(key => {
      const value = storageData.sessionStorage[key];
      if (key.toLowerCase().includes('token') || key.toLowerCase().includes('csrf')) {
        qlikTokens[key] = value;
      }
      if (key.includes('qlik') || key.includes('sense')) {
        qlikTokens[key] = value;
      }
    });
    return { storageData, qlikTokens };
  } catch (error) {
    console.warn(':advertencia: Error extrayendo tokens:', error.message);
    return { storageData: {}, qlikTokens: {} };
  }
};
// Función para interceptar requests y capturar headers de autenticación
const setupRequestInterception = async (page) => {
  const capturedHeaders = [];
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const headers = request.headers();
    // Capturar headers importantes
    if (headers['authorization'] || headers['x-qlik-xrfkey'] || headers['cookie']) {
      capturedHeaders.push({
        url: request.url(),
        method: request.method(),
        headers: {
          authorization: headers['authorization'],
          'x-qlik-xrfkey': headers['x-qlik-xrfkey'],
          cookie: headers['cookie'],
          'x-csrf-token': headers['x-csrf-token']
        }
      });
    }
    request.continue();
  });
  return capturedHeaders;
};
// Endpoint de autologin mejorado
app.post('/api/autologin', async (req, res) => {
  const { username, password, tenantUrl, webIntegrationId } = req.body;
  const returnto = req.headers.origin || 'http://localhost:5173';
  let browser;
  let capturedHeaders = [];
  try {
    browser = await puppeteer.launch({
      headless: 'shell',
      executablePath: puppeteer.executablePath(),
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
    // Configurar interceptación de requests
    capturedHeaders = await setupRequestInterception(page);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36'
    );
    const loginUrl = new URL(`${tenantUrl}/login`);
    loginUrl.searchParams.append('returnto', returnto);
    loginUrl.searchParams.append('qlik-web-integration-id', webIntegrationId);
    let success = false;
    let cookies = [];
    let finalUrl = '';
    let tokens = {};
    for (let i = 0; i < 5; i++) {
      console.log(`:repetir: Intento ${i + 1}: navegando a ${loginUrl.toString()}`);
      try {
        await page.goto(loginUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 60000 + i * 20000,
        });
        console.log(':marca_de_verificación_blanca: Página cargada');
        await delay(5000);
        const userInput = await page.$('#userNameInput');
        const passInput = await page.$('#passwordInput');
        if (!userInput || !passInput) {
          throw new Error(':advertencia: No se encontraron los campos de login');
        }
        await userInput.type(username, { delay: 30 });
        await passInput.type(password, { delay: 30 });
        console.log(':cohete: Ejecutando Login.submitLoginRequest()');
        await page.evaluate(() => {
          Login.submitLoginRequest();
        });
        console.log(':cohete: Formulario enviado, esperando redirección...');
        await page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: 90000
        });
        // :marca_de_verificación_blanca: Capturar toda la información después del login
        cookies = await page.cookies();
        finalUrl = page.url();
        // Extraer tokens del almacenamiento del navegador
        const tokenData = await extractQlikTokens(page);
        tokens = tokenData;
        console.log(':marca_de_verificación_blanca: Login exitoso - Tokens capturados');
        success = true;
        break;
      } catch (e) {
        console.warn(`:advertencia: Fallo intento ${i + 1}: ${e.message}`);
        await delay(3000);
      }
    }
    await browser.close();
    if (!success) {
      return res.status(500).json({
        success: false,
        message: ':x: No se pudo completar el login tras múltiples intentos',
      });
    }
    // :dardo: Filtrar y organizar cookies importantes
    const importantCookies = cookies.filter(cookie =>
      cookie.name.toLowerCase().includes('session') ||
      cookie.name.toLowerCase().includes('token') ||
      cookie.name.toLowerCase().includes('auth') ||
      cookie.name.toLowerCase().includes('qlik') ||
      cookie.name.toLowerCase().includes('csrf')
    );
    // :dardo: Crear string de cookies para usar en el frontend
    const cookieString = cookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    // :marca_de_verificación_blanca: Respuesta completa con toda la información
    res.json({
      success: true,
      loggedViaPuppeteer: true,
      // Cookies completas
      allCookies: cookies,
      importantCookies,
      cookieString,
      // Tokens extraídos
      tokens: tokens.qlikTokens,
      storageData: tokens.storageData,
      // Headers capturados durante las peticiones
      capturedHeaders: capturedHeaders.slice(-10), // Los últimos 10
      // Info adicional
      finalUrl,
      tenantUrl,
      // Instrucciones para el frontend
      usage: {
        cookieHeader: `Cookie: ${cookieString}`,
        authorizationHeaders: capturedHeaders
          .filter(h => h.headers.authorization)
          .map(h => h.headers.authorization)
          .slice(-1)[0] // El último token de autorización
      }
    });
  } catch (error) {
    console.error(':señal_octogonal: Error en Puppeteer:', error.message);
    if (browser) await browser.close();
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
// Nuevo endpoint para validar tokens
app.post('/api/validate-token', async (req, res) => {
  const { cookieString, tenantUrl, authHeader } = req.body;
  try {
    // Hacer una petición de prueba a Qlik con los tokens
    const testUrl = `${tenantUrl}/api/v1/users/me`;
    const headers = {
      'Cookie': cookieString,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }
    const response = await fetch(testUrl, { headers });
    res.json({
      valid: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries())
    });
  } catch (error) {
    res.status(500).json({
      valid: false,
      error: error.message
    });
  }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`:cohete: Backend Qlik Demo corriendo en http://localhost:${PORT}`);
});