import js from '@eslint/js'
import ts from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import { defineConfig } from 'eslint/config'

export default defineConfig(
  { ignores: ['dist/', 'src-tauri/'] },
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  // Turn off rules that conflict with Prettier. Keep these after the rule sets above.
  prettier,
  svelte.configs.prettier,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // <script lang="ts"> inside .svelte files needs the TypeScript parser
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  {
    // The engine is plain TypeScript: it never imports Svelte or the UI, and never uses runes
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['svelte', 'svelte/*', '*.svelte', '**/ui/*'],
              message: 'The engine must not import Svelte or the UI.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Identifier[name=/^\\$(state|derived|effect|props|bindable|inspect|host)$/]',
          message: 'The engine must not use Svelte runes.',
        },
      ],
    },
  },
)
