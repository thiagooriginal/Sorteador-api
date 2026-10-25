FROM ghcr.io/puppeteer/puppeteer:21

# Diretório de trabalho
WORKDIR /app

# Copiar dependências e instalar
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código
COPY server.js ./

# Criar pasta para cookies persistentes e dar permissão
RUN mkdir -p /app/cookies && chown -R pptruser:pptruser /app
USER pptruser

# Variáveis de ambiente (sobrescrever no Easypanel)
ENV PORT=3000
ENV IG_USERNAME=""
ENV IG_PASSWORD=""
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Expor porta
EXPOSE 3000

# Iniciar
CMD ["node", "server.js"]
