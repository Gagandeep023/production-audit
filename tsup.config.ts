import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      'index': 'src/index.ts',
      'rules/index': 'src/rules/index.ts',
      'cli/index': 'src/cli/index.ts',
      'types/index': 'src/types/index.ts',
      'register': 'src/register.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    minify: false,
  },
  {
    // CommonJS only: the bin resolves the preload with `__dirname`, and an ESM
    // twin of the same file would have no such binding.
    entry: { 'cli/bin': 'src/cli/bin.ts' },
    format: ['cjs'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    minify: false,
  },
]);
