FROM docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json package-lock.json server.mjs ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
EXPOSE 4100
ENTRYPOINT []
CMD ["node", "server.mjs"]
