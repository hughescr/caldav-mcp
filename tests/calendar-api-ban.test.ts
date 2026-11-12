import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The ical.js ban (design v3 section 6): ICAL.parse is the only API under src/, imported in exactly one place. These tests run the
// real .oxlintrc.json against negative snippets placed under a throwaway `src/` directory, and scan the real source for imports.

const ROOT = new URL('..', import.meta.url).pathname;
const OXLINT = join(ROOT, 'node_modules/.bin/oxlint');
const CONFIG = join(ROOT, '.oxlintrc.json');
const SCRATCH = mkdtempSync(join(tmpdir(), 'caldav-ban-'));
mkdirSync(join(SCRATCH, 'src/calendar'), { recursive: true });
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

interface Diagnostic { code: string; filename: string; message: string }

function lint(files: Record<string, string>): Map<string, string[]> {
    const paths = Object.entries(files).map(([name, source]) => {
        const path = join(SCRATCH, 'src/calendar', name);
        writeFileSync(path, source);
        return path;
    });
    const run = Bun.spawnSync([OXLINT, '--config', CONFIG, '--format', 'json', ...paths], { stdout: 'pipe', stderr: 'pipe' });
    const parsed: unknown = JSON.parse(run.stdout.toString());
    if (typeof parsed !== 'object' || parsed === null || !('diagnostics' in parsed) || !Array.isArray(parsed.diagnostics)) { throw new Error('unexpected oxlint output'); }
    const found = new Map<string, string[]>(Object.keys(files).map(name => [name, []]));
    for (const diagnostic of parsed.diagnostics as Diagnostic[]) {
        const name = diagnostic.filename.slice(join(SCRATCH, 'src/calendar').length + 1);
        found.get(name)?.push(diagnostic.code);
    }
    return found;
}

const RESTRICTED = ['eslint(no-restricted-properties)', 'eslint(no-restricted-imports)'];
const flagged = (codes: readonly string[] | undefined): boolean => (codes ?? []).some(code => RESTRICTED.includes(code));

const header = "import ICAL from 'ical.js';\n";
const NEGATIVE: Record<string, string> = {
    'direct-time.ts': `${header}export const a = ICAL.Time.fromString('x');\n`,
    'direct-component.ts': `${header}export const a = new ICAL.Component('vevent');\n`,
    'direct-timezone.ts': `${header}export const a = ICAL.Timezone.utcTimezone;\n`,
    'direct-event.ts': `${header}export const a = (c: unknown) => new ICAL.Event(c);\n`,
    'direct-recur-iterator.ts': `${header}export const a = ICAL.RecurIterator;\n`,
    'direct-recur-expansion.ts': `${header}export const a = ICAL.RecurExpansion;\n`,
    'direct-timezone-service.ts': `${header}export const a = ICAL.TimezoneService;\n`,
    'bracket.ts': `${header}export const a = ICAL['Time'];\n`,
    'bracket-template.ts': `${header}export const a = ICAL[\`Event\`];\n`,
    'destructured.ts': `${header}const { Timezone } = ICAL;\nexport { Timezone };\n`,
    'destructured-renamed.ts': `${header}const { Event: Renamed } = ICAL;\nexport { Renamed };\n`,
    'aliased-variable.ts': `${header}const alias = ICAL;\nexport const a = alias.Time;\n`,
    'aliased-import.ts': "import Other from 'ical.js';\nexport const a = Other.Event;\n",
    'aliased-bracket.ts': "import Other from 'ical.js';\nexport const a = Other['Component'];\n",
    'unknown-property.ts': `${header}export const a = ICAL.design;\n`,
    'hydration-first-value.ts': 'export const a = (c: { getFirstValue(n: string): unknown }) => c.getFirstValue("x");\n',
    'hydration-values.ts': 'export const a = (c: { getValues(): unknown }) => c.getValues();\n',
    'hydration-first-property-value.ts': 'export const a = (c: { getFirstPropertyValue(n: string): unknown }) => c.getFirstPropertyValue("x");\n',
    'hydration-all-property-values.ts': 'export const a = (c: { getAllPropertyValues(n: string): unknown }) => c.getAllPropertyValues("x");\n',
    'time-unix.ts': 'export const a = (t: { toUnixTime(): number }) => t.toUnixTime();\n',
    'time-js-date.ts': 'export const a = (t: { toJSDate(): Date }) => t.toJSDate();\n',
    'time-convert.ts': 'export const a = (t: { convertToZone(z: unknown): unknown }) => t.convertToZone(null);\n',
    'time-subtract.ts': 'export const a = (t: { subtractDate(o: unknown): unknown }) => t.subtractDate(null);\n',
    'time-adjust.ts': 'export const a = (t: { adjust(): void }) => t.adjust();\n',
    'time-offset.ts': 'export const a = (t: { utcOffset(): number }) => t.utcOffset();\n',
    'recur-iterator-method.ts': 'export const a = (r: { iterator(): unknown }) => r.iterator();\n',
    'import-from-other-module.ts': "import ICAL from 'ical.js';\nexport const a = ICAL.parse('x');\n",
    'import-named-parse.ts': "import { parse } from 'ical.js';\nexport { parse };\n",
    'import-namespace.ts': "import * as ICAL from 'ical.js';\nexport { ICAL };\n",
    'import-subpath.ts': "import Time from 'ical.js/dist/ical.js';\nexport { Time };\n",
};

describe('ical.js API ban through the real oxlint configuration', () => {
    const results = lint({
        ...NEGATIVE,
        // The one allowed spot is named ical.ts; the same snippets in other files must fail.
        'ical.ts': `${header}export const a = ICAL.parse('x');\n`,
        'clean.ts': 'export const a = [Temporal.Duration.from("PT1H"), Symbol.iterator, Temporal.compare];\n',
    });

    for (const [name, source] of Object.entries(NEGATIVE)) {
        test(`flags ${name}`, () => {
            expect<unknown>(flagged(results.get(name)), source).toBe(true);
        });
    }

    test('allows ICAL.parse behind the default import in src/calendar/ical.ts only', () => {
        expect<unknown>(results.get('ical.ts')).toEqual([]);
        expect<unknown>(flagged(results.get('import-from-other-module.ts'))).toBe(true);
    });

    test('allows Temporal.Duration, Symbol.iterator and Temporal.compare', () => {
        expect<unknown>(results.get('clean.ts')).toEqual([]);
    });

    test('flags non-default imports even in src/calendar/ical.ts', () => {
        const inIcal = lint({
            'ical.ts': "import { Time } from 'ical.js';\nimport * as All from 'ical.js';\nexport { All, Time };\n",
        });
        expect<unknown>(inIcal.get('ical.ts')?.filter(code => code === 'eslint(no-restricted-imports)')).toHaveLength(2);
    });
});

/** Source text with block and line comments removed, so prose mentioning the API is not mistaken for use. */
function withoutComments(source: string): string {
    return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '').replaceAll(/\s\/\/.*$/gmu, '');
}

describe('ical.js is imported in exactly one place, for parse only', () => {
    const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: join(ROOT, 'src'), absolute: false })];

    test('src/calendar/ical.ts is the only file that names the package in a string, import, require or dynamic import', async () => {
        const mentions: string[] = [];
        for (const file of files) {
            if (/['"`]ical\.js(?:[/'"`])/u.test(await Bun.file(join(ROOT, 'src', file)).text())) { mentions.push(file); }
        }
        expect<unknown>(mentions).toEqual(['calendar/ical.ts']);
    });

    test('ical.ts has one default import and its only use is ICAL.parse', async () => {
        const code = withoutComments(await Bun.file(join(ROOT, 'src/calendar/ical.ts')).text());
        expect<unknown>(code.match(/\bical\.js\b/gu)).toHaveLength(1);
        expect<unknown>(code.match(/^import ICAL from 'ical\.js';$/gmu)).toHaveLength(1);
        expect<unknown>(code.match(/\bICAL\b/gu)).toHaveLength(2);
        expect<unknown>(code.match(/\bICAL\.parse\(/gu)).toHaveLength(1);
        expect<unknown>(code).not.toMatch(/require\s*\(|import\s*\(/u);
    });

    test('the real source tree passes the restricted rules', () => {
        const run = Bun.spawnSync([OXLINT, '--config', CONFIG, '--format', 'json', join(ROOT, 'src')], { stdout: 'pipe', stderr: 'pipe' });
        const parsed: unknown = JSON.parse(run.stdout.toString());
        const diagnostics = typeof parsed === 'object' && parsed !== null && 'diagnostics' in parsed && Array.isArray(parsed.diagnostics) ? (parsed.diagnostics as Diagnostic[]) : [];
        expect<unknown>(diagnostics.filter(diagnostic => RESTRICTED.includes(diagnostic.code))).toEqual([]);
    });
});
