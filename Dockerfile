# Usar imagen oficial de Node con Puppeteer preconfigurado
FROM ghcr.io/puppeteer/puppeteer:22.0.0

# Cambiar a root temporalmente para instalación
USER root

# Establecer directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias como root
RUN npm install --production && npm cache clean --force

# Copiar el resto del código
COPY . .

# Cambiar ownership al usuario puppeteer
RUN chown -R pptruser:pptruser /app

# Variables de entorno
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Exponer puerto
EXPOSE 10000

# Cambiar de vuelta al usuario no-root
USER pptruser

# Comando de inicio
CMD ["npm", "start"]