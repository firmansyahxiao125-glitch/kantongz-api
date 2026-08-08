#!/usr/bin/env node
/**
 * Gerbang: setiap berkas `*.example` HARUS terlacak git.
 *
 * `.env.prod.example` pernah lolos dari repositori selama beberapa commit
 * karena `.gitignore` memuat `.env.*` sementara negasinya hanya menyebut
 * `.env.example`. Berkas itu MENDAFTARKAN setiap rahasia yang harus diisi
 * operator — dan ketiadaannya tidak menghasilkan satu pun galat. Yang
 * mengkloning hanya menemukan compose yang menolak jalan tanpa penjelasan.
 *
 * Kelas kesalahan ini tidak terlihat dari `git status`: berkas yang diabaikan
 * tidak muncul di sana sama sekali. Hanya pemeriksaan eksplisit yang
 * menemukannya.
 */

import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.example')) {
      /* `git ls-files` selalu memakai garis miring maju, termasuk di Windows.
         Tanpa penyeragaman ini, setiap templat di dalam subdirektori dilaporkan
         hilang di Windows meski terlacak. */
      out.push(relative(process.cwd(), full).split('\\').join('/'));
    }
  }
  return out;
}

const tracked = new Set(
  execSync('git ls-files', { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean),
);

const templates = walk(process.cwd());
const hilang = templates.filter((f) => !tracked.has(f));

console.log(`\nTemplat ditemukan: ${String(templates.length)}`);
for (const f of templates) console.log(`  ${tracked.has(f) ? '✓' : '✗'} ${f}`);

if (hilang.length > 0) {
  console.log('\nTIDAK TERLACAK — tambahkan pola negasi di .gitignore:\n');
  for (const f of hilang) console.log(`  ${f}`);
  console.log('');
  process.exit(1);
}
console.log('\nSeluruh templat terlacak.\n');
