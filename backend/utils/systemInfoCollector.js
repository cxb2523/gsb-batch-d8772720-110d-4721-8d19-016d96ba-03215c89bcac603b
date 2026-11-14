'use strict';

/**
 * System Info Collector
 * ---------------------
 * Collects remote system information item by item. Each probe (OS, CPU, memory,
 * disk, load, system time/uptime, network interfaces, dependency versions) is
 * executed and parsed independently: a failing or malformed probe marks only
 * its own item as failed (with a human-readable reason) and never turns the
 * whole report into 'n/a'.
 *
 * This module is intentionally free of any SSH / config imports so it can be
 * unit-tested locally with a fake `exec` function.
 *
 * @module utils/systemInfoCollector
 */

/**
 * Item keys collected remotely, in report order.
 * @type {string[]}
 */
const PROBE_KEYS = ['os', 'cpu', 'memory', 'disk', 'load', 'system', 'network', 'dependencies'];

/**
 * Normalize any thrown value into a short, human-readable failure reason.
 * @param {*} err
 * @returns {string}
 */
function normalizeReason(err) {
    const raw = err && err.message ? err.message : String(err);
    const firstLine = raw.split('\n')[0].trim();
    return firstLine || 'unknown error';
}

/**
 * Throw a parse/validation error with a readable reason.
 * @param {string} message
 */
function fail(message) {
    throw new Error(message);
}

/**
 * Require `condition` to be truthy, otherwise fail with `message`.
 * @param {*} condition
 * @param {string} message
 */
function assertProbe(condition, message) {
    if (!condition) fail(message);
}

/**
 * Parse "value1|value2" style probe output.
 * @param {string} output
 * @returns {string[]}
 */
function splitPipe(output) {
    return String(output || '')
        .trim()
        .split('|')
        .map((part) => part.trim());
}

const parsers = {
    os(output) {
        const [type, arch] = splitPipe(output);
        assertProbe(type, 'missing OS type in probe output');
        return {
            type,
            arch: arch || 'n/a',
        };
    },

    cpu(output) {
        const [coresRaw, model] = splitPipe(output);
        const cores = Number(coresRaw);
        assertProbe(coresRaw && Number.isInteger(cores) && cores > 0, `invalid CPU core count: "${coresRaw || 'empty'}"`);
        return {
            cores,
            model: model || 'n/a',
        };
    },

    memory(output) {
        const lines = String(output || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        const total = lines[0];
        assertProbe(total, 'missing memory total in probe output');
        const [swap, swapFree] = lines[1] ? lines[1].split('|').map((part) => part.trim()) : [];
        return {
            total,
            swap: swap || 'n/a',
            swapFree: swapFree || 'n/a',
        };
    },

    disk(output) {
        const [total, free, used] = splitPipe(output);
        assertProbe(total && free && used, `incomplete disk probe output: "${String(output || '').trim() || 'empty'}"`);
        return { total, free, used };
    },

    load(output) {
        const fields = String(output || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        assertProbe(fields.length >= 3, `incomplete load average output: "${String(output || '').trim() || 'empty'}"`);
        const [one, five, fifteen] = fields;
        assertProbe(
            [one, five, fifteen].every((n) => !isNaN(Number(n))),
            `non-numeric load average output: "${fields.slice(0, 3).join(' ')}"`
        );
        return {
            load: `1min=${one}, 5min=${five}, 15min=${fifteen}`,
        };
    },

    system(output) {
        const [time, uptime] = splitPipe(output);
        assertProbe(time, 'missing system time in probe output');
        return {
            time,
            uptime: uptime || 'n/a',
        };
    },
};

/**
 * Parse raw `ip -o addr` output into the network interfaces map.
 * Tolerant by design: blank or malformed lines are skipped individually so a
 * single bad line never discards the other interfaces, and empty output (no
 * interfaces) yields an empty map rather than a failure.
 *
 * @param {string} output - Raw stdout of `ip -o addr`.
 * @returns {Object} Map of interface name -> array of { address, family, internal }.
 */
function parseNetworkInterfaces(output) {
    const network = {};
    String(output || '')
        .split('\n')
        .forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line) return;
            const parts = line.split(/\s+/);
            // Expected: <index>: <iface> <family> <addr>/<prefix> ...
            if (parts.length < 4) return; // skip incomplete line, keep the rest
            if (!/^\d+:$/.test(parts[0])) return; // not an `ip -o addr` record line
            const iface = (parts[1] || '').split('@')[0];
            const familyRaw = parts[2];
            const address = (parts[3] || '').split('/')[0];
            if (!iface || !address) return; // skip unusable line
            const family = familyRaw === 'inet' ? 'IPv4' : familyRaw === 'inet6' ? 'IPv6' : familyRaw;
            if (!network[iface]) network[iface] = [];
            network[iface].push({
                address,
                family,
                internal: iface === 'lo',
            });
        });
    return network;
}

/**
 * Build the remote shell script that probes every dependency in one round
 * trip. Each dependency reports exactly one line:
 *   <name>|ok|<version output>            command exists and ran successfully
 *   <name>|missing|command not found: X   command does not exist on the host
 *   <name>|error|exit_code=N <output>     command exists but its version probe failed
 *
 * @param {Array} deps - Dependency descriptors ({ name, cmd }).
 * @returns {string} Shell script.
 */
function buildDependencyProbe(deps) {
    const nvmInit = 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ';
    const shellInit = '. /etc/profile >/dev/null 2>&1; . ~/.profile >/dev/null 2>&1; . ~/.bashrc >/dev/null 2>&1; ';
    const checks = (deps || [])
        .map((dep) => {
            const bin = dep.name === 'gpp' ? 'g++' : dep.name;
            return (
                `if command -v ${bin} >/dev/null 2>&1; then ` +
                `out=$(${dep.cmd} 2>&1); rc=$?; ` +
                `if [ $rc -eq 0 ] && [ -n "$out" ]; then ` +
                `echo "${dep.name}|ok|$(printf '%s' "$out" | tr '\\n' ' ')"; ` +
                `else ` +
                `echo "${dep.name}|error|exit_code=$rc $(printf '%s' "$out" | tr '\\n' ' ' | head -c 200)"; ` +
                `fi; ` +
                `else echo "${dep.name}|missing|command not found: ${bin}"; fi`
            );
        })
        .join('; ');
    return nvmInit + shellInit + checks;
}

/**
 * Parse the dependency probe report. Distinguishes "command not found"
 * (installed: false) from "command exists but version probe failed"
 * (installed: true, version: null, error set). Dependencies missing from the
 * report entirely are flagged with an error instead of being silently dropped.
 *
 * @param {string} output - Raw stdout of the dependency probe script.
 * @param {Array} deps - Dependency descriptors that were probed.
 * @returns {Object} Map of dependency name -> { installed, version, error? }.
 */
function parseDependencyReport(output, deps) {
    const reported = {};
    String(output || '')
        .split('\n')
        .forEach((line) => {
            const firstSep = line.indexOf('|');
            if (firstSep === -1) return; // ignore noise lines (profile banners, etc.)
            const name = line.slice(0, firstSep).trim();
            if (!name) return;
            const rest = line.slice(firstSep + 1);
            const secondSep = rest.indexOf('|');
            const status = (secondSep === -1 ? rest : rest.slice(0, secondSep)).trim();
            const detail = (secondSep === -1 ? '' : rest.slice(secondSep + 1)).trim();
            reported[name] = { status, detail };
        });

    const dependencies = {};
    (deps || []).forEach((dep) => {
        const entry = reported[dep.name];
        if (!entry) {
            dependencies[dep.name] = {
                installed: false,
                version: null,
                error: 'no result reported by remote probe',
            };
        } else if (entry.status === 'ok') {
            dependencies[dep.name] = {
                installed: true,
                version: entry.detail || null,
            };
        } else if (entry.status === 'missing') {
            dependencies[dep.name] = {
                installed: false,
                version: null,
                error: entry.detail || `command not found: ${dep.name}`,
            };
        } else {
            // Command exists on the host but its version probe failed.
            dependencies[dep.name] = {
                installed: true,
                version: null,
                error: entry.detail || 'version command failed',
            };
        }
    });
    return dependencies;
}

/**
 * Build the probe plan: one independent shell command + parser per item.
 * @param {Array} deps - Dependency descriptors for the dependency probe.
 * @returns {Object} Map of item key -> { command, parse }.
 */
function buildProbes(deps) {
    return {
        os: {
            command: `printf '%s|%s' "$(uname -s)" "$(uname -m)"`,
            parse: parsers.os,
        },
        cpu: {
            command: `printf '%s|%s' "$(nproc 2>/dev/null)" "$(grep -m 1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | xargs)"`,
            parse: parsers.cpu,
        },
        memory: {
            command: `free -h | awk '/^Mem:/ {print $2} /^Swap:/ {print $2 "|" $4}'`,
            parse: parsers.memory,
        },
        disk: {
            command: `df -h / | awk 'NR==2 {print $2 "|" $4 "|" $5}'`,
            parse: parsers.disk,
        },
        load: {
            command: `cat /proc/loadavg`,
            parse: parsers.load,
        },
        system: {
            command: `printf '%s|%s' "$(date)" "$(uptime -p 2>/dev/null)"`,
            parse: parsers.system,
        },
        network: {
            command: `ip -o addr 2>/dev/null`,
            parse: parseNetworkInterfaces,
        },
        dependencies: {
            command: buildDependencyProbe(deps),
            parse: (output) => {
                const dependencies = parseDependencyReport(output, deps);
                if ((deps || []).length > 0) {
                    assertProbe(String(output || '').trim().length > 0, 'empty dependency probe output');
                }
                return dependencies;
            },
        },
    };
}

/**
 * Collect system information item by item using the injected command executor.
 *
 * Every probe is isolated: if its command fails or its output cannot be
 * parsed, only that item is marked as failed in `collection` (with a readable
 * reason) and the corresponding fields fall back to 'n/a'/null defaults. This
 * function never throws because of a failing probe; it only throws if `exec`
 * itself is not callable.
 *
 * @param {(command: string) => Promise<string>} exec - Executes a shell command
 *   remotely and resolves with its stdout (e.g. sshExec).
 * @param {Array} [deps] - Dependency descriptors ({ name, cmd }) to probe.
 * @returns {Promise<Object>} System information object with the legacy field
 *   structure (os, cpu, memory, disk, system, network, dependencies) plus a
 *   `collection` map describing each item's outcome:
 *   { success: boolean, reason?: string }.
 */
async function collectSystemInfo(exec, deps = []) {
    if (typeof exec !== 'function') {
        throw new Error('collectSystemInfo requires an exec(command) function');
    }

    const probes = buildProbes(deps);
    const values = {};
    const collection = {};

    await Promise.all(
        PROBE_KEYS.map(async (key) => {
            try {
                const output = await exec(probes[key].command);
                values[key] = probes[key].parse(output);
                collection[key] = { success: true };
            } catch (err) {
                values[key] = null;
                collection[key] = { success: false, reason: normalizeReason(err) };
            }
        })
    );

    const os = values.os || {};
    const cpu = values.cpu || {};
    const memory = values.memory || {};
    const disk = values.disk || {};
    const load = values.load || {};
    const system = values.system || {};

    return {
        os: {
            type: os.type || 'n/a',
            arch: os.arch || 'n/a',
        },
        cpu: {
            cores: cpu.cores !== undefined ? cpu.cores : null,
            model: cpu.model || 'n/a',
        },
        memory: {
            total: memory.total || 'n/a',
            swap: memory.swap || 'n/a',
            swapFree: memory.swapFree || 'n/a',
        },
        disk: {
            total: disk.total || 'n/a',
            free: disk.free || 'n/a',
            used: disk.used || 'n/a',
        },
        system: {
            time: system.time || 'n/a',
            uptime: system.uptime || 'n/a',
            load: load.load || 'n/a',
        },
        network: values.network || {},
        dependencies: values.dependencies || {},
        collection,
    };
}

module.exports = {
    PROBE_KEYS,
    collectSystemInfo,
    buildProbes,
    buildDependencyProbe,
    parseDependencyReport,
    parseNetworkInterfaces,
};
