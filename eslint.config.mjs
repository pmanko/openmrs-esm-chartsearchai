import openmrs from '@openmrs/eslint-config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  { ignores: ['dist/**', 'coverage/**'] },
  ...openmrs,
  // Accessibility rules this repo got from eslint-config-ts-react-important-stuff,
  // which is eslintrc-only. Taken from the plugin directly instead.
  jsxA11y.flatConfigs.recommended,
  {
    rules: {
      // Rules this repo enforces where the shared config does not.
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/triple-slash-reference': 'error',
      'no-extra-boolean-cast': 'error',
      'no-prototype-builtins': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-useless-escape': 'error',
      'prefer-const': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // eslint-config-ts-react-important-stuff turned this off, so it stays off.
      'jsx-a11y/no-autofocus': 'off',
      // typescript-eslint v8 split ban-types, which this repo enforced on v7.
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      // Also from ts-react-important-stuff.
      'no-duplicate-imports': 'error',
      'no-extra-bind': 'error',
      'no-implied-eval': 'error',
      'no-labels': 'error',
      'no-self-compare': 'error',
      'no-throw-literal': 'error',
      'no-void': 'error',
    },
  },
  // This repo has no separate prettier script, so formatting is checked by lint.
  prettierRecommended,
];
