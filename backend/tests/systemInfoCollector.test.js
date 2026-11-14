'use strict';

/**
 * System Info Collector Tests
 * ---------------------------
 * Local tests for the remote system-info collector. No real SSH host is
 * involved: the collector's `exec` function is replaced by a fake that
 * returns canned remote output (or fails) per probe command.
 *
 * Run with: node --test backend/tests/
 *
 * @module tests/systemInfoCollector
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PROBE_KEYS,
    collectSystemInfo,
    parseNetworkInterfaces,
    parseDependencyReport,
    buildDependencyProbe,
} = require('../utils/systemInfoCollector');

const DEPS = [
    { name: 'git', cmd: 'git --version' },
    { name: 'node', cmd: 'node --version' },
    { name: 'nginx', cmd: 'nginx -v 2>&1 | grep -o "[0-9.]\\+"' },
];

const GOOD_OUTPUTS = {
    os: 'Linux|x86_64',
    cpu: '4|Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
    memory: '7.8Gi\n1.0Gi|0.5Gi',
    disk: '40G|22G|58%',
    load: '0.42 0.36 0.30 1/234 5678',
    system: 'Thu Nov 14 10:00:00 UTC 2026|up 3 days, 2 hours',
    network:
        '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n' +
        '2: eth0    inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever\n' +
        '2: eth0    inet6 fe80::1/64 scope link \\       valid_lft forever preferred_lft forever',
    dependencies:
        'git|ok|git version 2.43.0\n' +
        'node|ok|v20.11.0\n' +
        'nginx|missing|command not found: nginx',
};

/**
 * Build a fake remote executor. `outputs` maps probe key -> stdout string;
 * `failures` maps probe key -> Error/message for probes whose command fails.
 * @param {Object} outputs
 * @param {Object} [failures]
 * @returns {(command: string) => Promise<string>}
 */
function makeFakeExec(outputs, failures = {}) {
    return async (command) => {
        const key = PROBE_KEYS.find((k) => commandMatchesProbe(k, command));
        assert.ok(key, `fake exec received an unknown probe command: ${command}`);
        if (failures[key]) {
            const failure = failures[key];
            throw failure instanceof Error ? failure : new Error(failure);
        }
        return outputs[key] !== undefined ? outputs[key] : '';
    };
}

/**
 * Heuristic mapping from the generated probe command to its item key.
 * @param {string} key
 * @param {string} command
 * @returns {boolean}
 */
function commandMatchesProbe(key, command) {
    switch (key) {
        case 'os':
            return command.includes('uname -s');
        case 'cpu':
            return command.includes('nproc');
        case 'memory':
            return command.startsWith('free -h');
        case 'disk':
            return command.startsWith('df -h');
        case 'load':
            return command.includes('loadavg');
        case 'system':
            return command.includes('uptime -p');
        case 'network':
            return command.includes('ip -o addr');
        case 'dependencies':
            return command.includes('command -v');
        default:
            return false;
    }
}

test('all probes succeed: every item reports success and parsed values', async () => {
    const info = await collectSystemInfo(makeFakeExec(GOOD_OUTPUTS), DEPS);

    // Per-item outcomes: all successful, no reasons.
    for (const key of PROBE_KEYS) {
        assert.equal(info.collection[key].success, true, `item "${key}" should succeed`);
        assert.equal(info.collection[key].reason, undefined);
    }

    // Legacy field structure with parsed values.
    assert.equal(info.os.type, 'Linux');
    assert.equal(info.os.arch, 'x86_64');
    assert.equal(info.cpu.cores, 4);
    assert.equal(info.cpu.model, 'Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz');
    assert.equal(info.memory.total, '7.8Gi');
    assert.equal(info.memory.swap, '1.0Gi');
    assert.equal(info.memory.swapFree, '0.5Gi');
    assert.equal(info.disk.total, '40G');
    assert.equal(info.disk.free, '22G');
    assert.equal(info.disk.used, '58%');
    assert.equal(info.system.load, '1min=0.42, 5min=0.36, 15min=0.30');
    assert.equal(info.system.time, 'Thu Nov 14 10:00:00 UTC 2026');
    assert.equal(info.system.uptime, 'up 3 days, 2 hours');

    // Network interfaces parsed per interface/family.
    assert.deepEqual(info.network.lo, [{ address: '127.0.0.1', family: 'IPv4', internal: true }]);
    assert.equal(info.network.eth0.length, 2);
    assert.equal(info.network.eth0[0].address, '192.168.1.10');
    assert.equal(info.network.eth0[0].family, 'IPv4');
    assert.equal(info.network.eth0[0].internal, false);
    assert.equal(info.network.eth0[1].family, 'IPv6');

    // Dependencies: installed with version vs not installed.
    assert.deepEqual(info.dependencies.git, { installed: true, version: 'git version 2.43.0' });
    assert.deepEqual(info.dependencies.node, { installed: true, version: 'v20.11.0' });
    assert.equal(info.dependencies.nginx.installed, false);
    assert.equal(info.dependencies.nginx.version, null);
    assert.match(info.dependencies.nginx.error, /command not found/);
});

test('partial command failures: failed items carry a reason, others keep their values', async () => {
    const failures = {
        disk: 'df: command failed with exit code 1',
        load: new Error('cat: /proc/loadavg: Permission denied'),
    };
    const outputs = {
        ...GOOD_OUTPUTS,
        // node exists but its version probe fails; nginx is missing entirely.
        dependencies:
            'git|ok|git version 2.43.0\n' +
            'node|error|exit_code=1 segmentation fault\n' +
            'nginx|missing|command not found: nginx',
    };

    const info = await collectSystemInfo(makeFakeExec(outputs, failures), DEPS);

    // Failed items: marked failed with a readable reason.
    assert.equal(info.collection.disk.success, false);
    assert.match(info.collection.disk.reason, /df: command failed/);
    assert.equal(info.collection.load.success, false);
    assert.match(info.collection.load.reason, /Permission denied/);

    // Failed items fall back to n/a defaults in the legacy fields.
    assert.equal(info.disk.total, 'n/a');
    assert.equal(info.disk.free, 'n/a');
    assert.equal(info.disk.used, 'n/a');
    assert.equal(info.system.load, 'n/a');

    // Unaffected items still succeeded with real values.
    assert.equal(info.collection.os.success, true);
    assert.equal(info.collection.cpu.success, true);
    assert.equal(info.collection.memory.success, true);
    assert.equal(info.collection.network.success, true);
    assert.equal(info.collection.dependencies.success, true);
    assert.equal(info.os.type, 'Linux');
    assert.equal(info.cpu.cores, 4);
    assert.equal(info.memory.total, '7.8Gi');
    assert.equal(info.system.time, 'Thu Nov 14 10:00:00 UTC 2026');
    assert.ok(info.network.eth0);

    // Dependency outcomes distinguish missing command vs failing command.
    assert.deepEqual(info.dependencies.git, { installed: true, version: 'git version 2.43.0' });
    assert.equal(info.dependencies.node.installed, true, 'node binary exists even though its probe failed');
    assert.equal(info.dependencies.node.version, null);
    assert.match(info.dependencies.node.error, /exit_code=1/);
    assert.equal(info.dependencies.nginx.installed, false);
    assert.match(info.dependencies.nginx.error, /command not found/);
});

test('empty remote output: items fail with reasons, no uncaught exception, defaults hold', async () => {
    const emptyOutputs = Object.fromEntries(PROBE_KEYS.map((key) => [key, '']));

    let info;
    await assert.doesNotReject(async () => {
        info = await collectSystemInfo(makeFakeExec(emptyOutputs), DEPS);
    });

    // Data-bearing items fail with a readable reason each.
    for (const key of ['os', 'cpu', 'memory', 'disk', 'load', 'system', 'dependencies']) {
        assert.equal(info.collection[key].success, false, `item "${key}" should fail on empty output`);
        assert.ok(info.collection[key].reason.length > 0, `item "${key}" should have a failure reason`);
    }

    // Empty network output means "no interfaces", which is a valid result.
    assert.equal(info.collection.network.success, true);
    assert.deepEqual(info.network, {});

    // Legacy fields fall back to n/a/null defaults.
    assert.equal(info.os.type, 'n/a');
    assert.equal(info.os.arch, 'n/a');
    assert.equal(info.cpu.cores, null);
    assert.equal(info.cpu.model, 'n/a');
    assert.equal(info.memory.total, 'n/a');
    assert.equal(info.memory.swap, 'n/a');
    assert.equal(info.memory.swapFree, 'n/a');
    assert.equal(info.disk.total, 'n/a');
    assert.equal(info.system.time, 'n/a');
    assert.equal(info.system.uptime, 'n/a');
    assert.equal(info.system.load, 'n/a');
    assert.deepEqual(info.dependencies, {});
});

test('network parser: no interfaces and malformed lines do not drop valid interfaces', () => {
    // No interfaces at all.
    assert.deepEqual(parseNetworkInterfaces(''), {});
    assert.deepEqual(parseNetworkInterfaces('\n  \n'), {});

    // One malformed line among valid ones: only the bad line is skipped.
    const mixed =
        '2: eth0    inet 10.0.0.5/8 scope global eth0\n' +
        'this is not a valid interface line\n' +
        '3: wlan0\n' + // truncated: missing family/address
        '2: eth0    inet6 fe80::42/64 scope link\n';
    const network = parseNetworkInterfaces(mixed);
    assert.deepEqual(network, {
        eth0: [
            { address: '10.0.0.5', family: 'IPv4', internal: false },
            { address: 'fe80::42', family: 'IPv6', internal: false },
        ],
    });
});

test('dependency probe: distinguishes missing command from failing command', () => {
    const script = buildDependencyProbe(DEPS);
    assert.match(script, /command -v git/);
    assert.match(script, /git\|ok\|/);
    assert.match(script, /git\|error\|exit_code=/);
    assert.match(script, /git\|missing\|command not found: git/);

    const report = 'git|ok|git version 2.43.0\nnode|error|exit_code=127 weird failure\n';
    const parsed = parseDependencyReport(report, DEPS);
    assert.deepEqual(parsed.git, { installed: true, version: 'git version 2.43.0' });
    assert.equal(parsed.node.installed, true);
    assert.equal(parsed.node.version, null);
    assert.match(parsed.node.error, /exit_code=127/);
    // A dependency absent from the report is flagged, not silently dropped.
    assert.equal(parsed.nginx.installed, false);
    assert.match(parsed.nginx.error, /no result reported/);
});

test('malformed probe output fails only the affected item', async () => {
    const outputs = {
        ...GOOD_OUTPUTS,
        cpu: 'not-a-number|', // invalid core count
        disk: '40G', // incomplete: missing free/used fields
    };
    const info = await collectSystemInfo(makeFakeExec(outputs), DEPS);

    assert.equal(info.collection.cpu.success, false);
    assert.match(info.collection.cpu.reason, /invalid CPU core count/);
    assert.equal(info.collection.disk.success, false);
    assert.match(info.collection.disk.reason, /incomplete disk probe output/);

    assert.equal(info.cpu.cores, null);
    assert.equal(info.disk.total, 'n/a');

    // Everything else is unaffected.
    assert.equal(info.os.type, 'Linux');
    assert.equal(info.memory.total, '7.8Gi');
    assert.equal(info.system.load, '1min=0.42, 5min=0.36, 15min=0.30');
});
