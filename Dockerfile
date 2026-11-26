FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY --chown=node:node . .
RUN mkdir -p data/app-sessions data/qums-sessions data/notified_periods \
    && chown -R node:node data

ENV NODE_ENV=production
EXPOSE 10000

USER node
CMD ["npm", "start"]
