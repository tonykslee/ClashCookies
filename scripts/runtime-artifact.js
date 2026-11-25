const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const fs = require("node:fs");
const { join, dirname, basename, posix } = require("node:path");

function field(buffer) { return buffer.toString("utf8").replace(/\0+$/, ""); }
function octal(buffer) { const value = field(buffer).trim(); return value ? Number.parseInt(value, 8) : 0; }

function parsePax(buffer) {
  const values = {};
  let offset = 0;
  while (offset < buffer.length) {
    const end = buffer.indexOf(10, offset);
    if (end < 0) throw new Error("malformed PAX metadata");
    const line = buffer.subarray(offset, end).toString("utf8");
    const space = line.indexOf(" ");
    const equals = line.indexOf("=", space + 1);
    if (space < 1 || equals < 0 || Number.parseInt(line.slice(0, space), 10) !== end - offset + 1) throw new Error("malformed PAX metadata");
    values[line.slice(space + 1, equals)] = line.slice(equals + 1);
    offset = end + 1;
  }
  return values;
}

function parseTar(archive) {
  const data = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  let pax = {};
  let globalPax = {};
  let longName;
  let longLink;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const contentOffset = offset + 512;
    const content = data.subarray(contentOffset, contentOffset + size);
    if (content.length !== size) throw new Error("truncated tar entry");
    offset = contentOffset + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      const parsed = parsePax(content);
      if (type === "g") globalPax = { ...globalPax, ...parsed }; else pax = { ...pax, ...parsed };
      continue;
    }
    if (type === "L") { longName = field(content); continue; }
    if (type === "K") { longLink = field(content); continue; }
    const metadata = { ...globalPax, ...pax };
    const prefix = field(header.subarray(345, 500));
    const name = metadata.path || longName || `${prefix}${prefix ? "/" : ""}${field(header.subarray(0, 100))}`;
    const link = metadata.linkpath || longLink || field(header.subarray(157, 257));
    entries.push({ name, link, type, mode: octal(header.subarray(100, 108)), content });
    pax = {};
    longName = undefined;
    longLink = undefined;
  }
  if (offset > data.length) throw new Error("tar extends beyond archive");
  return entries;
}

function safePath(value) {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function safeLink(entryName, link) {
  if (!link || link.includes("\\") || link.startsWith("/") || /^[A-Za-z]:/.test(link)) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(entryName), link));
  return safePath(resolved) && (resolved === "dist" || resolved.startsWith("dist/") || resolved === "node_modules" || resolved.startsWith("node_modules/") || resolved === "prisma" || resolved.startsWith("prisma/"));
}

function validateEntries(entries) {
  if (!entries.length) throw new Error("archive is empty");
  const seen = new Set();
  const symlinks = new Set();
  for (const entry of entries) {
    if (!safePath(entry.name)) throw new Error(`unsafe archive path: ${entry.name}`);
    if (seen.has(entry.name)) throw new Error(`duplicate archive path: ${entry.name}`);
    seen.add(entry.name);
    if (!["0", "\0", "5", "2"].includes(entry.type)) throw new Error(`unsupported archive entry type: ${entry.name}`);
    if (entry.type === "2") {
      if (!safeLink(entry.name, entry.link)) throw new Error(`escaping symlink: ${entry.name} -> ${entry.link}`);
      symlinks.add(entry.name);
    }
    const ancestors = entry.name.split("/").slice(0, -1);
    for (let index = 1; index <= ancestors.length; index += 1) if (symlinks.has(ancestors.slice(0, index).join("/"))) throw new Error(`archive path traverses symlink: ${entry.name}`);
  }
  for (const entry of entries) if (entry.type === "2") {
    const target = posix.normalize(posix.join(posix.dirname(entry.name), entry.link));
    if (!seen.has(target)) throw new Error(`symlink target is not present: ${entry.name} -> ${entry.link}`);
  }
  const required = [
    "dist/ClashCookies.js",
    "node_modules/@prisma/client/default.js",
    "node_modules/.prisma/client/index.js",
    "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node",
    "node_modules/prisma/build/index.js",
    "node_modules/.bin/prisma",
    "prisma/schema.prisma",
    "package.json",
    "runtime-artifact-manifest.json",
  ];
  for (const path of required) if (!seen.has(path)) throw new Error(`missing required runtime file: ${path}`);
  return entries;
}

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function readJson(path, label) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${label} is missing or malformed: ${error.message}`); }
}

function comparable(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  delete copy.artifact.archiveSha256;
  delete copy.artifact.archiveBytes;
  delete copy.integrity.sha256;
  delete copy.measurements.archiveBytes;
  delete copy.measurements.extractedFootprintBytes;
  return JSON.stringify(copy);
}

function validateArchive({ archivePath, checksumPath, manifestPath, expectedSha, expectedPlatform = "linux/amd64" }) {
  const archive = fs.readFileSync(archivePath);
  const digest = sha256(archive);
  const checksum = fs.readFileSync(checksumPath, "utf8").trim().match(/^([0-9a-f]{64})\s+(\S+)$/i);
  if (!checksum || checksum[2] !== basename(archivePath) || checksum[1].toLowerCase() !== digest) throw new Error("archive checksum metadata is missing, malformed, or incorrect");
  const entries = validateEntries(parseTar(archive));
  let embedded;
  try {
    const embeddedEntry = entries.find((entry) => entry.name === "runtime-artifact-manifest.json");
    embedded = JSON.parse(embeddedEntry.content.toString("utf8"));
  } catch (error) { throw new Error(`embedded manifest is missing or malformed: ${error.message}`); }
  const external = readJson(manifestPath, "published manifest");
  if (embedded.schemaVersion !== 1 || external.schemaVersion !== 1) throw new Error("unsupported manifest schema");
  if (!/^[0-9a-f]{40}$/.test(String(external.source?.gitSha || ""))) throw new Error("manifest has no full Git SHA");
  if (expectedSha && external.source.gitSha !== expectedSha.toLowerCase()) throw new Error("manifest Git SHA does not match expected revision");
  if (external.build?.platform !== expectedPlatform || external.build?.architecture !== expectedPlatform.split("/")[1]) throw new Error("manifest platform is incompatible");
  if (external.integrity?.sha256 !== digest) throw new Error("manifest digest does not match archive");
  if (external.artifact?.name !== basename(archivePath)) throw new Error("manifest archive name does not match archive");
  if (external.identity?.deployableRelease !== false || external.artifact?.nonProductionEvidence !== true) throw new Error("artifact is not marked as non-production evidence");
  if (comparable(embedded) !== comparable(external)) throw new Error("published manifest does not match embedded manifest");
  return { archivePath, digest, entries, manifest: external };
}

function validateAndExtract(options) {
  const result = validateArchive(options);
  if (!options.extractPath) return result;
  if (fs.existsSync(options.extractPath)) {
    if (!fs.lstatSync(options.extractPath).isDirectory()) throw new Error("extraction path is not a directory");
    if (fs.readdirSync(options.extractPath).length) throw new Error("extraction path must be empty");
  } else fs.mkdirSync(options.extractPath, { recursive: true });
  for (const entry of result.entries.filter((value) => value.type === "5")) fs.mkdirSync(join(options.extractPath, entry.name), { recursive: true, mode: entry.mode & 0o7777 });
  for (const entry of result.entries.filter((value) => value.type === "0" || value.type === "\0")) {
    const path = join(options.extractPath, entry.name);
    fs.mkdirSync(dirname(path), { recursive: true });
    const fd = fs.openSync(path, "wx", entry.mode & 0o7777);
    try { fs.writeSync(fd, entry.content); } finally { fs.closeSync(fd); }
    fs.chmodSync(path, entry.mode & 0o7777);
  }
  for (const entry of result.entries.filter((value) => value.type === "2")) fs.symlinkSync(entry.link, join(options.extractPath, entry.name));
  return result;
}

module.exports = { parseTar, validateArchive, validateAndExtract, safeLink };
