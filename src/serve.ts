// `nix64 serve`: the shell's server, in the foreground. The window (`nix64`) starts one if none is running.
import { createHub } from "./server";
import { attachAgent } from "./agent";

const hub = await createHub();
attachAgent(hub);
const server = hub.start();
console.log(`Nix64 shell on http://127.0.0.1:${server.port}/  (loopback only)`);
if (process.env.NIX64_PRINT_URL) console.log(`open: http://127.0.0.1:${server.port}/?t=${hub.token}`);
const bye = () => { hub.stop(); process.exit(0); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
