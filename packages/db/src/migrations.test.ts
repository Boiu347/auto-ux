import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const initialMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260730010723_init/migration.sql"),
  "utf8"
);
const temporaryDatabases = new Set<string>();

function databaseName(label: string): string {
  return `control_plane_${label}_${process.pid}_${Date.now()}`;
}

function databaseUrl(name: string): string {
  return `postgresql://control_plane:control_plane@localhost:5432/${name}?schema=public`;
}

function psql(database: string, sql: string): string {
  return execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "control_plane",
      "-d",
      database,
      "--tuples-only",
      "--no-align"
    ],
    { cwd: repositoryRoot, input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
}

function prisma(args: string[], url: string): string {
  return execFileSync("pnpm", ["--filter", "@app/db", "exec", "prisma", ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function createDatabase(label: string): string {
  const name = databaseName(label);
  psql("postgres", `CREATE DATABASE "${name}";`);
  temporaryDatabases.add(name);
  return name;
}

afterEach(() => {
  for (const name of temporaryDatabases) {
    psql("postgres", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
    temporaryDatabases.delete(name);
  }
});

describe.sequential("database migrations", () => {
  it(
    "deploys zero-to-head and matches the Prisma datamodel",
    () => {
      const name = createDatabase("clean");
      const url = databaseUrl(name);

      prisma(["migrate", "deploy"], url);

      expect(() =>
        prisma(
          [
            "migrate",
            "diff",
            "--from-url",
            url,
            "--to-schema-datamodel",
            "prisma/schema.prisma",
            "--exit-code"
          ],
          url
        )
      ).not.toThrow();
    },
    120_000
  );

  it(
    "migrates a legacy null-execution audit event without losing its membership",
    () => {
      const name = createDatabase("legacy");
      const url = databaseUrl(name);
      psql(name, initialMigration);
      prisma(["migrate", "resolve", "--applied", "20260730010723_init"], url);
      psql(
        name,
        `
          INSERT INTO "User" ("id") VALUES ('legacy-user');
          INSERT INTO "Workspace" ("id") VALUES ('legacy-workspace');
          INSERT INTO "AuditEvent" ("id", "workspaceId", "actorUserId", "executionId", "action", "facts")
          VALUES ('legacy-audit', 'legacy-workspace', 'legacy-user', NULL, 'configure', '{}'::jsonb);
        `
      );

      prisma(["migrate", "deploy"], url);

      expect(
        psql(
          name,
          `
            SELECT
              "action"::text,
              "facts"::text,
              (SELECT count(*) FROM "WorkspaceMember" WHERE "userId" = 'legacy-user' AND "workspaceId" = 'legacy-workspace')
            FROM "AuditEvent"
            WHERE "id" = 'legacy-audit';
          `
        ).trim()
      ).toBe("configure|{}|1");
    },
    120_000
  );

  it(
    "creates durable Mac pairing, task lease, and confirmation decision storage",
    () => {
      const name = createDatabase("mac_pairing");
      const url = databaseUrl(name);

      prisma(["migrate", "deploy"], url);

      expect(
        psql(
          name,
          `
            SELECT
              to_regclass('public."DevicePairing"') IS NOT NULL,
              to_regclass('public."DeviceTask"') IS NOT NULL,
              to_regclass('public."ConfirmationDecision"') IS NOT NULL;
          `
        ).trim()
      ).toBe("t|t|t");
    },
    120_000
  );
});
