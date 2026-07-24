#!/usr/bin/env node
/**
 * Integration test for the wire protocol v3 IPC client.
 *
 * Spawns a local rayforce instance (from $RAYFORCE_BIN or PATH) and runs the
 * compiled client (out/rayforceIpc.js) against it.  Run `npm run compile`
 * first, then `npm run test:ipc`.
 */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const { RayforceIpcClient, AuthRequiredError, isError } = require(path.join(__dirname, '..', 'out', 'rayforceIpc.js'));

const RAYFORCE_BIN = process.env.RAYFORCE_BIN || 'rayforce';
const HOST = '127.0.0.1';

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  ok    ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function show(v) {
    return typeof v === 'symbol' ? v.toString() : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));
}

function spawnRayforce(port, extraArgs) {
    const proc = spawn(RAYFORCE_BIN, ['-p', String(port), ...(extraArgs || [])], {
        stdio: ['ignore', 'ignore', 'inherit']
    });
    proc.on('error', (err) => {
        console.error(`Cannot start ${RAYFORCE_BIN}: ${err.message} (set RAYFORCE_BIN to the binary path)`);
        process.exit(2);
    });
    return proc;
}

function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const s = net.connect(port, HOST);
            s.once('connect', () => { s.destroy(); resolve(); });
            s.once('error', () => {
                s.destroy();
                if (Date.now() > deadline) reject(new Error(`rayforce did not listen on ${port} within ${timeoutMs}ms`));
                else setTimeout(attempt, 100);
            });
        };
        attempt();
    });
}

async function testValues(client) {
    const eq = async (expr, expect, name) => {
        const got = await client.execute(expr);
        ok(name || expr, show(got) === show(expect), `got ${show(got)}, want ${show(expect)}`);
    };

    // Atoms
    await eq('42', 42n);
    await eq('3.5', 3.5);
    await eq('true', true);
    await eq('"hello"', 'hello');
    await eq('"пример юникода"', 'пример юникода', 'utf8 string');
    await eq('(println "")', null, 'null result (wire null marker)');
    await eq('0Nl', null, 'typed null atom');

    const sym = await client.execute("'foo");
    ok("'foo symbol", typeof sym === 'symbol' && Symbol.keyFor(sym) === 'foo', show(sym));

    const date = await client.execute('2024.03.15');
    ok('date atom', date && date._type === 'date', show(date));

    const ts = await client.execute('2024.03.15D12:30:45.123456789');
    ok('timestamp atom', ts && ts._type === 'timestamp' && ts.value === 763821045123456789n, show(ts));

    // Vectors and lists
    await eq('[1 2 3]', [1n, 2n, 3n]);
    await eq('[1.5 2.5]', [1.5, 2.5]);
    await eq('(til 4)', [0n, 1n, 2n, 3n]);

    const list = await client.execute('(list 1 "a" \'b)');
    ok('mixed list', Array.isArray(list) && list.length === 3 && list[0] === 1n && list[1] === 'a', show(list));

    // Dict
    const dict = await client.execute("(dict ['a 'b] [1 2])");
    ok('dict', dict && dict._type === 'dict' && Array.isArray(dict.keys) && dict.keys.length === 2, show(dict && dict.keys));

    // Table
    const table = await client.execute("(table ['a 'b] (list [1 2 3] [4.5 5.5 6.5]))");
    ok('table columns', table && table._type === 'table' && table.columns.join(',') === 'a,b', show(table && table.columns));
    ok('table values', table && table.values.length === 2 && table.values[0].length === 3 && table.values[1][2] === 6.5,
        show(table && table.values));

    // Compressed response (serialized size is far above the 2000-byte threshold)
    const big = await client.execute('(til 100000)');
    ok('compressed vector length', Array.isArray(big) && big.length === 100000, `len ${big && big.length}`);
    ok('compressed vector data', Array.isArray(big) && big[0] === 0n && big[99999] === 99999n,
        Array.isArray(big) ? `ends ${show(big[99999])}` : show(big));

    const bigTable = await client.execute("(table ['n 's] (list (til 5000) (map (fn [x] 'sym) (til 5000))))");
    ok('compressed table', bigTable && bigTable._type === 'table' && bigTable.values[0].length === 5000,
        show(bigTable && bigTable.columns));

    // Builtins and lambdas
    const builtin = await client.execute('sum');
    ok('builtin by name', builtin && builtin._type === 'function' && builtin.name === 'sum', show(builtin));

    const lambda = await client.execute('(fn [x] x)');
    ok('lambda', lambda && lambda._type === 'function' && lambda.name === null, show(lambda));

    // Errors: packed ASCII code
    const typeErr = await client.execute("(+ 1 'x)");
    ok("type error code", isError(typeErr) && typeErr.code === 'type', show(typeErr));

    const parseErr = await client.execute(')))');
    ok("parse error code (REPL fallback relies on this)", isError(parseErr) && parseErr.code === 'parse', show(parseErr));

    // Async fire-and-forget then read back
    await client.executeAsync('(set g_ipc_test 7)');
    const asyncVal = await client.execute('g_ipc_test');
    ok('async set + sync read', asyncVal === 7n, show(asyncVal));

    // The exact queries the Environment panel sends: names and types must
    // arrive in the same order so the panel can pair them up
    const envNames = await client.execute('(key (env 0))');
    const envTypes = await client.execute('(map type (value (env 0)))');
    ok('env names/types pair up', Array.isArray(envNames) && Array.isArray(envTypes) &&
        envNames.length === envTypes.length && envNames.length > 0,
        `names ${envNames && envNames.length}, types ${envTypes && envTypes.length}`);

    const envIdx = Array.isArray(envNames)
        ? envNames.findIndex((s) => typeof s === 'symbol' && Symbol.keyFor(s) === 'g_ipc_test')
        : -1;
    ok('user var has aligned type', envIdx >= 0 && typeof envTypes[envIdx] === 'symbol' &&
        Symbol.keyFor(envTypes[envIdx]) === 'i64',
        envIdx >= 0 ? `type ${show(envTypes[envIdx])}` : 'g_ipc_test not found');

    // The exact preview wrapper the REPL panel sends for large results
    const wrapper = "((fn [] (let __pr_r (table ['n] (list (til 50)))) (let __pr_t (type __pr_r)) (let __pr_c (if (or (== __pr_t 'TABLE) (== __pr_t 'LIST)) (count __pr_r) 0)) (list __pr_c __pr_t (if (> __pr_c 10) (take __pr_r [0 10]) __pr_r))))";
    const wrapped = await client.execute(wrapper);
    ok('REPL preview wrapper', Array.isArray(wrapped) && wrapped.length === 3 && Number(wrapped[0]) === 50 &&
        wrapped[2] && wrapped[2]._type === 'table' && wrapped[2].values[0].length === 10, show(wrapped && wrapped[0]));
}

async function testAuth(port) {
    const noCreds = new RayforceIpcClient(HOST, port);
    try {
        await noCreds.connect(3000);
        ok('auth: rejected without password', false, 'connect unexpectedly succeeded');
        noCreds.disconnect();
    } catch (err) {
        ok('auth: rejected without password', err instanceof AuthRequiredError, err.message);
    }

    const wrongCreds = new RayforceIpcClient(HOST, port);
    try {
        await wrongCreds.connect(3000, { password: 'wrong' });
        ok('auth: rejected with wrong password', false, 'connect unexpectedly succeeded');
        wrongCreds.disconnect();
    } catch (err) {
        ok('auth: rejected with wrong password', /rejected|closed/i.test(err.message), err.message);
    }

    const goodCreds = new RayforceIpcClient(HOST, port);
    try {
        await goodCreds.connect(3000, { password: 'testpw' });
        const v = await goodCreds.execute('(+ 1 2)');
        ok('auth: accepted with password', v === 3n, show(v));
    } catch (err) {
        ok('auth: accepted with password', false, err.message);
    } finally {
        goodCreds.disconnect();
    }

    const userCreds = new RayforceIpcClient(HOST, port);
    try {
        await userCreds.connect(3000, { user: 'root', password: 'testpw' });
        const v = await userCreds.execute('(+ 2 3)');
        ok('auth: accepted with user and password', v === 5n, show(v));
    } catch (err) {
        ok('auth: accepted with user and password', false, err.message);
    } finally {
        userCreds.disconnect();
    }
}

async function main() {
    const port = 5000 + Math.floor(Math.random() * 2000);
    const authPort = port + 1;

    console.log(`Starting ${RAYFORCE_BIN} on :${port} (plain) and :${authPort} (auth)...`);
    const server = spawnRayforce(port);
    const authServer = spawnRayforce(authPort, ['-u', 'testpw']);

    try {
        await waitForPort(port, 10000);
        await waitForPort(authPort, 10000);

        const client = new RayforceIpcClient(HOST, port);
        await client.connect(5000);
        console.log('Connected (handshake v3).');

        await testValues(client);
        client.disconnect();

        console.log('Auth handshake:');
        await testAuth(authPort);
    } finally {
        server.kill();
        authServer.kill();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
