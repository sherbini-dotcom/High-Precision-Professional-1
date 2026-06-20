import { createServer } from "http";
import app from "./app";
import { setupSocketIO } from "./lib/socket";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);
const io = setupSocketIO(httpServer);
app.set("io", io);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening with Socket.IO");
});