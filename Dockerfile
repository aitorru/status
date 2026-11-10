# Node 24 runs the TypeScript sources directly (type stripping): no build stage, no npm install.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    CONFIG=/config/services.json \
    STATE_FILE=/data/state.json

COPY package.json ./
COPY src ./src
COPY public ./public
COPY config/services.example.json ./config/services.example.json

RUN mkdir -p /data /config && chown node:node /data
USER node

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "src/server.ts"]
