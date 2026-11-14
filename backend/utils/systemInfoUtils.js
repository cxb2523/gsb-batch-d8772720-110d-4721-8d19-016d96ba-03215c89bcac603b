'use strict';

/**
 * System Info Utilities
 * ---------------------
 * Provides functions to gather system information (OS, CPU, memory, disk, network, dependencies)
 * for the admin dashboard, both locally and via SSH.
 *
 * @module utils/systemInfoUtils
 */

const os = require('os');
const { execSync } = require('child_process');
const { getAppDependencies, checkDependency } = require('./dependencyUtils');
const { sshExec, sshReadFile } = require('./sshUtils');
const { collectSystemInfo, buildDependencyProbe, parseDependencyReport } = require('./systemInfoCollector');
const config = require('../config');
const { APP_MANAGE_MODE } = config;

/**
 * Format uptime in a human-readable way.
 * @param {number} seconds
 * @returns {string}
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / (24 * 3600));
    seconds %= 24 * 3600;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);

    const parts = [];
    if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);

    return `up ${parts.join(', ')}`;
}

function getDiskInfo() {
    try {
        const output = execSync('df -h / | tail -1', {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
        const parts = output.split(/\s+/);
        if (parts.length >= 5) {
            return { total: parts[1], free: parts[3], used: parts[4] };
        }
    } catch (e) {}
    return { total: 'n/a', free: 'n/a', used: 'n/a' };
}

function getSwapInfo() {
    try {
        const output = execSync('free -g | grep Swap', {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
        const parts = output.split(/\s+/);
        if (parts.length >= 3) {
            return { total: parts[1] + 'G', free: parts[3] + 'G' };
        }
    } catch (e) {}
    return { total: 'n/a', free: 'n/a' };
}

/**
 * Get system info locally.
 * @returns {object}
 */
function getSystemInfoLocal() {
    const dependencies = {};
    getAppDependencies().forEach((dep) => {
        const [cmd, versionArg, parseVersion] = dep.local;
        dependencies[dep.name] = checkDependency(cmd, versionArg, parseVersion);
    });

    const disk = getDiskInfo();
    const swap = getSwapInfo();

    return {
        os: {
            type: os.platform() === 'darwin' ? 'Mac OS' : os.platform() === 'win32' ? 'Windows' : 'Linux',
            arch: os.arch(),
        },
        cpu: {
            cores: os.cpus().length,
            model: os.cpus()[0].model,
        },
        memory: {
            total: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            swap: swap.total,
            swapFree: swap.free,
        },
        system: {
            time: new Date().toLocaleString(),
            uptime: formatUptime(os.uptime()),
            load: os
                .loadavg()
                .map((n) => n.toFixed(2))
                .join(' '),
        },
        disk,
        network: os.networkInterfaces(),
        dependencies,
    };
}

/**
 * Get dependency versions via SSH in a parse-friendly way.
 * Each dependency reports its own outcome: installed with version, not
 * installed (command missing), or installed but version probe failed.
 * @returns {Promise<Object>}
 */
async function getSSHDependencies() {
    const deps = getAppDependencies();
    const output = await sshExec(buildDependencyProbe(deps));
    return parseDependencyReport(output, deps);
}

/**
 * Get system info via SSH.
 *
 * Every collection item (OS, CPU, memory, disk, load, system time/uptime,
 * network interfaces, dependency versions) is probed independently. A failing
 * or malformed probe marks only its own item in `collection` with a readable
 * reason; all other items are unaffected and the legacy field structure is
 * preserved ('n/a'/null fallbacks).
 *
 * @returns {Promise<object>}
 */
async function getSystemInfoSSH() {
    return await collectSystemInfo(sshExec, getAppDependencies());
}

/**
 * Get current system information (OS, CPU, memory, uptime, network, dependencies).
 * @returns {Promise<Object>}
 */
async function getSystemInfo() {
    if (APP_MANAGE_MODE === 'ssh') {
        return getSystemInfoSSH();
    }
    return getSystemInfoLocal();
}

module.exports = {
    getSystemInfo,
    getSystemInfoLocal,
    getSSHDependencies,
    formatUptime,
};
