// Standalone sandbox consumer: npm run consumer  (listens on CONSUMER_PORT, default 4000)
//   CONSUMER_SECRET=whsec_... npm run consumer
import Fastify from "fastify";
import { SandboxConsumer } from "./consumer.js";
import { consumerPlugin } from "./plugin.js";

const consumer = new SandboxConsumer();
consumer.secret = process.env.CONSUMER_SECRET ?? null;
const app = Fastify({ logger: { level: "info" } });
await app.register(consumerPlugin(consumer));
const port = Number(process.env.CONSUMER_PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`sandbox consumer: POST http://localhost:${port}/webhooks  state: GET /state`);
