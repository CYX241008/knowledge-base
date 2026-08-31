import eslintConfigPrettier from 'eslint-config-prettier';
import turboPlugin from 'eslint-plugin-turbo';
import tseslint from 'typescript-eslint';

export const baseConfig = [
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    plugins: { turbo: turboPlugin },
    rules: { 'turbo/no-undeclared-env-vars': 'warn' },
  },
  { ignores: ['dist/**', 'coverage/**', '.next/**'] },
];
