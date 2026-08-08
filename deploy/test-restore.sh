#!/usr/bin/env bash
#
# UJI PEMULIHAN — siklus penuh, otomatis, terhadap DATA UJI SAJA.
#
# Cadangan yang belum pernah dipulihkan adalah berkas, bukan cadangan. Skrip
# ini membuktikan siklusnya bekerja dengan benar-benar menghancurkan sesuatu
# lalu mengembalikannya, dan membandingkan angkanya.
#
# ── KESELAMATAN ────────────────────────────────────────────────────────
#
# Skrip MENOLAK jalan bila tabel `users` tidak kosong.
#
# Gerbangnya sengaja KASAR, bukan pintar. Aturan yang mencoba membedakan data
# uji dari data sungguhan akan salah tepat ketika taruhannya paling tinggi, dan
# yang hilang tidak dapat dikembalikan. "Harus kosong" tidak dapat salah baca.
#
# `FORCE_UNSAFE_RESTORE_TEST=saya-paham-risikonya` melewatinya, dan panjangnya
# frasa itu disengaja — ia tidak boleh terketik tanpa sadar.
#
# Uji pemulihan yang dijalankan di terminal yang salah adalah cara kehilangan
# produksi, bukan memverifikasinya.
#
#   ./deploy/test-restore.sh [env-file]
#
# Keluar 0 hanya bila SELURUH angka cocok sesudah pemulihan.

set -uo pipefail
export MSYS_NO_PATHCONV=1

ENV_FILE="${1:-.env.prod}"
COMPOSE="docker compose --env-file ${ENV_FILE} -f docker-compose.prod.yml"

# Berkas .env BUKAN skrip shell — kunci PEM di dalamnya memuat spasi tak
# terkutip, dan menyumbernya gagal dengan "PRIVATE: command not found".
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
PGUSER="$(envval POSTGRES_USER)"
PGDB="$(envval POSTGRES_DB)"

MARK='restore-test-'
pass=0
fail=0
ok()  { printf '  \033[32mOK  \033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mGAGAL\033[0m %s\n     → %s\n' "$1" "${2:-}"; fail=$((fail + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_q() {
  $COMPOSE exec -T postgres psql -U "$PGUSER" -d "$PGDB" -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

# ── 0. prasyarat ───────────────────────────────────────────────────────
step '0. Prasyarat'

if ! docker info >/dev/null 2>&1; then
  printf '  \033[31mMESIN DOCKER TIDAK BERJALAN.\033[0m\n'
  printf '  Uji pemulihan TIDAK DAPAT dijalankan, dan tidak boleh diklaim lulus.\n'
  exit 2
fi
ok 'mesin Docker berjalan'

if [ -z "$(psql_q 'SELECT 1')" ]; then
  bad 'basis data tidak menjawab' 'jalankan susunan produksi lebih dulu'
  exit 2
fi
ok 'basis data menjawab'

# ── 1. gerbang keselamatan ─────────────────────────────────────────────
step '1. Gerbang keselamatan'

# Satu pengguna pun cukup untuk berhenti.
#
# Gerbangnya sengaja KASAR — "basis data harus kosong" — bukan pintar. Aturan
# pintar yang mencoba membedakan data uji dari data sungguhan akan salah tepat
# ketika taruhannya paling tinggi, dan yang hilang tidak dapat dikembalikan.
total_users="$(psql_q 'SELECT count(*) FROM users')"

if [ "${FORCE_UNSAFE_RESTORE_TEST:-}" = 'saya-paham-risikonya' ]; then
  printf '  \033[33mGERBANG DILEWATI atas permintaan eksplisit.\033[0m\n'
elif [ "${total_users:-0}" -gt 0 ]; then
  bad "basis data memuat ${total_users} pengguna" \
      'skrip ini MENGHANCURKAN tabel. Jalankan hanya pada basis data uji yang kosong,
       atau setel FORCE_UNSAFE_RESTORE_TEST=saya-paham-risikonya bila yakin.'
  exit 1
else
  ok 'basis data kosong — aman untuk diuji'
fi

# ── 2. tanam data uji ──────────────────────────────────────────────────
step '2. Menanam data uji'

STAMP="$(date -u +%s)"

# Pengguna DITANAM LEBIH DULU.
#
# `wallet_accounts.user_id` menunjuk `users` lewat foreign key, jadi menyisipkan
# dompet ke basis data kosong gagal senyap — percobaan pertama melaporkan
# "tidak ada baris" tanpa menyebut sebabnya. Kolom terenkripsi diisi bytea
# harfiah: uji ini memeriksa PEMULIHAN, bukan kriptografi, dan isinya tidak
# pernah didekripsi di sepanjang jalur ini.
$COMPOSE exec -T postgres psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -c "
  INSERT INTO users (id, email_hash, hmac_key_version, email_encrypted,
                     full_name_encrypted, password_hash, status)
  VALUES ('usr_${MARK}${STAMP}', '\x00'::bytea, 1, '\x00'::bytea,
          '\x00'::bytea, 'uji-pemulihan-bukan-hash-sungguhan', 'active')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO wallet_accounts (id, user_id, name, kind, currency, opening_balance)
  VALUES ('acc_${MARK}${STAMP}', 'usr_${MARK}${STAMP}', 'Dompet Uji Pulih',
          'cash', 'IDR', 1000000)
  ON CONFLICT (id) DO NOTHING;
" >/dev/null 2>&1

seeded="$(psql_q "SELECT count(*) FROM wallet_accounts WHERE id LIKE 'acc_${MARK}%'")"
if [ "${seeded:-0}" -ge 1 ]; then
  ok "menanam ${seeded} baris uji (pengguna + dompet)"
else
  bad 'penanaman' 'tidak ada baris — periksa batasan foreign key'
  exit 1
fi

before_accounts="$(psql_q 'SELECT count(*) FROM wallet_accounts')"
before_trx="$(psql_q 'SELECT count(*) FROM transactions')"
before_cat="$(psql_q 'SELECT count(*) FROM categories')"
printf '  keadaan sebelum: wallet_accounts=%s transactions=%s categories=%s\n' \
  "$before_accounts" "$before_trx" "$before_cat"

# ── 3. cadangkan ───────────────────────────────────────────────────────
step '3. Mencadangkan'

if bash deploy/backup.sh "$ENV_FILE" >/dev/null 2>&1; then
  ok 'cadangan dibuat dan terbukti terbaca pg_restore'
else
  bad 'cadangan' 'backup.sh keluar bukan-nol'
  exit 1
fi

DUMP="$($COMPOSE exec -T postgres sh -c 'ls -1t /backup/kantongz-*.dump | head -1' 2>/dev/null | tr -d '[:space:]')"
[ -n "$DUMP" ] && ok "berkas: $(basename "$DUMP")" || { bad 'berkas dump' 'tidak ditemukan'; exit 1; }

# ── 4. hancurkan ───────────────────────────────────────────────────────
step '4. Menghancurkan (disengaja)'

$COMPOSE exec -T postgres psql -U "$PGUSER" -d "$PGDB" \
  -c 'DROP TABLE IF EXISTS transactions CASCADE; DROP TABLE IF EXISTS wallet_accounts CASCADE;' \
  >/dev/null 2>&1

gone="$(psql_q "SELECT count(*) FROM information_schema.tables
                 WHERE table_name IN ('transactions','wallet_accounts')")"
if [ "${gone:-1}" = '0' ]; then ok 'dua tabel dihapus'; else bad 'penghancuran' "masih ada ${gone} tabel"; fi

# ── 5. pulihkan ────────────────────────────────────────────────────────
step '5. Memulihkan'

$COMPOSE stop api web >/dev/null 2>&1
if $COMPOSE exec -T postgres pg_restore -U "$PGUSER" -d "$PGDB" \
     --clean --if-exists --no-owner --no-privileges "$DUMP" >/dev/null 2>&1; then
  ok 'pg_restore selesai'
else
  # pg_restore mengembalikan bukan-nol pada peringatan yang tidak fatal.
  # Yang menentukan adalah apakah datanya kembali, bukan kode keluarnya.
  printf '  \033[33mcatatan: pg_restore keluar bukan-nol (sering hanya peringatan)\033[0m\n'
fi
$COMPOSE up -d api web >/dev/null 2>&1

# ── 6. bandingkan ──────────────────────────────────────────────────────
step '6. Membandingkan jumlah baris'

after_accounts="$(psql_q 'SELECT count(*) FROM wallet_accounts')"
after_trx="$(psql_q 'SELECT count(*) FROM transactions')"
after_cat="$(psql_q 'SELECT count(*) FROM categories')"

compare() {
  if [ "$2" = "$3" ]; then ok "$1: $2 → $3"; else bad "$1" "sebelum=$2 sesudah=$3"; fi
}
compare 'wallet_accounts' "$before_accounts" "$after_accounts"
compare 'transactions' "$before_trx" "$after_trx"
compare 'categories' "$before_cat" "$after_cat"

# Baris WAKIL, bukan sekadar jumlah. Jumlah yang cocok masih bisa berarti
# baris yang berbeda — pemulihan yang mengembalikan jumlah benar dengan isi
# salah adalah kegagalan yang paling sulit terlihat.
wakil="$(psql_q "SELECT name FROM wallet_accounts WHERE id = 'acc_${MARK}${STAMP}'")"
if [ "$wakil" = 'DompetUjiPulih' ] || [ "$wakil" = 'Dompet Uji Pulih' ]; then
  ok "baris wakil kembali utuh: '${wakil}'"
else
  bad 'baris wakil' "diharapkan 'Dompet Uji Pulih', dapat '${wakil:-kosong}'"
fi

# ── 7. aplikasi hidup kembali ──────────────────────────────────────────
step '7. Aplikasi sesudah pemulihan'

siap=0
for _ in $(seq 1 60); do
  if $COMPOSE exec -T api node -e \
    "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    siap=1; break
  fi
  sleep 2
done
[ "$siap" = '1' ] && ok 'API siap kembali' || bad 'API' 'tidak siap setelah pemulihan'

# ── 8. bersihkan ───────────────────────────────────────────────────────
step '8. Membersihkan data uji'
psql_q "DELETE FROM wallet_accounts WHERE id LIKE 'acc_${MARK}%'" >/dev/null
psql_q "DELETE FROM users WHERE id LIKE 'usr_${MARK}%'" >/dev/null
ok 'baris uji dihapus (dompet dan pengguna)'

# ── ringkasan ──────────────────────────────────────────────────────────
printf '\n%s\n' '────────────────────────────────────────────'
printf 'LULUS %d   GAGAL %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '\n\033[31mSIKLUS PEMULIHAN BELUM TERBUKTI. Jangan andalkan cadangan ini.\033[0m\n'
  exit 1
fi
printf '\n\033[32mSiklus cadangan → hancurkan → pulihkan → verifikasi TERBUKTI.\033[0m\n'
