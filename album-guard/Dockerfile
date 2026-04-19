# album-guard/Dockerfile
# HPSS Phase 11 — Immich の前段に置くリバースプロキシ。
# ベースは node:20-alpine(wget 同梱、healthcheck 用)。
# ビルドステップなし(plain CommonJS、仕様書 §11.3.2)。

FROM node:20-alpine

WORKDIR /app

# 依存のみ先にコピー → layer cache を有効活用。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ソースコピー。
COPY src/ ./src/

# album-passwords.json のマウント先(compose で host の ${PHOTO_STORAGE_PATH}/guard を bind-mount)。
RUN mkdir -p /app/data

EXPOSE 3000

# docker run / compose 両方でヘルスチェックが効くよう Dockerfile 側にも定義。
# wget は alpine に同梱済。compose 側でも同じコマンドを記述するため常に効く。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget --spider -q http://localhost:3000/album-guard/health || exit 1

CMD ["node", "src/index.js"]
