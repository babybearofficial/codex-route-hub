const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function appServerPids(output, appPid, appPath) {
  const executable = path.join(appPath, 'Contents', 'Resources', 'codex');
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[2]) !== appPid
      || !match[3].startsWith(`${executable} `)
      || !/(?:^|\s)app-server(?:\s|$)/.test(match[3])) return [];
    return [Number(match[1])];
  });
}

async function refreshCodexBackend({ appPath, bundleId, run = execute, signal = process.kill,
  wait = pause, now = Date.now, timeoutMs = 20_000 }) {
  if (process.platform !== 'darwin') return { status: 'unsupported' };
  if (!path.isAbsolute(appPath) || !/^[A-Za-z0-9._-]+$/.test(bundleId)) {
    throw new Error('Codex backend refresh needs an exact app path and bundle ID');
  }
  const script = `ObjC.import('AppKit'); ObjC.import('Foundation');
    const target=${JSON.stringify(appPath)};
    const expected=${JSON.stringify(bundleId)};
    const bundle=$.NSBundle.bundleWithPath(target);
    if(!bundle || ObjC.unwrap(bundle.bundleIdentifier)!==expected) throw new Error('Codex client identity mismatch');
    const apps=$.NSWorkspace.sharedWorkspace.runningApplications; let pid=null;
    for(let i=0;i<apps.count;i++){const a=apps.objectAtIndex(i);
      if(ObjC.unwrap(a.bundleIdentifier)===expected && ObjC.unwrap(a.bundleURL.path)===target){
        pid=Number(a.processIdentifier); break;
      }
    } JSON.stringify(pid);`;
  const inspectApp = async () => {
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script],
      { timeout: 10_000, maxBuffer: 64 * 1024 });
    const pid = JSON.parse(result.stdout.trim());
    if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid Codex client PID');
    return pid;
  };
  const appPid = await inspectApp();
  if (appPid === null) return { status: 'client-not-running' };
  const inspectBackend = async () => {
    const result = await run('/bin/ps', ['-axo', 'pid=,ppid=,command='],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return appServerPids(result.stdout, appPid, appPath);
  };
  const original = await inspectBackend();
  if (original.length === 0) return { status: 'backend-not-running' };
  if (original.length !== 1) throw new Error('More than one matching Codex app-server is running');
  // Confirm the exact child relationship immediately before signaling. The GUI process is
  // never signaled; Electron will spawn a fresh app-server with the restored config.toml.
  if (await inspectApp() !== appPid || !(await inspectBackend()).includes(original[0])) {
    throw new Error('Codex client changed while its backend was being inspected');
  }
  signal(original[0], 'SIGTERM');
  const deadline = now() + timeoutMs;
  do {
    await wait(200);
    if (await inspectApp() !== appPid) throw new Error('Codex client exited during backend refresh');
    const current = await inspectBackend();
    if (!current.includes(original[0]) && current.length === 1) {
      return { status: 'refreshed', previousPid: original[0], pid: current[0], appPid };
    }
    if (current.length > 1) throw new Error('Multiple Codex app-server processes appeared after refresh');
  } while (now() < deadline);
  throw new Error('Codex desktop did not restart its app-server after route restoration');
}

module.exports = { appServerPids, refreshCodexBackend };
