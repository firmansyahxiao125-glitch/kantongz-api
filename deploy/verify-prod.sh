#!/usr/bin/env bash
#
# Verifikasi susunan produksi SEBELUM lalu lintas diarahkan ke sana.
#
# Skrip ini memeriksa hal-hal yang tidak akan ketahuan dari `docker compose ps`:
# apakah basis data benar-benar tertutup dari luar, apakah header keamanan
# benar-benar terkirim, apakah rahasia benar-benar tidak ada di dalam citra.
#
# Setiap pemeriksaan MENGUJI, bukan mengasumsikan. Yang gagal dilaporkan
# dengan sebabnya, dan skrip keluar bukan-nol — supaya ia dapat dipakai
# sebagai gerbang di pipeline, bukan sekadar dibaca manusia.
#
#   ./deploy/verify-prod.sh [domain]
#
# `domain` bawaan `localhost`. Untuk domain sungguhan, TLS diverifikasi
# terhadap rantai sertifikat asli.

set -uo pipefail

DOMAIN="${1:-localhost}"
ENV_FILE="${2:-.env.prod}"

# `--env-file` WAJIB dibawa. Tanpanya setiap panggilan compose gagal
# menginterpolasi `${POSTGRES_USER:?wajib}` dan SELURUH pemeriksaan berbasis
# `exec` gagal dengan sebab yang menyesatkan — terlihat seperti kontainer
# bermasalah, padahal skripnya yang tidak dapat membaca konfigurasi.
COMPOSE="docker compose --env-file ${ENV_FILE} -f docker-compose.prod.yml"
BASE="https://${DOMAIN}"

# `-k` HANYA untuk localhost, tempat Caddy memakai CA internalnya sendiri.
# Untuk domain sungguhan, sertifikat yang tidak sah HARUS gagal.
CURL_OPTS=(--silent --show-error --max-time 15)
if [ "$DOMAIN" = "localhost" ]; then CURL_OPTS+=(--insecure); fi

pass=0
fail=0

ok()   { printf '  \033[32mOK  \033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mGAGAL\033[0m %s\n     → %s\n' "$1" "${2:-}"; fail=$((fail + 1)); }
# JANGAN beri nama fungsi ini `head`.
#
# Nama itu MENIMPA perintah `head`, dan setiap `| head -1` di bawah akan
# memanggil pencetak judul ini alih-alih memotong baris — menghasilkan nilai
# "-1" yang lalu dilaporkan sebagai KEGAGALAN pada pemeriksaan yang sebenarnya
# lulus. Empat pemeriksaan sempat merah karenanya, dan seluruhnya menuduh
# susunan produksi atas cacat di skrip yang memeriksanya.
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 1. kontainer ───────────────────────────────────────────────────────
section '1. Kontainer'

running="$($COMPOSE ps --services --filter status=running 2>/dev/null)"
for svc in caddy postgres redis api web; do
  if printf '%s
' "$running" | grep -qx "$svc"; then
    ok "$svc berjalan"
  else
    bad "$svc" 'tidak berjalan'
  fi
done

# Migrasi HARUS selesai dan keluar bersih. Kontainer migrasi yang masih
# berjalan berarti ia menggantung, dan API yang menunggunya tidak akan naik.
# Migrasi HARUS sudah keluar. Yang masih berjalan berarti menggantung.
if printf '%s
' "$running" | grep -qx 'migrate'; then
  bad 'migrate masih berjalan' 'seharusnya sudah selesai dan keluar'
elif $COMPOSE ps -a --services 2>/dev/null | grep -qx 'migrate'; then
  ok 'migrate selesai dan keluar'
else
  bad 'migrate' 'kontainer tidak ditemukan'
fi

# ── 2. isolasi jaringan ────────────────────────────────────────────────
section '2. Isolasi jaringan'

# Ini pemeriksaan paling penting di seluruh berkas. Basis data yang dapat
# dijangkau dari host adalah basis data yang dapat dijangkau dari internet
# begitu firewall mesin salah dikonfigurasi satu kali.
for port_name in '5432:PostgreSQL' '6379:Redis' '3000:API' '3100:Web'; do
  port="${port_name%%:*}"
  name="${port_name##*:}"
  if timeout 2 bash -c "</dev/tcp/127.0.0.1/${port}" 2>/dev/null; then
    bad "$name TERBUKA di host:${port}" 'hanya Caddy (80/443) yang boleh terekspos'
  else
    ok "$name tertutup dari host"
  fi
done

# ── 3. TLS & HTTP ──────────────────────────────────────────────────────
section '3. TLS dan pengalihan'

redirect="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' "http://${DOMAIN}/" 2>/dev/null)"
case "$redirect" in
  30*) ok "HTTP dialihkan ke HTTPS ($redirect)" ;;
  *)   bad 'pengalihan HTTP' "kode $redirect, seharusnya 30x" ;;
esac

if curl "${CURL_OPTS[@]}" -o /dev/null "$BASE/" 2>/dev/null; then
  ok 'HTTPS menjawab'
else
  bad 'HTTPS' 'tidak menjawab — periksa sertifikat dan DNS'
fi

# ── 4. header keamanan ─────────────────────────────────────────────────
section '4. Header keamanan'

headers="$(curl "${CURL_OPTS[@]}" -D - -o /dev/null "$BASE/" 2>/dev/null | tr -d '\r')"

check_header() {
  if printf '%s' "$headers" | grep -qi "^$1:"; then
    ok "$1"
  else
    bad "$1" 'tidak terkirim'
  fi
}

check_header 'strict-transport-security'
check_header 'x-content-type-options'
check_header 'x-frame-options'
check_header 'referrer-policy'
check_header 'permissions-policy'

# Header yang membocorkan tumpukan teknologi HARUS hilang.
for leak in 'server' 'x-powered-by'; do
  if printf '%s' "$headers" | grep -qi "^${leak}:"; then
    bad "header '$leak' bocor" "$(printf '%s' "$headers" | grep -i "^${leak}:" | head -1)"
  else
    ok "header '$leak' tidak diumumkan"
  fi
done

# ── 4b. titik internal tidak terekspos ─────────────────────────────────
section '4b. Titik internal'

# `/metrics` membocorkan bentuk lalu lintas. Ia HARUS ditolak di proxy, bukan
# sekadar kebetulan tidak terjangkau karena penampung terakhir menunjuk ke
# aplikasi web.
mcode="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' "$BASE/metrics" 2>/dev/null)"
mbody="$(curl "${CURL_OPTS[@]}" "$BASE/metrics" 2>/dev/null | head -c 200)"
if printf '%s' "$mbody" | grep -q 'kantongz_http_requests_total'; then
  bad '/metrics TEREKSPOS' 'eksposisi Prometheus terjangkau dari internet'
elif [ "$mcode" = "404" ]; then
  ok '/metrics ditolak (404)'
else
  bad '/metrics' "kode $mcode — seharusnya 404"
fi

# ── 5. kesehatan ───────────────────────────────────────────────────────
section '5. Titik kesehatan'

for ep in livez readyz healthz; do
  code="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' "$BASE/$ep" 2>/dev/null)"
  if [ "$code" = "200" ]; then ok "/$ep → 200"; else bad "/$ep" "kode $code"; fi
done

# ── 6. kompresi ────────────────────────────────────────────────────────
section '6. Kompresi'

enc="$(curl "${CURL_OPTS[@]}" -H 'Accept-Encoding: zstd, gzip' -D - -o /dev/null "$BASE/" 2>/dev/null \
       | tr -d '\r' | grep -i '^content-encoding:' | head -1)"
if [ -n "$enc" ]; then ok "aktif (${enc#*: })"; else bad 'kompresi' 'tidak ada content-encoding'; fi

# ── 7. CORS ────────────────────────────────────────────────────────────
section '7. CORS'

# Asal jahat HARUS ditolak. Ini yang membedakan daftar izin dari `*`.
evil="$(curl "${CURL_OPTS[@]}" -D - -o /dev/null \
        -H 'Origin: https://penyerang.example' \
        -X OPTIONS "$BASE/v1/dashboard" 2>/dev/null \
        | tr -d '\r' | grep -i 'access-control-allow-origin' | head -1)"
if [ -z "$evil" ]; then
  ok 'asal tak dikenal ditolak'
else
  bad 'CORS' "asal jahat diizinkan: $evil"
fi

# ── 8. rahasia di dalam citra ──────────────────────────────────────────
section '8. Rahasia'

# `.env` yang ikut tersalin ke lapisan citra dapat dibaca siapa pun yang
# menarik citranya. `.dockerignore` seharusnya mencegahnya — ini yang
# membuktikannya.
if $COMPOSE exec -T api sh -c 'ls /app/.env /app/.env.prod' >/dev/null 2>&1; then
  bad 'berkas .env ada di dalam citra' 'periksa .dockerignore'
else
  ok 'tidak ada berkas .env di dalam citra'
fi

# ── 9. pengguna non-root ───────────────────────────────────────────────
section '9. Pengguna kontainer'

for svc in api web; do
  uid="$($COMPOSE exec -T "$svc" id -u 2>/dev/null | tr -d '[:space:]')"
  if [ "$uid" = "0" ]; then
    bad "$svc berjalan sebagai root" 'terobosan kontainer menjadi root di host'
  elif [ -n "$uid" ]; then
    ok "$svc berjalan sebagai uid $uid"
  else
    bad "$svc" 'tidak dapat membaca uid'
  fi
done

# ── ringkasan ──────────────────────────────────────────────────────────
printf '\n%s\n' '────────────────────────────────────────────'
printf 'LULUS %d   GAGAL %d\n' "$pass" "$fail"

if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mJANGAN arahkan lalu lintas produksi ke susunan ini.\033[0m\n'
  exit 1
fi
printf '\n\033[32mSusunan lulus seluruh pemeriksaan lokal.\033[0m\n'
