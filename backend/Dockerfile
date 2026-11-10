ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/data && chown node:node /app/data
COPY --chown=node:node . ./
USER node
EXPOSE 3001
CMD ["node", "index.js"]
