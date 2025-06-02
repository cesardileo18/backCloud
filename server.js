import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();
app.use(cors());
app.use(express.json());

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Healthcheck
app.get('/api/status', (req, res) => {
  res.json({ status: '✅ API levantada correctamente' });
});

// Configuración mejorada de Puppeteer para producción
const createBrowser = async () => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  const config = {
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-web-security',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--memory-pressure-off',
      '--max_old_space_size=4096'
    ],
    // Aumentar timeouts para Render
    protocolTimeout: 180000, // 3 minutos
    defaultViewport: { width: 1280, height: 720 },
  };

  if (isProduction) {
    // En producción, usar el Chromium de Playwright
    config.executablePath = '/usr/bin/chromium-browser';
  } else {
    config.executablePath = puppeteer.executablePath();
  }

  return await puppeteer.launch(config);
};

// Función para extraer tokens específicos de Qlik
const extractQlikTokens = async (page) => {
  try {
    const allData = await page.evaluate(() => {
      const localStorage = {};
      const sessionStorage = {};
      const globalVars = {};
      const metaTags = {};
      
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
      
      // Variables globales de Qlik
      try {
        if (window.qlik) globalVars.qlik = window.qlik;
        if (window.require) globalVars.requireConfig = window.require;
        if (window.csrfToken) globalVars.csrfToken = window.csrfToken;
        if (window.qlikToken) globalVars.qlikToken = window.qlikToken;
        if (window.authToken) globalVars.authToken = window.authToken;
        
        Object.keys(window).forEach(key => {
          if (key.toLowerCase().includes('token') || 
              key.toLowerCase().includes('csrf') ||
              key.toLowerCase().includes('auth') ||
              key.toLowerCase().includes('qlik')) {
            globalVars[key] = window[key];
          }
        });
      } catch (e) {
        console.warn('Error accessing global vars:', e);
      }
      
      // Meta tags con tokens
      const metaElements = document.querySelectorAll('meta[name*="token"], meta[name*="csrf"], meta[name*="auth"]');
      metaElements.forEach(meta => {
        metaTags[meta.getAttribute('name')] = meta.getAttribute('content');
      });
      
      return { localStorage, sessionStorage, globalVars, metaTags };
    });

    const csrfFromPage = await page.evaluate(() => {
      const csrfInput = document.querySelector('input[name="csrf_token"], input[name="_token"], input[name="csrfToken"]');
      if (csrfInput) return csrfInput.value;
      
      const csrfMeta = document.querySelector('meta[name="csrf-token"], meta[name="_token"]');
      if (csrfMeta) return csrfMeta.getAttribute('content');
      
      return null;
    });

    const qlikTokens = {
      accessToken: null,
      csrfToken: csrfFromPage,
      sessionToken: null,
      bearerToken: null,
      qlikTicket: null,
      authToken: null
    };

    // Buscar tokens en todos los almacenamientos
    [...Object.keys(allData.localStorage), ...Object.keys(allData.sessionStorage), ...Object.keys(allData.globalVars), ...Object.keys(allData.metaTags)]
      .forEach(key => {
        const value = allData.localStorage[key] || allData.sessionStorage[key] || allData.globalVars[key] || allData.metaTags[key];
        if (value && (
          key.toLowerCase().includes('token') || 
          key.toLowerCase().includes('csrf') ||
          key.toLowerCase().includes('qlik') || 
          key.toLowerCase().includes('sense') ||
          key.toLowerCase().includes('auth')
        )) {
          qlikTokens[key] = value;
        }
      });

    return { storageData: allData, qlikTokens, csrfFromPage };
  } catch (error) {
    console.warn('⚠️ Error extrayendo tokens:', error.message);
    return { storageData: {}, qlikTokens: {}, csrfFromPage: null };
  }
};

// Función para interceptar requests y capturar headers
const setupRequestInterception = async (page) => {
  const capturedData = {
    headers: [],
    responses: [],
    cookies: []
  };
  
  await page.setRequestInterception(true);
  
  page.on('request', (request) => {
    const headers = request.headers();
    const url = request.url();
    
    if (url.includes('/api/') || 
        url.includes('/auth') || 
        headers['authorization'] || 
        headers['x-qlik-xrfkey'] || 
        headers['cookie']) {
      
      capturedData.headers.push({
        url: url,
        method: request.method(),
        headers: {
          authorization: headers['authorization'],
          'x-qlik-xrfkey': headers['x-qlik-xrfkey'],
          cookie: headers['cookie'],
          'x-csrf-token': headers['x-csrf-token'],
          'content-type': headers['content-type']
        },
        timestamp: Date.now()
      });
    }
    
    request.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();
    const headers = response.headers();
    
    if (headers['set-cookie'] || url.includes('/auth') || url.includes('/login')) {
      capturedData.responses.push({
        url: url,
        status: response.status(),
        headers: {
          'set-cookie': headers['set-cookie'],
          'location': headers['location'],
          'x-qlik-xrfkey': headers['x-qlik-xrfkey']
        },
        timestamp: Date.now()
      });
    }
  });
  
  return capturedData;
};

// Endpoint de autologin
app.post('/api/autologin', async (req, res) => {
  const { username, password, tenantUrl, webIntegrationId } = req.body;
  const returnto = req.headers.origin || 'http://localhost:5173';
  
  let browser;
  let capturedData = {};

  try {
    console.log('🚀 Iniciando browser...');
    browser = await createBrowser();
    console.log('✅ Browser iniciado correctamente');

    const page = await browser.newPage();
    
    // Configurar timeouts de página
    page.setDefaultTimeout(120000); // 2 minutos
    page.setDefaultNavigationTimeout(120000);
    
    capturedData = await setupRequestInterception(page);
    
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

    for (let i = 0; i < 3; i++) { // Reducir intentos para evitar timeouts
      console.log(`🔁 Intento ${i + 1}: navegando a ${loginUrl.toString()}`);
      
      try {
        await page.goto(loginUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 90000, // Reducir timeout
        });
        
        console.log('✅ Página cargada');
        await delay(3000); // Reducir delay

        const userInput = await page.$('#userNameInput');
        const passInput = await page.$('#passwordInput');
        
        if (!userInput || !passInput) {
          throw new Error('⚠️ No se encontraron los campos de login');
        }

        await userInput.type(username, { delay: 30 });
        await passInput.type(password, { delay: 30 });
        
        console.log('🚀 Ejecutando Login.submitLoginRequest()');
        await page.evaluate(() => {
          Login.submitLoginRequest();
        });
        
        console.log('🚀 Formulario enviado, esperando redirección...');
        await page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: 60000 // Reducir timeout
        });

        cookies = await page.cookies();
        finalUrl = page.url();
        const tokenData = await extractQlikTokens(page);
        tokens = tokenData;
        
        await delay(2000);
        
        // Intentar navegar a una página de API para activar tokens
        try {
          await page.goto(`${tenantUrl}/api/v1/users/me`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 10000 
          });
          await delay(1000);
          
          const apiCookies = await page.cookies();
          cookies = [...cookies, ...apiCookies].filter((cookie, index, self) => 
            index === self.findIndex(c => c.name === cookie.name)
          );
          
          const apiTokens = await extractQlikTokens(page);
          tokens = {
            storageData: { ...tokens.storageData, ...apiTokens.storageData },
            qlikTokens: { ...tokens.qlikTokens, ...apiTokens.qlikTokens },
            csrfFromPage: apiTokens.csrfFromPage || tokens.csrfFromPage
          };
          
        } catch (apiError) {
          console.log('⚠️ No se pudo acceder a API endpoint, continuando...');
        }
        
        console.log('✅ Login exitoso - Tokens capturados');
        success = true;
        break;

      } catch (e) {
        console.warn(`⚠️ Fallo intento ${i + 1}: ${e.message}`);
        await delay(5000); // Aumentar delay entre intentos
      }
    }

    await browser.close();

    if (!success) {
      return res.status(500).json({
        success: false,
        message: '❌ No se pudo completar el login tras múltiples intentos',
      });
    }

    const importantCookies = cookies.filter(cookie => 
      cookie.name.toLowerCase().includes('session') ||
      cookie.name.toLowerCase().includes('token') ||
      cookie.name.toLowerCase().includes('auth') ||
      cookie.name.toLowerCase().includes('qlik') ||
      cookie.name.toLowerCase().includes('csrf')
    );

    const cookieString = cookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');

    res.json({
      success: true,
      loggedViaPuppeteer: true,
      allCookies: cookies,
      importantCookies,
      cookieString,
      tokens: tokens.qlikTokens,
      storageData: tokens.storageData,
      capturedHeaders: capturedData.headers.slice(-10),
      capturedResponses: capturedData.responses,
      finalUrl,
      tenantUrl,
      usage: {
        cookieHeader: `Cookie: ${cookieString}`,
        authorizationHeaders: capturedData.headers
          .filter(h => h.headers.authorization)
          .map(h => h.headers.authorization)
          .slice(-1)[0],
        csrfToken: tokens.csrfFromPage || tokens.qlikTokens?.csrfToken,
        xrfKey: capturedData.headers
          .filter(h => h.headers['x-qlik-xrfkey'])
          .map(h => h.headers['x-qlik-xrfkey'])
          .slice(-1)[0]
      }
    });

  } catch (error) {
    console.error('🛑 Error en Puppeteer:', error.message);
    if (browser) await browser.close();
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 🎯 NUEVO: Endpoint proxy para API de Qlik
app.post('/api/qlik-proxy', async (req, res) => {
  const { endpoint, method = 'GET', body, cookies, csrfToken, tenantUrl } = req.body;
  
  try {
    const url = `${tenantUrl}${endpoint}`;
    const headers = {
      'Cookie': cookies,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    // Agregar CSRF token si está disponible
    if (csrfToken) {
      headers['X-Qlik-XrfKey'] = csrfToken;
    }

    console.log(`🌐 Proxy request to: ${url}`);
    console.log(`📝 Headers:`, headers);

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const responseText = await response.text();
    let responseData;
    
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      responseData = responseText;
    }

    console.log(`📥 Response status: ${response.status}`);

    res.status(response.status).json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      data: responseData,
      headers: Object.fromEntries(response.headers.entries())
    });

  } catch (error) {
    console.error('❌ Error en proxy:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 🎯 NUEVO: Endpoint para validar sesión via proxy
app.post('/api/validate-session', async (req, res) => {
  const { cookies, csrfToken, tenantUrl } = req.body;
  
  try {
    const endpoint = '/api/v1/users/me';
    const url = `${tenantUrl}${endpoint}`;
    
    const headers = {
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    if (csrfToken) {
      headers['X-Qlik-XrfKey'] = csrfToken;
    }

    const response = await fetch(url, { headers });
    
    res.json({
      valid: response.ok,
      status: response.status,
      statusText: response.statusText
    });
    
  } catch (error) {
    res.status(500).json({
      valid: false,
      error: error.message
    });
  }
});

// Usar el puerto que Render asigna automáticamente
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend Qlik Demo corriendo en puerto ${PORT}`);
});