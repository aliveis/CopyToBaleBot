FROM node:24-alpine

ENV NODE_ENV=production \
    DB_PATH=/app/data/bot.db
WORKDIR /app

# No npm dependencies: SQLite comes from Node's built-in node:sqlite.
COPY package.json server.js ./
COPY lib ./lib
COPY handlers ./handlers
COPY scripts ./scripts

RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
