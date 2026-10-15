import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { checkReadiness } from "@/server/health";

describe("readiness", () => {
  it("accepts the migrated application schema", async () => {
    expect(await checkReadiness()).toBe(true);
  });

  it("rejects a reachable database without application migrations", async () => {
    const name = `ready_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${name}`;
      expect(await checkReadiness(url.toString())).toBe(false);
      expect(await checkReadiness()).toBe(true);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("bounds a connection that accepts TCP but never completes the PostgreSQL handshake", async () => {
    const sockets = new Set<Socket>();
    const server = createServer();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    try {
      const started = Date.now();
      expect(await checkReadiness(`postgres://test:test@127.0.0.1:${address.port}/test`)).toBe(false);
      expect(Date.now() - started).toBeLessThan(3_500);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds a schema query blocked by a database lock", async () => {
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN; LOCK TABLE public."user" IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      expect(await checkReadiness()).toBe(false);
      expect(Date.now() - started).toBeLessThan(3_500);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    expect(await checkReadiness()).toBe(true);
  });
});
