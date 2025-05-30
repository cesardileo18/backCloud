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

// Función para extraer tokens específicos de Qlik
const extractQlikTokens = async (page) => {
  try {
    // 1. Capturar localStorage, sessionStorage y variables globales
    const allData = await page.evaluate(() => {
      const localStorage = {};
      const sessionStorage = {};
      const globalVars = {};
      const metaTags = {};
      const scriptData = {};
      
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
        if (window._) globalVars.underscore = window._;
        if (window.csrfToken) globalVars.csrfToken = window.csrfToken;
        if (window.qlikToken) globalVars.qlikToken = window.qlikToken;
        if (window.authToken) globalVars.authToken = window.authToken;
        
        // Buscar en window object por tokens
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
      
      // Scripts con configuración
      const scripts = document.querySelectorAll('script');
      scripts.forEach((script, index) => {
        if (script.innerHTML && (
          script.innerHTML.includes('token') || 
          script.innerHTML.includes('csrf') ||
          script.innerHTML.includes('qlik') ||
          script.innerHTML.includes('config')
        )) {
          scriptData[`script_${index}`] = script.innerHTML.substring(0, 500);
        }
      });
      
      return { localStorage, sessionStorage, globalVars, metaTags, scriptData };
    });

    // 2. Extraer CSRF token del HTML si existe
    const csrfFromPage = await page.evaluate(() => {
      // Buscar CSRF en inputs hidden
      const csrfInput = document.querySelector('input[name="csrf_token"], input[name="_token"], input[name="csrfToken"]');
      if (csrfInput) return csrfInput.value;
      
      // Buscar en meta tags
      const csrfMeta = document.querySelector('meta[name="csrf-token"], meta[name="_token"]');
      if (csrfMeta) return csrfMeta.getAttribute('content');
      
      return null;
    });

    // 3. Organizar tokens encontrados
    const qlikTokens = {
      accessToken: null,
      csrfToken: csrfFromPage,
      sessionToken: null,
      bearerToken: null,
      qlikTicket: null,
      authToken: null
    };

    // Buscar en localStorage
    Object.keys(allData.localStorage).forEach(key => {
      const value = allData.localStorage[key];
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

    // Buscar en sessionStorage
    Object.keys(allData.sessionStorage).forEach(key => {
      const value = allData.sessionStorage[key];
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

    // Buscar en variables globales
    Object.keys(allData.globalVars).forEach(key => {
      const value = allData.globalVars[key];
      if (value && typeof value === 'string') {
        qlikTokens[key] = value;
      }
    });

    // Buscar en meta tags
    Object.keys(allData.metaTags).forEach(key => {
      const value = allData.metaTags[key];
      if (value) {
        qlikTokens[key] = value;
      }
    });

    console.log('🔍 Datos extraídos:', {
      localStorageKeys: Object.keys(allData.localStorage),
      sessionStorageKeys: Object.keys(allData.sessionStorage),
      globalVars: Object.keys(allData.globalVars),
      metaTags: Object.keys(allData.metaTags),
      tokensFound: Object.keys(qlikTokens).filter(k => qlikTokens[k])
    });

    return { 
      storageData: allData, 
      qlikTokens,
      csrfFromPage 
    };
  } catch (error) {
    console.warn('⚠️ Error extrayendo tokens:', error.message);
    return { storageData: {}, qlikTokens: {}, csrfFromPage: null };
  }
};

// Función para interceptar requests y capturar headers de autenticación
const setupRequestInterception = async (page) => {
  const capturedData = {
    headers: [],
    responses: [],
    cookies: []
  };
  
  await page.setRequestInterception(true);
  
  // Interceptar requests
  page.on('request', (request) => {
    const headers = request.headers();
    const url = request.url();
    
    // Capturar todas las peticiones importantes
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

  // Interceptar responses para capturar Set-Cookie
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
    const capturedData = await setupRequestInterception(page);
    
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
      console.log(`🔁 Intento ${i + 1}: navegando a ${loginUrl.toString()}`);
      
      try {
        await page.goto(loginUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 60000 + i * 20000,
        });
        
        console.log('✅ Página cargada');
        await delay(5000);

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
          timeout: 90000
        });

        // ✅ Capturar toda la información después del login
        cookies = await page.cookies();
        finalUrl = page.url();
        
        // Extraer tokens del almacenamiento del navegador
        const tokenData = await extractQlikTokens(page);
        tokens = tokenData;
        
        // Esperar un poco más para capturar requests adicionales
        await delay(3000);
        
        // Intentar navegar a una página de API para activar tokens
        try {
          await page.goto(`${tenantUrl}/api/v1/users/me`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 10000 
          });
          await delay(2000);
          
          // Capturar cookies y tokens después de la navegación a API
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
        await delay(3000);
      }
    }

    await browser.close();

    if (!success) {
      return res.status(500).json({
        success: false,
        message: '❌ No se pudo completar el login tras múltiples intentos',
      });
    }

    // 🎯 Filtrar y organizar cookies importantes
    const importantCookies = cookies.filter(cookie => 
      cookie.name.toLowerCase().includes('session') ||
      cookie.name.toLowerCase().includes('token') ||
      cookie.name.toLowerCase().includes('auth') ||
      cookie.name.toLowerCase().includes('qlik') ||
      cookie.name.toLowerCase().includes('csrf')
    );

    // 🎯 Crear string de cookies para usar en el frontend
    const cookieString = cookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');

    // ✅ Respuesta completa con toda la información
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
      capturedHeaders: capturedData.headers.slice(-10), // Los últimos 10
      capturedResponses: capturedData.responses,
      
      // Info adicional
      finalUrl,
      tenantUrl,
      
      // Instrucciones para el frontend
      usage: {
        cookieHeader: `Cookie: ${cookieString}`,
        authorizationHeaders: capturedData.headers
          .filter(h => h.headers.authorization)
          .map(h => h.headers.authorization)
          .slice(-1)[0], // El último token de autorización
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
  console.log(`🚀 Backend Qlik Demo corriendo en http://localhost:${PORT}`);
});