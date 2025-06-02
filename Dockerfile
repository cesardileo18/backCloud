# Imagen con Chromium preinstalado, ideal para Puppeteer
FROM mcr.microsoft.com/playwright:v1.44.1-jammy

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Exponer el puerto que usa tu app
EXPOSE 3001

# Comando para iniciar el servidor
CMD ["npm", "start"]
