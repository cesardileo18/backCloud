# Usar Node.js 22
FROM node:22-slim

# Instalar dependencias del sistema para Puppeteer
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar solo package.json primero
COPY package.json ./

# Limpiar cualquier caché anterior y regenerar package-lock.json
RUN npm cache clean --force

# Instalar dependencias y generar nuevo package-lock.json
RUN npm install --omit=dev && npm cache clean --force

# Copiar el resto del código (excluyendo package-lock.json viejo)
COPY server.js ./
COPY render.yaml ./

# Variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# Exponer el puerto
EXPOSE 3001

# Comando para iniciar el servidor
CMD ["node", "server.js"]