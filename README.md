# kantongz-api

Backend M3 untuk KANTONGZ. Implementasi mengikuti `docs/M3_SPEC.md` di
repositori aplikasi — spesifikasi itu **beku** dan implementasi menyesuaikan
diri padanya, bukan sebaliknya.

## Menjalankan

```bash
cp .env.example .env
docker compose up
```

PostgreSQL dan Redis berjalan sebagai layanan; tidak ada yang perlu dipasang
manual.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Server dengan muat ulang |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run build` | Kompilasi ke `dist/` |
| `npm run db:generate` | Hasilkan migrasi dari skema |
| `npm run db:migrate` | Terapkan migrasi |

## Endpoint kesehatan

| Rute | Pertanyaan | Menyentuh dependensi |
|---|---|---|
| `/livez` | Haruskah proses ini dibunuh? | **Tidak** |
| `/readyz` | Bolehkah menerima lalu lintas? | Ya |
| `/healthz` | Ringkasan untuk pemantauan | Ya |

`/livez` sengaja tidak menyentuh apa pun: basis data yang jatuh bukan alasan
me-restart proses, dan restart justru menghapus koneksi yang sudah hangat.
