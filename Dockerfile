# syntax=docker/dockerfile:1.7

# `package-lock.json` ditulis npm 11. npm 10.9.8 yang dibundel node:22-alpine
# tidak dapat merekonsiliasinya dan melaporkan seluruh pohon esbuild bersarang
# milik tsx sebagai "Missing from lock file" — terbukti dengan menjalankan
# `npm ci --dry-run` di dalam citra ini dengan kedua versi npm.
#
# Yang dipin adalah PERKAKASNYA, bukan dependensinya. Menurunkan versi paket
# untuk menyenangkan npm lama akan mengubah apa yang dijalankan produksi;
# menyamakan versi npm dengan yang menulis lockfile tidak mengubah apa pun.
FROM node:22-alpine AS base
RUN npm install -g npm@11.13.0
WORKDIR /app

# Build multi-tahap: dependensi build tidak pernah ikut ke citra akhir.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production

# Berjalan sebagai pengguna tak-istimewa. Citra Node resmi sudah menyediakan
# `node` (uid 1000); membuat pengguna baru hanya menambah lapisan.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Migrasi berupa berkas SQL yang dibaca saat dijalankan, bukan dikompilasi ke
# dalam `dist`. Tanpa baris ini `node dist/platform/db/migrate.js` menemukan
# folder kosong dan melaporkan sukses tanpa menerapkan apa pun.
COPY --from=build /app/drizzle ./drizzle

USER node
EXPOSE 3000

# Tanpa `tini` atau `--init`, PID 1 adalah Node dan sinyal tidak diteruskan —
# penutupan tertib di `src/index.ts` tidak akan pernah berjalan.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
