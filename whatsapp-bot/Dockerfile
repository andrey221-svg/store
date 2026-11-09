# Image with Chromium and its system libraries already installed (matches playwright 1.63.0).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production
# Mount a persistent volume here: WhatsApp login, browser logins and conversations live in it.
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
