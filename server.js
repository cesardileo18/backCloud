import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();

// Configuración específica para Docker y Render
const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3001;

// CORS configurado para producción
app.use(cors({
  origin: isProduction ? process.env.FRONTEND_URL || '*' : '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configuración optimizada de Puppeteer para Docker
const getPuppeteerConfig = () => {
  const baseConfig = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--memory-pressure-off',
      '--max_old_space_size=4096'
    ],
  };

  if (isProduction) {
    return {
      ...baseConfig,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    };
  }

  return baseConfig;
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Healthcheck mejorado
app.get('/api/status', (req, res) => {
  res.json({ 
    status: '✅ API levantada correctamente',
    environment: process.env.NODE_ENV || 'development',
    port: PORT,
    timestamp: new Date().toISOString(),
    puppeteerPath: process.env.PUPPETEER_EXECUTABLE_PATH || 'default'
  });
});

// Test de Puppeteer para debugging
app.get('/api/test-browser', async (req, res) => {
  let browser;
  const startTime = Date.now();
  
  try {
    console.log('🧪 Iniciando test de browser...');
    const config = getPuppeteerConfig();
    console.log('📋 Config:', JSON.stringify(config, null, 2));
    
    browser = await puppeteer.launch(config);
    console.log('✅ Browser lanzado exitosamente');
    
    const page = await browser.newPage();
    console.log('✅ Nueva página creada');
    
    await page.goto('https://httpbin.org/user-agent', { 
      waitUntil: 'networkidle0',
      timeout: 30000 
    });
    console.log('✅ Navegación exitosa');
    
    const content = await page.content();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    
    await browser.close();
    
    const duration = Date.now() - startTime;
    
    res.json({
      success: true,
      message: '🎉 Puppeteer funcionando correctamente',
      duration: `${duration}ms`,
      userAgent,
      contentLength: content.length,
      config: config
    });
    
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error cerrando browser:', closeError);
      }
    }
    
    const duration = Date.now() - startTime;
    console.error('❌ Error en test de browser:', error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
      duration: `${duration}ms`,
      config: getPuppeteerConfig()
    });
  }
});

// Función para extraer tokens específicos de Qlik
const extractQlikTokens = async (page) => {
  try {
    const allData = await page.evaluate(() => {
      const localStorage = {};
      const sessionStorage = {};
      const globalVars = {};
      const metaTags = {};
      
      // LocalStorage
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          localStorage[key] = window.localStorage.getItem(key);
        }
      } catch (e) {
        console.warn('LocalStorage no disponible:', e);
      }
      
      // SessionStorage
      try {
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          sessionStorage[key] = window.sessionStorage.getItem(key);
        }
      } catch (e) {
        console.warn('SessionStorage no disponible:', e);
      }
      
      // Variables globales de Qlik
      try {
        if (window.qlik) globalVars.qlik = 'presente';
        if (window.require) globalVars.requireConfig = 'presente';
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
      try {
        const metaElements = document.querySelectorAll('meta[name*="token"], meta[name*="csrf"], meta[name*="auth"]');
        metaElements.forEach(meta => {
          metaTags[meta.getAttribute('name')] = meta.getAttribute('content');
        });
      } catch (e) {
        console.warn('Error accessing meta tags:', e);
      }
      
      return { localStorage, sessionStorage, globalVars, metaTags };
    });

    const csrfFromPage = await page.evaluate(() => {
      try {
        const csrfInput = document.querySelector('input[name="csrf_token"], input[name="_token"], input[name="csrfToken"]');
        if (csrfInput) return csrfInput.value;
        
        const csrfMeta = document.querySelector('meta[name="csrf-token"], meta[name="_token"]');
        if (csrfMeta) return csrfMeta.getAttribute('content');
        
        return null;
      } catch (e) {
        console.warn('Error extracting CSRF:', e);
        return null;
      }
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
  
  try {
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      try {
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
      } catch (e) {
        console.warn('Error en request interceptor:', e);
        request.continue();
      }
    });

    page.on('response', async (response) => {
      try {
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
      } catch (e) {
        console.warn('Error en response interceptor:', e);
      }
    });
  } catch (e) {
    console.warn('Error configurando interceptors:', e);
  }
  
  return capturedData;
};

// Endpoint de autologin con mejor manejo de errores
app.post('/api/autologin', async (req, res) => {
  const { username, password, tenantUrl, webIntegrationId } = req.body;
  const returnto = req.headers.origin || 'http://localhost:5173';
  
  if (!username || !password || !tenantUrl || !webIntegrationId) {
    return res.status(400).json({
      success: false,
      message: 'Faltan parámetros requeridos: username, password, tenantUrl, webIntegrationId'
    });
  }
  
  let browser;
  let capturedData = {};
  const startTime = Date.now();

  try {
    console.log('🚀 Iniciando proceso de autologin...');
    browser = await puppeteer.launch(getPuppeteerConfig());
    console.log('✅ Browser lanzado');

    const page = await browser.newPage();
    console.log('✅ Nueva página creada');
    
    capturedData = await setupRequestInterception(page);
    
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const loginUrl = new URL(`${tenantUrl}/login`);
    loginUrl.searchParams.append('returnto', returnto);
    loginUrl.searchParams.append('qlik-web-integration-id', webIntegrationId);

    let success = false;
    let cookies = [];
    let finalUrl = '';
    let tokens = {};

    for (let i = 0; i < 3; i++) { // Reducido a 3 intentos
      console.log(`🔁 Intento ${i + 1}: navegando a ${loginUrl.toString()}`);
      
      try {
        await page.goto(loginUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        
        console.log('✅ Página cargada');
        await delay(3000); // Reducido delay
        
        // Verificar elementos del login con timeout
        const userInput = await page.waitForSelector('#userNameInput', { timeout: 10000 });
        const passInput = await page.waitForSelector('#passwordInput', { timeout: 10000 });
        
        if (!userInput || !passInput) {
          throw new Error('⚠️ No se encontraron los campos de login');
        }

        await userInput.type(username, { delay: 20 });
        await passInput.type(password, { delay: 20 });
        
        console.log('🚀 Ejecutando Login.submitLoginRequest()');
        await page.evaluate(() => {
          if (typeof Login !== 'undefined' && Login.submitLoginRequest) {
            Login.submitLoginRequest();
          } else {
            // Fallback: buscar y hacer clic en el botón de login
            const submitBtn = document.querySelector('#submitButton, input[type="submit"], button[type="submit"]');
            if (submitBtn) submitBtn.click();
          }
        });
        
        console.log('🚀 Formulario enviado, esperando redirección...');
        await page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

        cookies = await page.cookies();
        finalUrl = page.url();
        const tokenData = await extractQlikTokens(page);
        tokens = tokenData;
        
        await delay(2000);
        
        console.log('✅ Login exitoso - Tokens capturados');
        success = true;
        break;

      } catch (e) {
        console.warn(`⚠️ Fallo intento ${i + 1}: ${e.message}`);
        await delay(2000);
      }
    }

    await browser.close();
    const duration = Date.now() - startTime;

    if (!success) {
      return res.status(500).json({
        success: false,
        message: '❌ No se pudo completar el login tras múltiples intentos',
        duration: `${duration}ms`
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
      duration: `${duration}ms`,
      allCookies: cookies,
      importantCookies,
      cookieString,
      tokens: tokens.qlikTokens,
      storageData: tokens.storageData,
      capturedHeaders: capturedData.headers.slice(-5),
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
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error cerrando browser:', closeError);
      }
    }
    
    const duration = Date.now() - startTime;
    
    res.status(500).json({
      success: false,
      message: error.message,
      duration: `${duration}ms`
    });
  }
});

// Resto de endpoints (proxy y validación)
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

    console.log(`🌐 Proxy request to: ${url}`);

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

// Manejo de errores global
app.use((error, req, res, next) => {
  console.error('❌ Error no manejado:', error);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    error: isProduction ? 'Error interno' : error.message
  });
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint no encontrado'
  });
});

// Manejo de señales de terminación
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recibido, cerrando servidor gracefully...');
  process.exit(0);
});


process.on('SIGINT', () => {
  console.log('🛑 SIGINT recibido, cerrando servidor gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend Qlik Demo corriendo en puerto ${PORT}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🎭 Puppeteer Path: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'default'}`);
});