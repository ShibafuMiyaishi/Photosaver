# guest-gateway/Dockerfile
# ゲスト用アップロード窓口。ビルド工程なし(素の ESM)。Node 24 LTS。

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依存のみ先にコピー → layer cache を有効活用。postinstall は実行しない。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# ステージング先(compose で HDD 上のディレクトリを bind-mount する)。
RUN mkdir -p /data/staging && chown node:node /data/staging

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/index.js"]
