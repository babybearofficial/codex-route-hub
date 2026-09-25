const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { refreshCodexBackend } = require('./codex-backend-refresh.cjs');
const { desktopLaunch } = require('./desktop-launch.cjs');

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CodexClientLifecycle {
  constructor({ appPath = '/Applications/ChatGPT.app', bundleId = 'com.openai.codex',
    multicodexRoot = null, codexHome, clientUserData,
    run = execute, pause = sleep, now = Date.now } = {}) {
    if (!path.isAbsolute(appPath)) throw new Error('Codex client application path must be absolute');
    if (typeof bundleId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(bundleId)) {
      throw new Error('Codex client bundle ID is invalid');
    }
    if (multicodexRoot !== null && !path.isAbsolute(multicodexRoot)) {
      throw new Error('MultiCodex profile root must be absolute');
    }
    Object.assign(this, { appPath, bundleId, multicodexRoot, codexHome, clientUserData, run, pause, now });
    this.previous = null;
  }

  async inspect(terminate = false) {
    // Match both the user-selected path and the verified Codex bundle identity.
    // NSRunningApplication termination is graceful and never force-kills helpers.
    const script = `ObjC.import('AppKit'); ObjC.import('Foundation');
      const target=${JSON.stringify(this.appPath)};
      const expectedBundleId=${JSON.stringify(this.bundleId)};
      const bundle=$.NSBundle.bundleWithPath(target);
      if(!bundle || ObjC.unwrap(bundle.bundleIdentifier)!==expectedBundleId) throw new Error('Selected application is not the expected Codex client');
      const apps=$.NSWorkspace.sharedWorkspace.runningApplications; let found=null;
      for(let i=0;i<apps.count;i++){const a=apps.objectAtIndex(i);
        if(ObjC.unwrap(a.bundleIdentifier)===expectedBundleId && ObjC.unwrap(a.bundleURL.path)===target){
          found={pid:Number(a.processIdentifier)};
          if(${terminate}) found.accepted=Boolean(a.terminate);
          break;
        }
      } JSON.stringify(found);`;
    const result = await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script],
      { timeout: 10_000, maxBuffer: 64 * 1024 });
    return JSON.parse(result.stdout.trim());
  }

  async running() {
    return Boolean(await this.inspect());
  }

  async refreshBackend() {
    return refreshCodexBackend({ appPath: this.appPath, bundleId: this.bundleId,
      run: this.run, wait: this.pause, now: this.now });
  }

  // Resolves to { wasRunning } once the exact client is gone. A declined quit or a quit that
  // does not finish within the bounded wait throws before any configuration is touched.
  async stop() {
    const previous = await this.inspect();
    this.previous = previous;
    if (!previous) return { wasRunning: false };
    const result = await this.inspect(true);
    if (result && result.accepted !== true) throw new Error('Codex declined to quit; finish or save the active task and retry');
    const deadline = this.now() + 30_000;
    while (await this.inspect()) {
      if (this.now() >= deadline) throw new Error('Codex did not finish quitting within 30 seconds; no force termination was attempted');
      await this.pause(400);
    }
    return { wasRunning: true };
  }

  // `recovery` (alias `ifPrevious`) reopens only a client that this lifecycle stopped, so a
  // restore path never launches Codex for a user who did not have it open.
  async reopen({ recovery = false, ifPrevious = recovery } = {}) {
    if (ifPrevious && !this.previous) return { reopened: false };
    // open -g preserves focus. Wait for actual process readback, not just exit 0.
    const launch = desktopLaunch(this);
    await this.run('/usr/bin/open', launch.args,
      { env: launch.env, timeout: 15_000, maxBuffer: 64 * 1024 });
    const deadline = this.now() + 20_000;
    while (!await this.inspect()) {
      if (this.now() >= deadline) throw new Error('Codex launch was requested but its process did not appear');
      await this.pause(400);
    }
    this.previous = null;
    return { reopened: true };
  }
}

module.exports = { CodexClientLifecycle };
