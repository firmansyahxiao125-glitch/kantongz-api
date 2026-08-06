import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Aturan sengaja sempit — sama seperti aplikasi.
 *
 * TypeScript strict sudah menangkap sebagian besar kesalahan bentuk. Yang
 * dicari di sini adalah yang tidak terlihat tipe: nilai yang tidak dipakai,
 * `any` yang menyelinap, dan promise yang tidak ditunggu — kelas terakhir itu
 * yang paling berbahaya di server, karena kegagalannya tidak pernah muncul di
 * mana pun.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['eslint.config.js', 'drizzle.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
