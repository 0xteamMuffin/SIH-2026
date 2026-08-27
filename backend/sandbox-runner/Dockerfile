FROM docker:27-cli
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json server.mjs ./
RUN npm install --omit=dev
EXPOSE 4100
ENTRYPOINT []
CMD ["node", "server.mjs"]
