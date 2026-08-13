# Email — dari penangkap lokal ke relay berbayar

Aplikasi mengirim dua jenis email, dan keduanya memblokir: kode verifikasi
pendaftaran dan kode reset kata sandi. Kalau SMTP salah, pengguna tidak bisa
membuat akun sama sekali — dan gagalnya senyap dari sisi mereka.

---

## Keadaan sekarang

| Susunan | SMTP | Status |
|---|---|---|
| Pengembangan (`docker-compose.yml`) | Mailpit `mailpit:1025` | **TERBUKTI** |
| Produksi lokal (+ `docker-compose.prod.local.yml`) | Mailpit `mailpit:1025` | **TERBUKTI** |
| Produksi sungguhan | relay berbayar | **UNVERIFIED-SAMPAI-DIDANAI** |

Yang terbukti di produksi lokal adalah jalur penuhnya, bukan potongannya:

```
Caddy (HTTPS) -> Web -> BFF -> API -> SMTP -> kotak masuk
```

daftar `201` → email tiba (`Kode verifikasi KANTONGZ`) → verifikasi `200`,
dengan kuki `kz_rt` `HttpOnly; Secure; SameSite=lax`.

Baris terakhir tabel BUKAN kegagalan. Ia belum dibeli, jadi belum dapat diuji —
dan tidak ada yang boleh mengaku sudah mengujinya.

---

## Membuktikan ulang jalur lokal

```bash
docker compose --env-file .env.prod \
  -f docker-compose.prod.yml -f docker-compose.prod.local.yml up -d
```

Kotak masuk: <http://localhost:8026>

Berkas override HARUS disebut eksplisit. `docker-compose.prod.yml` sendirian
tetap menghasilkan susunan produksi tanpa Mailpit, dan itu memang disengaja —
susunan produksi yang membawa penangkap email adalah susunan yang suatu saat
MENELAN email pengguna sungguhan alih-alih mengirimnya.

---

## Pindah ke relay berbayar

Yang berubah hanya nilai lingkungan. **Tidak ada kode, tidak ada arsitektur.**
Jalur SMTP-nya sudah yang dipakai produksi lokal; hanya tujuannya yang berganti.

### 1. Isi di `.env.prod`

```env
SMTP_HOST=<host relay>
SMTP_PORT=587
SMTP_SECURE=true
MAIL_FROM=no-reply@domainmu.id
```

`MAIL_FROM` harus berada di domain yang kamu kendalikan. Relay menolak, atau
lebih buruk lagi menerima lalu diam-diam menandai spam, alamat pengirim yang
tidak terverifikasi.

### 2. Isi kredensial di `deploy/optional.env`

```env
SMTP_USER=<pengguna>
SMTP_PASS=<sandi/kunci api>
```

Berkas TERPISAH, dan itu perbaikan cacat yang sudah terjadi — bukan selera.
Menulisnya sebagai `${SMTP_USER:-}` di compose menyetel variabelnya menjadi
**string kosong**, dan skema konfigurasi menolak string kosong tepat di tempat
ia menerima ketiadaan:

```
SMTP_USER: Too small: expected string to have >=1 characters
```

API gagal boot berulang kali karenanya, dan gagalnya benar: relay tanpa
autentikasi itu sah, dan harus bisa dinyatakan dengan **tidak menulis apa pun**.
`required: false` membuat berkasnya boleh tidak ada sama sekali.

`deploy/optional.env` diabaikan git. Jangan pernah memaksanya masuk.

### 3. `SMTP_PORT` dan `SMTP_SECURE` berpasangan

Salah pasangan adalah cara paling umum alur ini rusak, dan gejalanya menyesatkan
— sambungan **menggantung sampai batas waktu**, jadi terlihat seperti jaringan
lambat, bukan seperti salah konfigurasi.

| Porta | `SMTP_SECURE` | Keterangan |
|---|---|---|
| 587 | `true` | Submission + STARTTLS. Bawaan hampir semua relay. |
| 465 | `true` | SMTPS implisit. |
| 25 | `false` | Umumnya diblokir penyedia awan. Hindari. |
| 1025 | `false` | Hanya Mailpit lokal. **Jangan pernah di produksi.** |

### 4. Jalankan ulang API saja

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --force-recreate api
```

---

## Yang WAJIB diverifikasi sesudah didanai

Jangan tandai baris ketiga tabel di atas sebagai terbukti sebelum SEMUA ini
dijalankan pada relay sungguhan:

- [ ] Daftar dengan alamat email **sungguhan** — kode tiba di INBOX, bukan spam.
- [ ] Reset kata sandi juga tiba. Keduanya memakai jalur yang sama, tetapi
      templat berbeda; yang satu lulus tidak membuktikan yang lain.
- [ ] `MAIL_FROM` lolos SPF dan DKIM. Tanpa keduanya, email mendarat di spam
      dan pengguna melaporkannya sebagai "pendaftaran rusak".
- [ ] Kredensial salah menghasilkan galat yang **terlihat di log**, bukan
      kegagalan senyap.
- [ ] Batas kirim relay diketahui dan lebih besar daripada lonjakan pendaftaran
      yang wajar.
- [ ] Antrean outbox mengejar setelah relay sempat mati — matikan relay,
      daftar, hidupkan lagi, pastikan emailnya akhirnya terkirim.

Sampai keenamnya hijau, statusnya tetap **UNVERIFIED-SAMPAI-DIDANAI**.
