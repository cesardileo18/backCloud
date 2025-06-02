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

// Función para extraer tokens y datos de sesión
const extractTokensAndData = async (page) => {
  try {
    const [storageData, csrfFromPage] = await Promise.all([
      page.evaluate(() => {
        const result = { localStorage: {}, sessionStorage: {}, globalVars: {}, metaTags: {} };
        
        try {
          // localStorage
          for (let i = 0; i < Math.min(window.localStorage.length, 15); i++) {
            const key = window.localStorage.key(i);
            if (key && (key.includes('token') || key.includes('csrf') || key.includes('qlik') || key.includes('auth'))) {
              result.localStorage[key] = window.localStorage.getItem(key);
            }
          }
          
          // sessionStorage
          for (let i = 0; i < Math.min(window.sessionStorage.length, 15); i++) {
            const key = window.sessionStorage.key(i);
            if (key && (key.includes('token') || key.includes('csrf') || key.includes('qlik') || key.includes('auth'))) {
              result.sessionStorage[key] = window.sessionStorage.getItem(key);
            }
          }
          
          // Variables globales críticas
          ['qlik', 'csrfToken', 'qlikToken', 'authToken', 'QLIK', 'CSRF_TOKEN'].forEach(key => {
            if (window[key]) result.globalVars[key] = window[key];
          });
          
          // Meta tags críticos
          document.querySelectorAll('meta[name*="token"], meta[name*="csrf"]').forEach(meta => {
            result.metaTags[meta.getAttribute('name')] = meta.getAttribute('content');
          });
        } catch (e) {
          console.error('Error extrayendo storage:', e);
        }
        
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
    
    // Buscar tokens en todos los storages
    Object.keys(storageData.localStorage).concat(
      Object.keys(storageData.sessionStorage), 
      Object.keys(storageData.globalVars), 
      Object.keys(storageData.metaTags)
    ).forEach(key => {
      const value = storageData.localStorage[key] || 
                   storageData.sessionStorage[key] || 
                   storageData.globalVars[key] || 
                   storageData.metaTags[key];
      if (value) qlikTokens[key] = value;
    });

    return { storageData, qlikTokens, csrfFromPage };
  } catch (error) {
    console.error('Error en extracción de tokens:', error);
    return { storageData: {}, qlikTokens: {}, csrfFromPage: null };
  }
};

app.post('/api/autologin', async (req, res) => {
  const { username, password, tenantUrl, webIntegrationId } = req.body;
  const returnto = req.headers.origin || 'http://localhost:5173';
  
  let browser;
  
  try {
    console.log('🚀 Iniciando browser...');
    
    // Configuración simple pero efectiva
    const browserConfig = {
      headless: 'shell',
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
        '--memory-pressure-off',
        '--max_old_space_size=128',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--no-first-run',
        '--window-size=800,600'
      ]
    };

    // En producción, usar el Chrome del sistema
    if (process.env.NODE_ENV === 'production') {
      browserConfig.executablePath = '/usr/bin/google-chrome-stable';
    }

    browser = await puppeteer.launch(browserConfig);
    console.log('✅ Browser iniciado');
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36');
    
    // Configurar timeouts
    page.setDefaultTimeout(45000);
    
    const loginUrl = new URL(`${tenantUrl}/login`);
    loginUrl.searchParams.append('returnto', returnto);
    loginUrl.searchParams.append('qlik-web-integration-id', webIntegrationId);
    
    console.log('🔗 Navegando a:', loginUrl.toString());
    
    let success = false;
    for (let i = 0; i < 3; i++) { // Reducido a 3 intentos
      console.log(`🔁 Intento ${i + 1}: navegando...`);
      try {
        await page.goto(loginUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        
        console.log('✅ Página cargada, esperando campos...');
        await delay(3000); // Reducido el delay
        
        // Buscar campos con timeout
        await page.waitForSelector('#userNameInput, #passwordInput', { timeout: 15000 });
        
        const userInput = await page.$('#userNameInput');
        const passInput = await page.$('#passwordInput');
        const submitButton = await page.$('#submitButton');
        
        if (!userInput || !passInput || !submitButton) {
          throw new Error('Campos de login no encontrados');
        }
        
        console.log('⌨️ Completando formulario...');
        await userInput.type(username, { delay: 50 });
        await passInput.type(password, { delay: 50 });
        
        console.log('🚀 Enviando formulario...');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }),
          submitButton.click()
        ]);
        
        console.log('✅ Login completado');
        success = true;
        break;
        
      } catch (e) {
        console.warn(`⚠️ Fallo intento ${i + 1}: ${e.message}`);
        if (i < 2) { // Solo delay si no es el último intento
          await delay(2000);
        }
      }
    }
    
    if (!success) {
      await browser.close();
      throw new Error('No se pudo completar el login tras múltiples intentos');
    }
    
    console.log('🔍 Extrayendo cookies y tokens...');
    
    // Obtener cookies y tokens
    const [cookies, tokens] = await Promise.all([
      page.cookies(),
      extractTokensAndData(page)
    ]);
    
    const cookieString = cookies
      .filter(c => c.value && c.value.length > 0)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    
    const finalUrl = page.url();
    
    await browser.close();
    
    console.log(`✅ Proceso completado. Cookies obtenidas: ${cookies.length}`);
    console.log(`🔗 URL final: ${finalUrl}`);
    
    res.json({ 
      success: true, 
      loggedViaPuppeteer: true,
      allCookies: cookies,
      importantCookies: cookies.filter(c => 
        c.name.toLowerCase().includes('session') ||
        c.name.toLowerCase().includes('token') ||
        c.name.toLowerCase().includes('auth') ||
        c.name.toLowerCase().includes('qlik')
      ),
      cookieString: cookieString,
      tokens: tokens.qlikTokens,
      storageData: tokens.storageData,
      finalUrl: finalUrl,
      tenantUrl,
      navigationSuccessful: finalUrl !== loginUrl.toString(),
      usage: {
        cookieHeader: `Cookie: ${cookieString}`,
        csrfToken: tokens.csrfFromPage
      }
    });
    
  } catch (error) {
    console.error('🛑 Error final:', error.message);
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error cerrando browser:', closeError.message);
      }
    }
    res.status(500).json({ 
      success: false, 
      message: error.message,
      error: error.message 
    });
  }
});

// Endpoints adicionales simplificados
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
  console.log(`🚀 Servidor simple corriendo en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
});