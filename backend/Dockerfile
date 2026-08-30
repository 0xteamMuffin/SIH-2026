FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
RUN npx --no-install prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY config ./config
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx --no-install prisma generate \
    && npm cache clean --force
COPY --chown=node:node --from=build /app/dist ./dist
USER node
EXPOSE 4000
CMD ["sh", "-c", "npx --no-install prisma migrate deploy && node dist/server.js"]
