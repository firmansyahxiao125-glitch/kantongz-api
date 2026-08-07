# KANTONGZ API

Backend KANTONGZ. Node 22, Fastify, PostgreSQL 16, Redis 7, Drizzle ORM.

Spesifikasi lengkapnya ada di `../kantongz/docs/M3_SPEC.md` dan bersifat BEKU.
Setiap keputusan di bawah ini berasal dari sana; berkas ini hanya menjelaskan
cara menjalankannya.

## Aturan yang tidak dapat ditawar

**Uang adalah bilangan bulat.** Dalam satuan terkecil yang BEREDAR — untuk IDR
itu rupiah utuh, bukan sen. Tidak ada pecahan yang menyeberangi batas HTTP,
tidak ada `float` di mana pun, dan tidak ada pembagian seratus di klien.

**Saldo tidak disimpan.** Ia dihitung dari buku. Kolom yang harus selalu sepakat
dengan jumlah seluruh transaksi akan menyimpang pada kegagalan parsial pertama,
dan tidak ada apa pun yang menegakkan kesepakatannya.

**Transfer adalah satu baris.** Dengan dua dompet, bukan sepasang baris masuk
dan keluar. Sepasang baris dapat kehilangan pasangannya; satu baris tidak bisa
setengah ada.

## Menjalankan

### Tanpa Docker

Seluruh backend berjalan di atas PostgreSQL dalam proses (PGlite) dan Redis
dalam memori. Data hilang saat proses berhenti, dan kode verifikasi dicetak ke
terminal.

```bash
npm install
npm run dev:standalone
```

### Dengan Docker

```bash
npm run keys:generate > .env.docker
docker compose --env-file .env.docker up -d --build
```

`docker compose` menolak berjalan tanpa `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, dan
`MASTER_KEY` — berkas compose ikut ter-commit, jadi rahasia tidak pernah ditulis
di sana. Migrasi berjalan sebagai layanan terpisah yang harus selesai sebelum
API boleh hidup.

Layanan yang naik: `postgres`, `redis`, `migrate` (sekali jalan), `api` (:3000),
`web` (:3100).

## Konfigurasi

Seluruhnya dari lingkungan, divalidasi sekali saat boot. Lihat `.env.example`.
Yang wajib dan tidak punya bawaan: `DATABASE_URL`, `REDIS_URL`, `JWT_ISSUER`,
`JWT_AUDIENCE`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `MASTER_KEY`.

`CORS_ORIGINS` kosong berarti tidak ada asal peramban yang diizinkan — bawaan
yang benar untuk penyebaran khusus-mobile, sebab `fetch` native tidak tunduk
pada CORS sama sekali.

`MAIL_ENDPOINT`, `MAIL_API_KEY`, dan `MAIL_FROM` harus diisi lengkap atau
dikosongkan seluruhnya. Kosong berarti pekerja outbox berjalan dalam mode
catat-saja: pesan tetap diantrekan dan tetap ditandai terkirim, tetapi tidak ada
yang berangkat — dan proses mengatakannya di log saat boot.

## Perintah

| Perintah | Kegunaan |
|---|---|
| `npm run dev` | Pengembangan terhadap PostgreSQL dan Redis sungguhan |
| `npm run dev:standalone` | Pengembangan tanpa infrastruktur apa pun |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Seluruh suite |
| `npm run build` | Kompilasi ke `dist/` |
| `npm run db:generate` | Membangkitkan migrasi dari skema |
| `npm run db:migrate` | Menerapkan migrasi |
| `npm run keys:generate` | Bahan rahasia untuk pengembangan lokal |
| `npm run e2e` | Verifikasi ujung ke ujung terhadap tumpukan Docker |

## Dokumentasi API

`GET /openapi.json` menyajikan OpenAPI 3.1 lengkap. Dokumen itu ditegakkan uji:
setiap rute yang terdaftar wajib ada di sana dan sebaliknya, sehingga ia tidak
dapat menyimpang dari kenyataan tanpa suite berubah merah.

## Pemeriksaan kesehatan

Tiga endpoint, tiga pertanyaan berbeda — menggabungkannya adalah kesalahan yang
mahal di Kubernetes.

| Endpoint | Pertanyaan | Menyentuh dependensi |
|---|---|---|
| `/livez` | Haruskah proses ini dibunuh dan dijalankan ulang? | Tidak pernah |
| `/readyz` | Bolehkah proses ini menerima lalu lintas sekarang? | Ya |
| `/healthz` | Ringkasan untuk manusia dan pemantauan | Ya |

Basis data yang jatuh bukan alasan membunuh proses; me-restart-nya tidak
memperbaiki apa pun dan justru menghapus koneksi yang sudah hangat. Karena itu
`healthcheck` Docker memakai `/livez`.

## Struktur

```
src/
  bootstrap.ts        perakitan dan siklus hidup, dipakai kedua entri
  index.ts            entri produksi
  standalone.ts       entri pengembangan tanpa infrastruktur
  config/             konfigurasi lingkungan, divalidasi sekali saat boot
  contracts/          bentuk yang menyeberangi batas HTTP
  http/               server, middleware, amplop, OpenAPI
  modules/
    auth/             aturan autentikasi
    ledger/           dompet, kategori, transaksi, anggaran, tujuan
    outbox/           antrean email transaksional
    tokens/           rotasi refresh, JWT, cincin kunci
    audit/            jejak audit berantai
  platform/           basis data, Redis, kripto, log
```

Aturan pemisahannya satu: `repository.ts` bertanya, `service.ts` memutuskan,
`routes.ts` menerjemahkan HTTP. Aturan yang tersebar di antara kueri tidak
pernah bisa dibaca sebagai satu kesatuan.

## Pengujian

| Suite | Yang dibuktikan |
|---|---|
| `platform/crypto` | argon2id, HMAC berversi, enkripsi kolom, tiket hantu |
| `platform/db` | Migrasi menghasilkan skema §7, dan CHECK benar-benar menahan |
| `modules/tokens` | Seluruh aturan rotasi §5 sebagai fungsi murni |
| `modules/auth` | Integrasi terhadap PostgreSQL sungguhan (PGlite) |
| `modules/auth/contract` | Bentuk respons — kunci apa yang keluar, dan yang tidak |
| `modules/auth/concurrency` | Yang tidak dapat dibuktikan uji berurutan mana pun |
| `modules/ledger` | Buku besar, termasuk isolasi antar pengguna |
| `modules/outbox` | Apa yang terjadi ketika pengiriman GAGAL |
| `http/cors` | Daftar izin asal — kebijakan yang hanya ditegakkan peramban |
| `http/openapi` | Dokumen tidak menyimpang dari rute yang sungguhnya |

PGlite adalah PostgreSQL yang dikompilasi ke WebAssembly: parser, perencana, dan
penegakan batasan yang sama. Yang tidak ada hanyalah proses server terpisah.

## Yang belum ada

Pengiriman email sungguhan menunggu kredensial penyedia. Semua di sekitarnya —
outbox, percobaan ulang, dead letter, templat — sudah berjalan dan teruji.
