FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker-cli

FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json server.mjs ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
EXPOSE 4100
CMD ["node", "server.mjs"]
