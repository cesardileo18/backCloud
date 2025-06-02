# Usar imagen con Chromium preinstalado
FROM mcr.microsoft.com/playwright:v1.44.1-jammy

# Instalar Node.js 18 (más estable para Puppeteer)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Crear usuario no-root para seguridad
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser && \
    mkdir -p /home/pptruser/Downloads && \
    chown -R pptruser:pptruser /home/pptruser

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias como root
RUN npm install --production && \
    npm cache clean --force

# Copiar el resto del código
COPY . .

# Cambiar ownership de los archivos
RUN chown -R pptruser:pptruser /app

# Cambiar a usuario no-root
USER pptruser

# Exponer el puerto que Render espera
EXPOSE 10000

# Variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Comando para iniciar el servidor
CMD ["npm", "start"]