#!/usr/bin/env node

const path = require("node:path");

async function main() {
  const root = process.env.RUNTIME_ROOT || "/runtime";
  const { PrismaClient } = require(path.join(root, "node_modules", "@prisma", "client"));
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe("SELECT 1 AS artifact_probe");
    if (!Array.isArray(rows) || Number(rows[0]?.artifact_probe) !== 1) throw new Error("unexpected disposable PostgreSQL probe result");
    console.log("runtime artifact Prisma client query: PASS");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
