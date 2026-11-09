ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/server/data && chown node:node /app/server/data
WORKDIR /app
COPY --chown=node:node server/ ./server/
COPY --chown=node:node cloudfunctions/contentSecurity/service.js cloudfunctions/contentSecurity/callback.js ./cloudfunctions/contentSecurity/
USER node
EXPOSE 3001
CMD ["node", "server/index.js"]
