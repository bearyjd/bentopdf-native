'use strict';

const fs = require('node:fs');

function readStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(rest[1]) };
  } catch {
    return null;
  }
}

function kbFrom(file, key) {
  try {
    const line = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}:`));
    return line ? Number(line.split(/\s+/)[1]) : 0;
  } catch {
    return 0;
  }
}

function descendants(rootPid) {
  const children = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const info = readStat(entry);
    if (!info) continue;
    if (!children.has(info.ppid)) children.set(info.ppid, []);
    children.get(info.ppid).push(Number(entry));
  }
  const result = [rootPid];
  for (let i = 0; i < result.length; i += 1) result.push(...(children.get(result[i]) || []));
  return result;
}

/** Sum of RSS and PSS (MiB) over the process tree rooted at rootPid. */
function sampleTree(rootPid) {
  let rssKb = 0;
  let pssKb = 0;
  const pids = descendants(rootPid);
  for (const pid of pids) {
    rssKb += kbFrom(`/proc/${pid}/status`, 'VmRSS');
    pssKb += kbFrom(`/proc/${pid}/smaps_rollup`, 'Pss');
  }
  return { rssMiB: rssKb / 1024, pssMiB: pssKb / 1024, processes: pids.length };
}

function startSampler(rootPid, intervalMs = 500) {
  let peak = { rssMiB: 0, pssMiB: 0, processes: 0 };
  const tick = () => {
    const now = sampleTree(rootPid);
    peak = {
      rssMiB: Math.max(peak.rssMiB, now.rssMiB),
      pssMiB: Math.max(peak.pssMiB, now.pssMiB),
      processes: Math.max(peak.processes, now.processes),
    };
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
    tick();
    return {
      peakRssMiB: Math.round(peak.rssMiB),
      peakPssMiB: Math.round(peak.pssMiB),
      maxProcesses: peak.processes,
    };
  };
}

module.exports = { startSampler, sampleTree };
