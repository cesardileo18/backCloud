import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();
app.use(cors());
app.use(express.json());

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

app.get('/api/status', (req, res) => {
  res.json({ status: '✅ API levantada correctamente' });
});

// Configuración EXTREMA para plan free
const createMinimalBrowser = async () => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  const config = {
    headless: 'shell',
    pipe: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      
      // EXTREMO: Mínima memoria posible
      '--memory-pressure-off',
      '--max_old_space_size=64', // Solo 64MB
      
      // Deshabilitar TODO lo posible
      '--disable-extensions',
      '--disable-plugins',
      '--disable-images',
      '--disable-css',
      '--disable-javascript-harmony-shipping',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-networking',
      '--disable-features=VizDisplayCompositor,AudioServiceOutOfProcess,Translate',
      '--disable-web-security',
      '--disable-client-side-phishing-detection',
      '--disable-sync',
      '--disable-default-apps',
      '--no-first-run',
      '--disable-prompt-on-repost',
      '--disable-hang-monitor',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-background-mode',
      '--disable-ipc-flooding-protection',
      '--disable-field-trial-config',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=400,300', // Ventana súper pequeña
      '--virtual-time-budget=30000' // Límite de tiempo virtual
    ],
    
    // Timeouts súper cortos
    protocolTimeout: 20000, // 20 segundos máximo
    defaultViewport: { width: 400, height: 300 }
  };

  // En producción, usar Chrome que viene con la imagen oficial de Puppeteer
  if (isProduction) {
    config.executablePath = '/usr/bin/google-chrome-stable';
  } else {
    config.executablePath = puppeteer.executablePath();
  }

  console.log('🔍 Usando ejecutable:', config.executablePath);
  return await puppeteer.launch(config);
};

// Extracción mínima pero completa
const extractTokensMinimal = async (page) => {
  try {
    const [storageData, csrfFromPage] = await Promise.all([
      page.evaluate(() => {
        const result = { localStorage: {}, sessionStorage: {}, globalVars: {}, metaTags: {} };
        
        try {
          // Solo lo esencial
          for (let i = 0; i < Math.min(window.localStorage.length, 10); i++) {
            const key = window.localStorage.key(i);
            if (key && (key.includes('token') || key.includes('csrf') || key.includes('qlik') || key.includes('auth'))) {
              result.localStorage[key] = window.localStorage.getItem(key);
            }
          }
          
          for (let i = 0; i < Math.min(window.sessionStorage.length, 10); i++) {
            const key = window.sessionStorage.key(i);
            if (key && (key.includes('token') || key.includes('csrf') || key.includes('qlik') || key.includes('auth'))) {
              result.sessionStorage[key] = window.sessionStorage.getItem(key);
            }
          }
          
          // Variables globales críticas
          ['qlik', 'csrfToken', 'qlikToken', 'authToken'].forEach(key => {
            if (window[key]) result.globalVars[key] = window[key];
          });
          
          // Meta tags críticos
          document.querySelectorAll('meta[name*="token"], meta[name*="csrf"]').forEach(meta => {
            result.metaTags[meta.getAttribute('name')] = meta.getAttribute('content');
          });
        } catch (e) {}
        
        return result;
      }),
      
      page.evaluate(() => {
        try {
          const csrfInput = document.querySelector('input[name*="csrf"], input[name*="token"]');
          if (csrfInput) return csrfInput.value;
          
          const csrfMeta = document.querySelector('meta[name*="csrf"], meta[name*="token"]');
          if (csrfMeta) return csrfMeta.getAttribute('content');
          
          return null;
        } catch (e) {
          return null;
        }
      })
    ]);

    const qlikTokens = { csrfToken: csrfFromPage };
    
    // Buscar tokens en storages
    Object.keys(storageData.localStorage).concat(Object.keys(storageData.sessionStorage), Object.keys(storageData.globalVars), Object.keys(storageData.metaTags))
      .forEach(key => {
        const value = storageData.localStorage[key] || storageData.sessionStorage[key] || storageData.globalVars[key] || storageData.metaTags[key];
        if (value) qlikTokens[key] = value;
      });

    return { storageData, qlikTokens, csrfFromPage };
  } catch (error) {
    return { storageData: {}, qlikTokens: {}, csrfFromPage: null };
  }
};

// Login súper simplificado
app.post('/api/autologin', async (req, res) => {
  const { username, password, tenantUrl, webIntegrationId } = req.body;
  const returnto = req.headers.origin || 'http://localhost:5173';
  
  let browser;
  const startTime = Date.now();

  try {
    console.log('🚀 Iniciando browser minimal...');
    browser = await createMinimalBrowser();
    
    const page = await browser.newPage();
    page.setDefaultTimeout(15000); // 15 segundos máximo
    
    // Bloquear TODO excepto HTML básico
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['document', 'script'].includes(resourceType)) {
        request.continue();
      } else {
        request.abort();
      }
    });

    const loginUrl = `${tenantUrl}/login?returnto=${encodeURIComponent(returnto)}&qlik-web-integration-id=${webIntegrationId}`;

    console.log('🔗 Navegando...');
    await page.goto(loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    console.log('✅ Página cargada, buscando campos...');
    await page.waitForSelector('#userNameInput, #passwordInput', { timeout: 5000 });

    const userInput = await page.$('#userNameInput');
    const passInput = await page.$('#passwordInput');
    
    if (!userInput || !passInput) {
      throw new Error('Campos de login no encontrados');
    }

    console.log('⌨️ Escribiendo credenciales...');
    await userInput.type(username, { delay: 5 });
    await passInput.type(password, { delay: 5 });
    
    console.log('🚀 Enviando login...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.evaluate(() => Login.submitLoginRequest())
    ]);

    console.log('🔍 Extrayendo datos...');
    const [cookies, tokens] = await Promise.all([
      page.cookies(),
      extractTokensMinimal(page)
    ]);
    
    await browser.close();

    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const totalTime = Date.now() - startTime;

    console.log(`✅ Completado en ${totalTime}ms`);

    res.json({
      success: true,
      method: 'ultra-minimal',
      executionTime: totalTime,
      loggedViaPuppeteer: true,
      allCookies: cookies,
      importantCookies: cookies.filter(c => 
        c.name.toLowerCase().includes('session') ||
        c.name.toLowerCase().includes('token') ||
        c.name.toLowerCase().includes('auth') ||
        c.name.toLowerCase().includes('qlik')
      ),
      cookieString,
      tokens: tokens.qlikTokens,
      storageData: tokens.storageData,
      finalUrl: page.url(),
      tenantUrl,
      usage: {
        cookieHeader: `Cookie: ${cookieString}`,
        csrfToken: tokens.csrfFromPage
      }
    });

  } catch (error) {
    console.error('🛑 Error:', error.message);
    if (browser) await browser.close();
    
    res.status(500).json({
      success: false,
      error: error.message,
      executionTime: Date.now() - startTime
    });
  }
});

// Mantener endpoints de proxy
app.post('/api/qlik-proxy', async (req, res) => {
  const { endpoint, method = 'GET', body, cookies, csrfToken, tenantUrl } = req.body;
  
  try {
    const url = `${tenantUrl}${endpoint}`;
    const headers = {
      'Cookie': cookies,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    if (csrfToken) {
      headers['X-Qlik-XrfKey'] = csrfToken;
    }

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

    res.status(response.status).json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      data: responseData,
      headers: Object.fromEntries(response.headers.entries())
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/validate-session', async (req, res) => {
  const { cookies, csrfToken, tenantUrl } = req.body;
  
  try {
    const headers = {
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    if (csrfToken) {
      headers['X-Qlik-XrfKey'] = csrfToken;
    }

    const response = await fetch(`${tenantUrl}/api/v1/users/me`, { headers });
    
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend minimal corriendo en puerto ${PORT}`);
});