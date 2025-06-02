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

// Configuración ultra-conservadora para Render
const createBrowserForRender = async () => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  const config = {
    headless: 'shell', // Usa el nuevo modo shell
    pipe: true, // Usa pipes en lugar de WebSocket
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      
      // Memoria ultra-conservadora
      '--memory-pressure-off',
      '--max_old_space_size=128', // Incrementamos ligeramente
      '--js-flags="--max-old-space-size=128"',
      
      // Deshabilitar features pesados
      '--disable-extensions',
      '--disable-plugins',
      '--disable-images',
      '--disable-remote-fonts',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-features=VizDisplayCompositor,AudioServiceOutOfProcess',
      '--disable-web-security',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--no-first-run',
      '--disable-hang-monitor',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-background-mode',
      '--disable-breakpad',
      '--hide-scrollbars',
      '--mute-audio',
      
      // Viewport mínimo
      '--window-size=800,600',
      '--virtual-time-budget=45000' // 45 segundos máximo
    ],
    
    // Timeouts más generosos
    protocolTimeout: 60000, // 1 minuto
    defaultViewport: { width: 800, height: 600 },
    
    // Configuración específica para Render
    ignoreDefaultArgs: ['--disable-extensions'],
    
    // Configuración de red más robusta
    slowMo: 50, // Añadir delay entre acciones
  };

  if (isProduction) {
    // En Render, usar el Chrome que viene con la imagen
    config.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
  } else {
    config.executablePath = puppeteer.executablePath();
  }

  console.log('🔍 Ejecutable:', config.executablePath);
  console.log('🏭 Entorno:', isProduction ? 'PRODUCCIÓN' : 'DESARROLLO');
  
  return await puppeteer.launch(config);
};

// Función de limpieza mejorada
const safeCloseBrowser = async (browser) => {
  try {
    if (browser && browser.process() != null && browser.process().pid) {
      await browser.close();
    }
  } catch (error) {
    console.error('⚠️ Error cerrando browser:', error.message);
    try {
      if (browser && browser.process()) {
        browser.process().kill('SIGKILL');
      }
    } catch (killError) {
      console.error('⚠️ Error forzando cierre:', killError.message);
    }
  }
};

// Extracción optimizada
const extractTokensRobust = async (page) => {
  try {
    await page.waitForTimeout(2000); // Esperar a que cargue completamente
    
    const [storageData, csrfFromPage] = await Promise.all([
      page.evaluate(() => {
        const result = { localStorage: {}, sessionStorage: {}, globalVars: {}, metaTags: {} };
        
        try {
          // Buscar en localStorage
          for (let i = 0; i < Math.min(window.localStorage.length, 20); i++) {
            const key = window.localStorage.key(i);
            if (key) {
              const value = window.localStorage.getItem(key);
              if (value && (
                key.toLowerCase().includes('token') ||
                key.toLowerCase().includes('csrf') ||
                key.toLowerCase().includes('qlik') ||
                key.toLowerCase().includes('auth') ||
                key.toLowerCase().includes('session')
              )) {
                result.localStorage[key] = value;
              }
            }
          }
          
          // Buscar en sessionStorage
          for (let i = 0; i < Math.min(window.sessionStorage.length, 20); i++) {
            const key = window.sessionStorage.key(i);
            if (key) {
              const value = window.sessionStorage.getItem(key);
              if (value && (
                key.toLowerCase().includes('token') ||
                key.toLowerCase().includes('csrf') ||
                key.toLowerCase().includes('qlik') ||
                key.toLowerCase().includes('auth') ||
                key.toLowerCase().includes('session')
              )) {
                result.sessionStorage[key] = value;
              }
            }
          }
          
          // Variables globales
          const globalKeys = ['qlik', 'csrfToken', 'qlikToken', 'authToken', 'QLIK', 'CSRF_TOKEN'];
          globalKeys.forEach(key => {
            if (window[key] !== undefined) {
              result.globalVars[key] = window[key];
            }
          });
          
          // Meta tags
          const metaSelectors = [
            'meta[name*="token"]',
            'meta[name*="csrf"]',
            'meta[name*="qlik"]',
            'meta[property*="csrf"]'
          ];
          
          metaSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(meta => {
              const name = meta.getAttribute('name') || meta.getAttribute('property');
              const content = meta.getAttribute('content');
              if (name && content) {
                result.metaTags[name] = content;
              }
            });
          });
          
        } catch (e) {
          console.error('Error extrayendo storage:', e);
        }
        
        return result;
      }),
      
      // Buscar CSRF token
      page.evaluate(() => {
        try {
          // Buscar en inputs
          const csrfSelectors = [
            'input[name*="csrf"]',
            'input[name*="token"]',
            'input[name="_token"]',
            'input[name="csrfmiddlewaretoken"]'
          ];
          
          for (const selector of csrfSelectors) {
            const input = document.querySelector(selector);
            if (input && input.value) {
              return input.value;
            }
          }
          
          // Buscar en meta tags
          const metaSelectors = [
            'meta[name="csrf-token"]',
            'meta[name="_token"]',
            'meta[name="csrfmiddlewaretoken"]'
          ];
          
          for (const selector of metaSelectors) {
            const meta = document.querySelector(selector);
            if (meta && meta.getAttribute('content')) {
              return meta.getAttribute('content');
            }
          }
          
          return null;
        } catch (e) {
          return null;
        }
      })
    ]);

    const qlikTokens = {};
    if (csrfFromPage) qlikTokens.csrfToken = csrfFromPage;
    
    // Consolidar todos los tokens encontrados
    const allSources = [
      storageData.localStorage,
      storageData.sessionStorage,
      storageData.globalVars,
      storageData.metaTags
    ];
    
    allSources.forEach(source => {
      Object.entries(source).forEach(([key, value]) => {
        if (value && typeof value === 'string' && value.length > 0) {
          qlikTokens[key] = value;
        }
      });
    });

    return { storageData, qlikTokens, csrfFromPage };
  } catch (error) {
    console.error('Error en extracción de tokens:', error);
    return { storageData: {}, qlikTokens: {}, csrfFromPage: null };
  }
};

// Endpoint principal con manejo robusto de errores
app.post('/api/autologin', async (req, res) => {
  const { username, password, tenantUrl, webIntegrationId } = req.body;
  const returnto = req.headers.origin || 'http://localhost:5173';
  
  let browser = null;
  let page = null;
  const startTime = Date.now();
  
  // Timeout general para toda la operación
  const timeoutId = setTimeout(async () => {
    console.log('⏰ Timeout general alcanzado');
    if (browser) {
      await safeCloseBrowser(browser);
    }
  }, 120000); // 2 minutos máximo

  try {
    // Validar inputs
    if (!username || !password || !tenantUrl || !webIntegrationId) {
      clearTimeout(timeoutId);
      return res.status(400).json({
        success: false,
        error: 'Faltan parámetros requeridos'
      });
    }

    console.log('🚀 Iniciando proceso de autologin...');
    console.log('🔗 URL del tenant:', tenantUrl);
    
    browser = await createBrowserForRender();
    console.log('✅ Browser creado exitosamente');
    
    page = await browser.newPage();
    
    // Configurar timeouts más generosos
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(60000);
    
    // Interceptar y controlar requests
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      const url = request.url();
      
      // Permitir solo lo esencial
      if (['document', 'script', 'xhr', 'fetch'].includes(resourceType)) {
        // Bloquear recursos externos no críticos
        if (url.includes('analytics') || 
            url.includes('tracking') || 
            url.includes('ads') ||
            url.includes('facebook') ||
            url.includes('google-analytics')) {
          request.abort();
        } else {
          request.continue();
        }
      } else {
        request.abort();
      }
    });

    // Manejar errores de página
    page.on('error', (error) => {
      console.error('🛑 Error en página:', error.message);
    });

    page.on('pageerror', (error) => {
      console.error('🛑 Error JS en página:', error.message);
    });

    const loginUrl = `${tenantUrl}/login?returnto=${encodeURIComponent(returnto)}&qlik-web-integration-id=${webIntegrationId}`;
    console.log('🔗 Navegando a:', loginUrl);

    // Navegar con reintentos
    let navigationSuccess = false;
    for (let attempt = 1; attempt <= 3 && !navigationSuccess; attempt++) {
      try {
        console.log(`🔄 Intento de navegación ${attempt}/3`);
        await page.goto(loginUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        });
        navigationSuccess = true;
        console.log('✅ Navegación exitosa');
      } catch (navError) {
        console.error(`❌ Error navegación intento ${attempt}:`, navError.message);
        if (attempt === 3) throw navError;
        await delay(2000);
      }
    }

    // Esperar a que aparezcan los campos de login
    console.log('🔍 Buscando campos de login...');
    await page.waitForSelector('#userNameInput, #passwordInput', { 
      timeout: 30000,
      visible: true 
    });

    const userInput = await page.$('#userNameInput');
    const passInput = await page.$('#passwordInput');
    
    if (!userInput || !passInput) {
      throw new Error('Campos de login no encontrados en el DOM');
    }

    console.log('⌨️ Completando formulario...');
    await userInput.click();
    await userInput.type(username, { delay: 100 });
    
    await passInput.click();
    await passInput.type(password, { delay: 100 });
    
    console.log('🚀 Enviando credenciales...');
    
    // Intentar submit con múltiples métodos
    try {
      await Promise.race([
        page.waitForNavigation({ 
          waitUntil: 'domcontentloaded', 
          timeout: 45000 
        }),
        page.evaluate(() => {
          // Intentar diferentes métodos de submit
          if (typeof Login !== 'undefined' && Login.submitLoginRequest) {
            return Login.submitLoginRequest();
          } else {
            const form = document.querySelector('form');
            if (form) {
              form.submit();
            } else {
              const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
              if (submitBtn) {
                submitBtn.click();
              }
            }
          }
        })
      ]);
    } catch (submitError) {
      console.error('⚠️ Error en submit, continuando...', submitError.message);
    }

    // Esperar un poco más para que cargue la página post-login
    await delay(3000);

    console.log('🔍 Extrayendo datos de sesión...');
    const [cookies, tokens] = await Promise.all([
      page.cookies(),
      extractTokensRobust(page)
    ]);
    
    clearTimeout(timeoutId);
    await safeCloseBrowser(browser);

    const cookieString = cookies
      .filter(c => c.value && c.value.length > 0)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    
    const totalTime = Date.now() - startTime;
    const finalUrl = page.url();

    console.log(`✅ Proceso completado en ${totalTime}ms`);
    console.log(`🔗 URL final: ${finalUrl}`);
    console.log(`🍪 Cookies obtenidas: ${cookies.length}`);

    res.json({
      success: true,
      method: 'render-optimized',
      executionTime: totalTime,
      loggedViaPuppeteer: true,
      allCookies: cookies,
      importantCookies: cookies.filter(c => 
        c.name.toLowerCase().includes('session') ||
        c.name.toLowerCase().includes('token') ||
        c.name.toLowerCase().includes('auth') ||
        c.name.toLowerCase().includes('qlik') ||
        c.name.toLowerCase().includes('csrf')
      ),
      cookieString,
      tokens: tokens.qlikTokens,
      storageData: tokens.storageData,
      finalUrl,
      tenantUrl,
      navigationSuccessful: finalUrl !== loginUrl,
      usage: {
        cookieHeader: `Cookie: ${cookieString}`,
        csrfToken: tokens.csrfFromPage
      }
    });

  } catch (error) {
    console.error('🛑 Error crítico:', error.message);
    console.error(error.stack);
    
    clearTimeout(timeoutId);
    await safeCloseBrowser(browser);
    
    const totalTime = Date.now() - startTime;
    
    res.status(500).json({
      success: false,
      error: error.message,
      executionTime: totalTime,
      errorType: error.name,
      stage: 'autologin_process'
    });
  }
});

// Mantener otros endpoints...
app.post('/api/qlik-proxy', async (req, res) => {
  const { endpoint, method = 'GET', body, cookies, csrfToken, tenantUrl } = req.body;
  
  try {
    const url = `${tenantUrl}${endpoint}`;
    const headers = {
      'Cookie': cookies,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    if (csrfToken) {
      headers['X-Qlik-XrfKey'] = csrfToken;
    }

    const fetchOptions = {
      method,
      headers,
      timeout: 30000
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
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
      error: error.message,
      stage: 'proxy_request'
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

    const response = await fetch(`${tenantUrl}/api/v1/users/me`, { 
      headers,
      timeout: 15000
    });
    
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

// Health check mejorado
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: process.env.NODE_ENV || 'development'
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor optimizado para Render corriendo en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Puppeteer: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'bundled'}`);
});