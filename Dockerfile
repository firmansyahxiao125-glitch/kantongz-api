# syntax=docker/dockerfile:1.7

# Yang dipin adalah PERKAKASNYA, bukan dependensinya. Menurunkan versi paket
# untuk menyenangkan npm lama akan mengubah apa yang dijalankan produksi;
# mengganti versi npm tidak mengubah apa pun yang dikirim.
#
# ── MENGAPA npm 12, BUKAN 11.13.0 ──────────────────────────────────────
#
# npm MEMBUNDEL dependensinya sendiri, jadi versi npm yang dipasang di sini
# ikut menentukan isi citra — dan Trivy memindainya. Gerbang CRITICAL merah
# karena `tar` yang dibawa npm:
#
#   CVE-2026-59873  tar 7.5.13  CRITICAL  (node-tar: DoS lewat gzip bomb)
#   /usr/local/lib/node_modules/npm/node_modules/tar
#
# `tar` sama sekali BUKAN dependensi aplikasi ini — `npm ls tar` kosong. Ia
# masuk semata-mata karena npm yang dipin di baris ini membawanya, jadi
# satu-satunya tempat memperbaikinya adalah di sini.
#
# Versi tar yang dibundel tiap rilis npm, diperiksa di registry:
#
#   npm 11.13.0 -> tar ^7.5.13   rentan
#   npm 11.16.0 -> tar ^7.5.15   masih rentan
#   npm 12.0.2  -> tar ^7.5.19   perbaikannya
#
# Menaikkan ke 11.16.0 TIDAK cukup — perbaikannya baru ada di 12.
FROM node:22-alpine AS base
RUN npm install -g npm@12.0.2
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
