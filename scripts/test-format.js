#!/usr/bin/env node
/**
 * Unit test for timestamp formatting (no server needed).
 *
 * Expected strings are the native REPL renderings (fmt_timestamp /
 * ts_to_parts in rayforce src/lang/format.c); the 2024 case is a
 * round-trip of a literal parsed by a live rayforce instance.
 *
 * Run `npm run compile` first, then `npm run test:format`.
 */

const path = require('path');

const { formatValue } = require(path.join(__dirname, '..', 'out', 'rayforceIpc.js'));
const { formatValueText, formatValueHtml } = require(path.join(__dirname, '..', 'out', 'prettyPrint.js'));

const ts = (value) => ({ _type: 'timestamp', value });

const cases = [
    // Pre-2000 (negative) values — the regression this test guards:
    // truncating BigInt division put these on the wrong day with a
    // negative nanosecond field ("2000.01.01D00:00:00.0000000-1")
    [-1n, '1999.12.31D23:59:59.999999999'],
    [-500000000n, '1999.12.31D23:59:59.500000000'],
    [-86400000000000n + 123n, '1999.12.31D00:00:00.000000123'],
    [-946684800000000000n, '1970.01.01D00:00:00.000000000'], // Unix epoch
    // 2000+ values — behavior unchanged
    [0n, '2000.01.01D00:00:00.000000000'],
    [1234567890n, '2000.01.01D00:00:01.234567890'],
    [763821045123456789n, '2024.03.15D12:30:45.123456789'],
];

let passed = 0;
let failed = 0;

function check(name, got, want) {
    if (got === want) {
        passed++;
        console.log(`  ok    ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name} — got "${got}", want "${want}"`);
    }
}

for (const [value, want] of cases) {
    check(`formatValue(${value}n)`, formatValue(ts(value)), want);
    check(`formatValueText(${value}n)`, formatValueText(ts(value)), want);

    const html = formatValueHtml(ts(value));
    check(`formatValueHtml(${value}n)`, html.includes(`>${want}<`) ? want : html, want);
}

// Null timestamp still renders as the typed null literal
check('formatValueText(0Np)', formatValueText(ts(-9223372036854775808n)), '0Np');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
