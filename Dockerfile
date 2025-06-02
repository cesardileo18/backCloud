# Usar imagen oficial de Node con Puppeteer preconfigurado
FROM ghcr.io/puppeteer/puppeteer:22.0.0

# Establecer directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias (sin Puppeteer porque ya está incluido)
RUN npm install --production --omit=dev

# Copiar el resto del código
COPY . .

# Variables de entorno
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Exponer puerto
EXPOSE 10000

# Usuario no-root ya configurado en la imagen base
USER pptruser

# Comando de inicio
CMD ["npm", "start"]