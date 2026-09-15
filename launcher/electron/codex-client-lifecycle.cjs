const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CodexClientLifecycle {
  constructor({ appPath = '/Applications/ChatGPT.app', run = execute, pause = sleep, now = Date.now } = {}) {
    if (!path.isAbsolute(appPath)) throw new Error('Codex client application path must be absolute');
    Object.assign(this, { appPath, run, pause, now });
    this.previous = null;
  }

  async inspect(terminate = false) {
    // Match both the user-selected path and the verified Codex bundle identity.
    // NSRunningApplication termination is graceful and never force-kills helpers.
    const script = `ObjC.import('AppKit'); ObjC.import('Foundation');
      const target=${JSON.stringify(this.appPath)};
      const bundle=$.NSBundle.bundleWithPath(target);
      if(!bundle || ObjC.unwrap(bundle.bundleIdentifier)!=='com.openai.codex') throw new Error('Selected application is not the Codex client');
      const apps=$.NSWorkspace.sharedWorkspace.runningApplications; let found=null;
      for(let i=0;i<apps.count;i++){const a=apps.objectAtIndex(i);
        if(ObjC.unwrap(a.bundleIdentifier)==='com.openai.codex' && ObjC.unwrap(a.bundleURL.path)===target){
          found={pid:Number(a.processIdentifier)};
          if(${terminate}) found.accepted=Boolean(a.terminate);
          break;
        }
      } JSON.stringify(found);`;
    const result = await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script],
      { timeout: 10_000, maxBuffer: 64 * 1024 });
    return JSON.parse(result.stdout.trim());
  }

  async stop() {
    const previous = await this.inspect();
    this.previous = previous;
    if (!previous) return;
    const result = await this.inspect(true);
    if (result && result.accepted !== true) throw new Error('Codex declined to quit; finish or save the active task and retry');
    const deadline = this.now() + 30_000;
    while (await this.inspect()) {
      if (this.now() >= deadline) throw new Error('Codex did not finish quitting within 30 seconds; no force termination was attempted');
      await this.pause(400);
    }
  }

  async reopen({ recovery = false } = {}) {
    if (recovery && !this.previous) return;
    // open -g preserves focus. Wait for actual process readback, not just exit 0.
    await this.run('/usr/bin/open', ['-g', '-a', this.appPath], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const deadline = this.now() + 20_000;
    while (!await this.inspect()) {
      if (this.now() >= deadline) throw new Error('Codex launch was requested but its process did not appear');
      await this.pause(400);
    }
    this.previous = null;
  }
}

module.exports = { CodexClientLifecycle };
