import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const require = createRequire(import.meta.url);
// Resolve from the actual consumers, including any nested dependency copies.
const from = name => createRequire(require.resolve(name));

test('coverage selection preserves extensions, dotfiles, exclusions and reinclusion', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mailhub-coverage-'));
  try {
    const files = ['src/mail.ts', 'src/view.tsx', 'src/.hidden.ts', 'src/mail.test.ts',
      'src/generated/drop.ts', 'src/generated/keep.ts', 'src/readme.md',
      'node_modules/vendor/index.ts'];
    for (const file of files) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), 'export const value = 1;\n');
    }
    const TestExclude = from('babel-plugin-istanbul')('test-exclude');
    for (const reinclude of [false, true]) {
      const selector = new TestExclude({ cwd, extension: ['.ts', '.tsx'],
        include: ['src/**'], exclude: ['**/*.test.ts', 'src/generated/**',
          ...(reinclude ? ['!src/generated/keep.ts'] : [])] });
      const expected = ['src/.hidden.ts', 'src/mail.ts', 'src/view.tsx',
        ...(reinclude ? ['src/generated/keep.ts'] : [])].sort();
      assert.deepEqual(selector.globSync().sort(), expected);
      assert.deepEqual((await selector.glob()).sort(), expected);
      assert.equal(selector.shouldInstrument(path.resolve(cwd, '../outside.ts')), false);
    }
    for (const consumer of ['jest-config', 'jest-runtime', '@jest/reporters']) {
      const { glob } = from(consumer)('glob');
      assert.deepEqual(glob.sync('src/*.{ts,tsx}', { cwd, nodir: true,
        ignore: '**/*.test.ts', windowsPathsNoEscape: true }).sort(), ['src/mail.ts', 'src/view.tsx']);
      assert.deepEqual(glob.sync(path.join(cwd, 'src/mail.*'), {
        windowsPathsNoEscape: true,
      }).sort(), [path.join(cwd, 'src/mail.test.ts'), path.join(cwd, 'src/mail.ts')]);
      assert.deepEqual(await glob('missing/**/*.ts', { cwd }), []);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('lint keeps generated output ignored and source files selected', async () => {
  const eslint = new ESLint();
  for (const file of ['.next/server/page.js', 'out/index.js', 'build/index.js', 'next-env.d.ts']) {
    assert.equal(await eslint.isPathIgnored(file), true, file);
  }
  assert.equal(await eslint.isPathIgnored('src/worker.ts'), false);
  assert.equal(await eslint.isPathIgnored('src/components/email/ComposeModal.tsx'), false);
});

test('TypeScript ESLint project service keeps default-project pattern selection', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mailhub-lint-'));
  try {
    const { parseAndGenerateServices } = from('@typescript-eslint/parser')('@typescript-eslint/typescript-estree');
    const parse = file => parseAndGenerateServices('const value: number = 1;', {
      filePath: path.join(cwd, file), tsconfigRootDir: cwd,
      projectService: { allowDefaultProject: ['*.ts'] },
    });
    assert.ok(parse('.config.ts').services.program);
    assert.throws(() => parse('nested/config.ts'), /not found by the project service/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
