FROM ghcr.io/puppeteer/puppeteer:21

# Usar o Chrome já instalado na imagem oficial
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    PORT=3000

# Diretório padrão com permissão total do pptruser
WORKDIR /home/pptruser

# Copiar dependências e instalar
COPY package*.json ./
RUN npm install --omit=dev

# Copiar o código do servidor
COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
