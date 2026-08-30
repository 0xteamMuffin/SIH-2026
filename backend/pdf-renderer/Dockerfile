FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs renderer-worker.mjs protocol.mjs ./

FROM dependencies AS test
COPY test ./test
RUN npm test

FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=test /app/node_modules ./node_modules
COPY server.mjs renderer-worker.mjs protocol.mjs ./
USER node
EXPOSE 4200
CMD ["node", "server.mjs"]
