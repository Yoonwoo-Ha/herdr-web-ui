/**
 * The only way into the core from outside server/core (ownership.test.ts): createCore, and the data of
 * the WebSocket a request is upgraded to. Its modules hand each other the objects they own by reference;
 * code outside that reached one directly could hold or change state where its owner does not look.
 */
export { connectionData, type SocketData } from "./connections.ts";
export { createCore } from "./server-core.ts";
