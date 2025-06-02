# Usar imagen oficial de Node con Puppeteer preconfigurado y optimizada
FROM ghcr.io/puppeteer/puppeteer:22.0.0

# Cambiar a root para instalaciones del sistema
USER root

# Instalar dependencias adicionales para estabilidad
RUN apt-get update && apt-get install -y \
    dumb-init \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libdrm2 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xvfb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Establecer directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias primero (para cache de Docker)
COPY package*.json ./

# Instalar dependencias con configuraciones optimizadas
RUN npm ci --only=production --no-audit --no-fund && \
    npm cache clean --force && \
    rm -rf ~/.npm

# Copiar el resto del código
COPY . .

# Crear directorio para logs y temp
RUN mkdir -p /app/logs /app/temp && \
    chown -R pptruser:pptruser /app

# Variables de entorno optimizadas
ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_OPTIONS="--max-old-space-size=512" \
    UV_THREADPOOL_SIZE=4

# Configurar límites de memoria y recursos
ENV MALLOC_ARENA_MAX=2

# Exponer puerto
EXPOSE 10000

# Cambiar al usuario no-root
USER pptruser

# Usar dumb-init para manejo correcto de señales
ENTRYPOINT ["dumb-init", "--"]

# Comando de inicio con verificación de salud
CMD ["node", "server.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:10000/api/health || exit 1