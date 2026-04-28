FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app
COPY package.json ./
COPY prisma ./prisma/
COPY tsconfig.json nest-cli.json ./
RUN npm install --legacy-peer-deps
COPY src ./src/
RUN npx prisma generate
RUN ./node_modules/.bin/tsc -p tsconfig.json

FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY openapi.yaml ./openapi.yaml

EXPOSE 4020

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4020}/health > /dev/null || exit 1

USER node

CMD ["node", "dist/main"]
