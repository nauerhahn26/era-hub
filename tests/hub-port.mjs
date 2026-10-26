// hub-port.mjs — stop the hub that holds a suite's own fixed port, by pid.
//
// presence, update and update-boot used to clear their ports with
// `pkill -f "server[.]js <port>"`, which signals every process whose command
// line says so: another session's hub, a gate's, one inside the isolated
// runner's namespace, or something that merely names the port. House law is
// to kill only a pid you started or have verified. stopHubOnPort finds the pid
// that owns the LISTEN socket on <port> in this network namespace
// (/proc/net/tcp and tcp6, then each process's fd links), checks that its
// command line is `node ... server.js <port>`, and only then signals that pid;
// it repeats until nothing listens (a hub that restarts itself hands the port
// to a fresh pid). Nothing listening: nothing to do. Anything else listening:
// refused with what it is, never killed. Linux only, like the suites that use it.
import fs from "node:fs";
import path from "node:path";

function listeningInodes(port) {
  const inodes = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try { text = fs.readFileSync(table, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== "0A") continue;                 // 0A = LISTEN
      if (parseInt(f[1].split(":").pop(), 16) === port) inodes.add(`socket:[${f[9]}]`);
    }
  }
  return inodes;
}

function ownerOf(inodes) {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }   // gone, or not ours to read
    for (const fd of fds) {
      try { if (inodes.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) return Number(pid); } catch {}
    }
  }
  return null;
}

export function commandLine(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { return []; }
}

// The pid listening on <port>, or null when nothing (this user can see) does.
export function listenerPid(port) {
  const inodes = listeningInodes(port);
  return inodes.size ? ownerOf(inodes) : null;
}

// Stop the hub on <port>; resolves with the pids it signalled ([] when the
// port was already free).
export async function stopHubOnPort(port, { waitMs = 5000 } = {}) {
  const stopped = [], deadline = Date.now() + waitMs;
  for (;;) {
    const inodes = listeningInodes(port);
    if (!inodes.size) return stopped;
    const pid = ownerOf(inodes);
    const args = pid === null || stopped.includes(pid) ? [] : commandLine(pid);
    // an exiting process has already lost its command line but not yet its
    // socket: it is on its way out, so wait for the port rather than judge it
    if (args.length) {
      const isHub = args.some((a) => path.basename(a) === "server.js") && args.includes(String(port));
      if (!isHub) {
        throw new Error(`port ${port} is held by pid ${pid} (${args.join(" ")}), ` +
          "not a hub on that port; refusing to stop it");
      }
      try { process.kill(pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      stopped.push(pid);
    }
    if (Date.now() > deadline) {
      throw new Error(`port ${port} still has a listener after ${waitMs} ms` +
        (pid === null ? " (owned by no process this user can inspect)" : ` (pid ${pid})`));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
