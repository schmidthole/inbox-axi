import { serveInbox } from "../src/inbox_axi/adapters/claude.mjs";

// exercise only the experimental protocol transport, not native session fencing.
await serveInbox({ experimentalChannel: true });
