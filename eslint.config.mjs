// Configurazione ESLint (non inclusa nello zip dell'estensione)
import js from '@eslint/js';

export default [
    js.configs.recommended,
    {
        files: ['extension/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                global: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                console: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': 'error',
            'no-await-in-loop': 'warn',
        },
    },
];
