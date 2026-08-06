# syntax=docker/dockerfile:1.7

# Build multi-tahap: dependensi build tidak pernah ikut ke citra akhir.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Berjalan sebagai pengguna tak-istimewa. Citra Node resmi sudah menyediakan
# `node` (uid 1000); membuat pengguna baru hanya menambah lapisan.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

# Tanpa `tini` atau `--init`, PID 1 adalah Node dan sinyal tidak diteruskan —
# penutupan tertib di `src/index.ts` tidak akan pernah berjalan.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3   CMD node -e "fetch('http://127.0.0.1:3000/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
