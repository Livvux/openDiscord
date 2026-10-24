// Isolated hosted-runner acceptance of the UNCHANGED production backup implementation.
// Never upload the work directory: it contains synthetic keys, configuration and private fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Client } from 'pg';

assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.OPENDISCORD_ISOLATED_MEDIA_RECOVERY, '1');
assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
assert.equal(process.platform, 'linux');
assert.equal(process.env.DATABASE_URL, undefined, 'Do not inherit an application database');
for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'ATTACHMENT_DIR']) {
  assert.equal(process.env[name], undefined, `Do not inherit ${name}`);
}
const root = resolve('../..');
assert(existsSync(join(root, 'scripts/production-backup.sh')));
const prefix = `od-recovery-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const image = `opendiscord-media-recovery:${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
// Official image, verified against Docker Registry v2; upstream 4.37 README documents mini/S3 env.
const s3Image = 'chrislusf/seaweedfs:4.37@sha256:f898c91e42d7da5f4bb13f1efd424ff03ba85b420312eb929708a384e8a8b03d';
const work = mkdtempSync(join(tmpdir(), `${prefix}-`));
chmodSync(work, 0o700);
const owned = new Map();
const createdPaths = [];
const fixtureFiles = new Map();
const paths = ['/etc/opendiscord-backup', '/var/backups/opendiscord', '/var/lib/opendiscord-backup', '/var/cache/opendiscord-restic', '/etc/dokploy/traefik/dynamic', '/etc/nftables.d'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (file, args, options = {}) => execFileSync(file, args, {
  timeout: 90_000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
const docker = (...args) => run('docker', args).toString().trim();
const containers = [];
let browser;
const secret = randomBytes(32).toString('hex');
const access = randomBytes(12).toString('hex');
const password = randomBytes(24).toString('hex');
const sourceDB = `${prefix}-db`;
const sourceWeb = `${prefix}-web`;
const targetDB = `${prefix}-restored-db`;
const targetWeb = `${prefix}-restored-web`;
const store = `${prefix}-s3`;
const base = 'http://localhost:3200';
const targetBase = 'http://localhost:3201';
const s3 = 'http://127.0.0.1:8333';
const sourceBucket = 'fixture-source';
const targetBucket = 'fixture-restored';
const backupBucket = 'opendiscord-backups-private';
const envFile = join(work, 'web.env');
const s3EnvFile = join(work, 's3.env');
const s3Config = join(work, 's3.json');
const readOnlyConfig = join(work, 'read-only-rclone.conf');
const readOnlyAccess = randomBytes(12).toString('hex');
const readOnlySecret = randomBytes(32).toString('hex');
const appDir = join(work, 'app');
const voiceDir = join(work, 'voice');
const localConfig = join(work, 'rclone.conf');
const fixture = Buffer.from('Private operational recovery fixture\n' + randomUUID() + '\n');
// Incompressible like E2EE DM ciphertext: three 20 MiB random files beside the readable proof.
const bulk = [1, 2, 3].map(() => randomBytes(20 * 1024 * 1024));
const attachmentBytes = fixture.length + bulk.reduce((total, file) => total + file.length, 0);
const repository = `rclone:opendiscord-backup:${'opendiscord-backups-private'}/restic`;
const account = `${prefix}@example.test`;
const outsider = `${prefix}-outsider@example.test`;
const accountPassword = `Recovery-${randomBytes(16).toString('hex')}`;
let report;
let failed = false;
let cleanupFailed = false;
let phase = 'guards';

function start(name, args) {
  assert(name.startsWith(`${prefix}-`));
  const id = docker('run', '-d', '--name', name, '--label', `opendiscord.recovery=${prefix}`, ...args);
  assert.match(id, /^[a-f0-9]{64}$/);
  owned.set(name, id);
  containers.push(name);
  return id;
}
function container(name) {
  const id = owned.get(name);
  assert(id, 'Unowned Docker resource');
  assert.equal(docker('inspect', '-f', '{{index .Config.Labels "opendiscord.recovery"}}', id), prefix);
  return id;
}
async function waitFor(url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Owned service did not become ready');
}
async function dbReady(port) {
  for (let i = 0; i < 60; i++) {
    const client = new Client({ host: '127.0.0.1', port, user: 'opendiscord', password, database: 'opendiscord', connectionTimeoutMillis: 1000 });
    try { await client.connect(); await client.end(); return; } catch { await client.end().catch(() => {}); }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Owned database not ready');
}
function webEnv(port, bucket) {
  return `DATABASE_URL=postgres://opendiscord:${password}@127.0.0.1:${port}/opendiscord\nBETTER_AUTH_SECRET=${secret}\nBETTER_AUTH_URL=${port === 5432 ? base : targetBase}\nR2_ENDPOINT=${s3}\nR2_BUCKET=${bucket}\nR2_ACCESS_KEY_ID=${access}\nR2_SECRET_ACCESS_KEY=${secret}\nTURNSTILE_SITE_KEY=1x00000000000000000000AA\nTURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA\n`;
}
function rclone(...args) { return run('rclone', ['--config', localConfig, ...args]); }
function restore(name, bytes) {
  return run('docker', ['exec', '-i', container(name), 'pg_restore', '-U', 'opendiscord', '-d', 'opendiscord', '--no-owner', '--exit-on-error'], { input: bytes });
}
async function snapshot(port) {
  const client = new Client({ host: '127.0.0.1', port, user: 'opendiscord', password, database: 'opendiscord' });
  await client.connect();
  try {
    const { rows: tables } = await client.query("select schemaname,tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1,2");
    const result = [];
    for (const { schemaname, tablename } of tables) {
      const quote = (v) => `"${v.replaceAll('"', '""')}"`;
      const { rows } = await client.query(`select count(*)::text as count, md5(coalesce(string_agg(value::text, E'\\n' order by value::text),'')) as digest from (select to_jsonb(t) as value from ${quote(schemaname)}.${quote(tablename)} t) data`);
      result.push({ schemaname, tablename, ...rows[0] });
    }
    return result;
  } finally { await client.end(); }
}
async function newPage(url) {
  const context = await browser.newContext({ baseURL: url });
  const page = await context.newPage();
  page.on('pageerror', () => { throw new Error('Recovery browser runtime error'); });
  return page;
}
async function signup(page, email, name) {
  await page.goto('/sign-up');
  const form = page.locator('form:visible');
  await form.getByLabel('Display name').fill(name);
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(accountPassword);
  await form.getByRole('checkbox', { name: /I am at least/ }).check();
  await form.locator('[name="cf-turnstile-response"]').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !!document.querySelector('[name="cf-turnstile-response"]')?.value);
  const response = page.waitForResponse((r) => r.url().endsWith('/api/auth/sign-up/email') && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Create account' }).click();
  assert.equal((await response).status(), 200);
  await page.waitForURL('**/app');
}
async function signin(page, email) {
  await page.goto('/sign-in');
  const form = page.locator('form:visible');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password', { exact: true }).fill(accountPassword);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/app');
}
function fixtureFile(path, value) {
  assert(paths.some((directory) => path.startsWith(`${directory}/`)));
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
  fixtureFiles.set(path, hash(readFileSync(path)));
}
function restic(...args) {
  return run('restic', args, { env: { ...process.env, RESTIC_REPOSITORY: repository, RESTIC_PASSWORD_FILE: '/etc/opendiscord-backup/restic-password', RCLONE_CONFIG: '/etc/opendiscord-backup/rclone.conf', RESTIC_CACHE_DIR: join(work, 'restic-cache') }, timeout: 300_000 });
}
const repositoryBytes = () => JSON.parse(restic('stats', '--mode', 'raw-data', '--json').toString()).total_size;
const snapshots = () => JSON.parse(restic('snapshots', '--json').toString()).map(({ id }) => id).sort();
function backup() {
  return run('bash', [join(root, 'scripts/production-backup.sh')], { timeout: 600_000, env: {
    ...process.env, OPENDISCORD_DB_CONTAINER: container(sourceDB), OPENDISCORD_WEB_CONTAINER: container(sourceWeb),
    OPENDISCORD_COMPOSE_DIR: appDir, OPENDISCORD_VOICE_COMPOSE_DIR: voiceDir,
  } });
}
try {
  // Refuse all pre-existing operator paths; never overwrite a host's actual installation.
  for (const path of paths) assert(!existsSync(path), 'Operator fixture path already exists');
  for (const path of paths) {
    run('sudo', ['mkdir', '-p', path]);
    createdPaths.push(path);
    run('sudo', ['chown', String(process.getuid()), path]);
    chmodSync(path, 0o700);
    fixtureFile(join(path, '.recovery-owner'), prefix);
  }
  mkdirSync(appDir); mkdirSync(voiceDir);
  writeFileSync(envFile, webEnv(5432, sourceBucket), { mode: 0o600 });
  writeFileSync(s3EnvFile, `AWS_ACCESS_KEY_ID=${access}\nAWS_SECRET_ACCESS_KEY=${secret}\nS3_BUCKET=${sourceBucket},${targetBucket},${backupBucket}\n`, { mode: 0o600 });
  writeFileSync(localConfig, `[fixture]\ntype = s3\nprovider = Other\naccess_key_id = ${access}\nsecret_access_key = ${secret}\nendpoint = ${s3}\nno_check_bucket = true\nforce_path_style = true\n`, { mode: 0o600 });
  // The image drops to its seaweed user; the bind-mounted file must be readable by that UID.
  // Its host parent remains 0700, keeping these disposable credentials private on the runner.
  writeFileSync(s3Config, JSON.stringify({ identities: [
    { name: 'backup-writer', credentials: [{ accessKey: access, secretKey: secret }], actions: ['Admin', 'Read', 'List', 'Write', 'Tagging'] },
    { name: 'recovery-reader', credentials: [{ accessKey: readOnlyAccess, secretKey: readOnlySecret }], actions: [`Read:${backupBucket}`, `List:${backupBucket}`] },
  ] }), { mode: 0o644 });
  writeFileSync(readOnlyConfig, readFileSync(localConfig, 'utf8').replace('[fixture]', '[opendiscord-backup]').replace(access, readOnlyAccess).replace(secret, readOnlySecret), { mode: 0o600 });
  fixtureFile('/etc/opendiscord-backup/rclone.conf', readFileSync(localConfig).toString().replace('[fixture]', '[opendiscord-backup]'));
  fixtureFile('/etc/opendiscord-backup/restic-password', randomBytes(32).toString('hex'));
  // Synthetic recovery configuration, including optional router files. Never sourced or executed.
  for (const [path, value] of [
    [join(appDir, '.env'), readFileSync(envFile)], [join(appDir, 'docker-compose.dokploy.yml'), 'services: {}\n'],
    [join(voiceDir, '.env'), 'SYNTHETIC_RECOVERY_FIXTURE=1\n'], [join(voiceDir, 'docker-compose.yml'), 'services: {}\n'],
    ['/etc/dokploy/traefik/dynamic/opendiscord.yml', 'http: {}\n'], ['/etc/dokploy/traefik/dynamic/opendiscord-turn.yml', 'tcp: {}\n'],
    ['/etc/nftables.d/dokploy-public-ingress.nft', '# synthetic recovery fixture\n'],
  ]) {
    if (paths.some((directory) => path.startsWith(`${directory}/`))) fixtureFile(path, value);
    else writeFileSync(path, value, { mode: 0o600 });
  }
  phase = 'services-s3';
  start(store, ['--network', 'host', '--memory', '768m', '--cpus', '1', '--env-file', s3EnvFile, '-v', `${s3Config}:/etc/fixture-s3.json:ro`, s3Image, 'mini', '-dir=/data', '-s3.config=/etc/fixture-s3.json']);
  await waitFor(s3);
  phase = 'services-db';
  const dbArgs = (port) => ['--memory', '512m', '--cpus', '1', '-p', `127.0.0.1:${port}:5432`, '-e', 'POSTGRES_USER=opendiscord', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=opendiscord', 'postgres:18-alpine'];
  start(sourceDB, dbArgs(5432)); start(targetDB, dbArgs(5433));
  await dbReady(5432); await dbReady(5433);
  run('pnpm', ['db:migrate'], { cwd: root, env: { ...process.env, DATABASE_URL: `postgres://opendiscord:${password}@127.0.0.1:5432/opendiscord` } });
  phase = 'services-web';
  start(sourceWeb, ['--network', 'host', '--memory', '768m', '--cpus', '1', '--env-file', envFile, '-e', 'PORT=3200', image]);
  await waitFor(`${base}/sign-in`);
  phase = 'source-browser';
  browser = await chromium.launch();
  const ownerPage = await newPage(base);
  await signup(ownerPage, account, 'Recovery Owner');
  await ownerPage.getByRole('button', { name: 'Create a community' }).first().click();
  await ownerPage.getByLabel('Name', { exact: true }).fill('Private Recovery Fixture');
  await ownerPage.getByRole('button', { name: 'Create', exact: true }).click();
  await ownerPage.getByRole('heading', { level: 1, name: 'general' }).waitFor();
  writeFileSync(join(work, 'recovery-proof.bin'), fixture, { mode: 0o600 });
  const chooser = ownerPage.waitForEvent('filechooser');
  await ownerPage.getByRole('button', { name: /Attach files/ }).click();
  // Playwright caps in-memory file buffers at 50 MB, so the large files go through private paths.
  const bulkPaths = bulk.map((buffer, i) => { const path = join(work, `ciphertext-${i}.bin`); writeFileSync(path, buffer, { mode: 0o600 }); return path; });
  await (await chooser).setFiles([join(work, 'recovery-proof.bin'), ...bulkPaths]);
  await ownerPage.waitForFunction(() => document.querySelector('[aria-label="Attachments"]')?.querySelectorAll('[role="status"]').length === 0);
  await ownerPage.getByRole('button', { name: 'Send message' }).click();
  const link = ownerPage.getByRole('log').getByRole('link', { name: /recovery-proof\.bin/ });
  await link.waitFor();
  const attachmentURL = await link.getAttribute('href');
  assert.match(attachmentURL, /^\/api\/attachments\/[0-9a-f-]{36}$/);
  const outsiderPage = await newPage(base);
  await signup(outsiderPage, outsider, 'Recovery Outsider');
  assert.equal((await outsiderPage.request.get(attachmentURL)).status(), 404);
  await browser.close(); browser = undefined;
  phase = 'frozen-source';
  docker('stop', container(sourceWeb));
  const sourceSnapshot = await snapshot(5432);
  const client = new Client({ host: '127.0.0.1', port: 5432, user: 'opendiscord', password, database: 'opendiscord' });
  await client.connect();
  const { rows: refs } = await client.query('select key,size from attachment order by key');
  await client.end();
  assert.equal(refs.length, 4);
  assert.equal(refs.reduce((total, ref) => total + ref.size, 0), attachmentBytes);
  const proof = refs.find((ref) => ref.size === fixture.length);
  assert.equal(hash(rclone('cat', `fixture:${sourceBucket}/${proof.key}`)), hash(fixture));
  const sourceHashes = Object.fromEntries(refs.map(({ key }) => [key, hash(rclone('cat', `fixture:${sourceBucket}/${key}`))]));
  phase = 'operational-backup';
  restic('init');
  backup();
  const lastSuccess = readFileSync('/var/backups/opendiscord/last-success');
  const [, snapshotRef, firstBytes, dumpHash] = lastSuccess.toString().trim().split(' ');
  assert.match(snapshotRef, /^restic:[0-9a-f]{8}$/);
  const snapshotId = snapshotRef.slice('restic:'.length);
  // Random media does not compress: the repository really holds the incompressible bytes.
  assert(Number(firstBytes) >= attachmentBytes, 'Repository is smaller than the incompressible media');
  phase = 'incremental-backup';
  const obsoleteMirrorFile = '/var/lib/opendiscord-backup/media/attachments/obsolete-fixture.bin';
  writeFileSync(obsoleteMirrorFile, bulk[0]);
  backup();
  assert(!existsSync(obsoleteMirrorFile), 'Obsolete mirror bytes survived synchronization');
  const secondBytes = repositoryBytes();
  // Unchanged media is deduplicated: a second daily snapshot adds at most a little metadata and dump.
  assert(secondBytes - Number(firstBytes) < 2 * 1024 * 1024, 'Unchanged media was stored again');
  assert.equal(snapshots().length, 2);
  phase = 'snapshot-validation';
  const extracted = join(work, 'extracted'); mkdirSync(extracted, { mode: 0o700 });
  // Recovery credentials can list/read this bucket but cannot create even a lock object.
  assert.throws(() => run('rclone', ['--config', readOnlyConfig, '--retries', '1', '--low-level-retries', '1', 'rcat', `opendiscord-backup:${backupBucket}/restic/locks/read-only-probe`], { input: Buffer.from('denied') }));
  run('restic', ['--no-lock', 'restore', snapshotId, '--target', extracted], { env: { ...process.env, RESTIC_REPOSITORY: repository, RESTIC_PASSWORD_FILE: '/etc/opendiscord-backup/restic-password', RCLONE_CONFIG: readOnlyConfig, RESTIC_CACHE_DIR: join(work, 'read-only-cache') }, timeout: 300_000 });
  const staged = join(extracted, 'dev/shm/opendiscord-backup');
  const mirrored = join(extracted, 'var/lib/opendiscord-backup/media');
  assert.equal(hash(readFileSync(join(staged, 'database.dump'))), dumpHash);
  assert.equal(readFileSync(join(staged, 'manifest.txt'), 'utf8'), 'format=opendiscord-recovery-v2\nattachment_references=4\ndm_ciphertext_bytes=0\n');
  for (const name of ['app.env', 'app-compose.yml', 'voice.env', 'voice-compose.yml', 'traefik.yml', 'traefik-turn.yml', 'firewall.nft']) {
    assert(existsSync(join(staged, 'config', name)), `Recovery configuration ${name} missing`);
  }
  assert.deepEqual(readFileSync(join(staged, 'config/app.env')), readFileSync(envFile));
  for (const { key } of refs) assert.equal(hash(readFileSync(join(mirrored, key))), sourceHashes[key]);
  // Every budget is recorded for the operator monitor's early capacity warning.
  const { metrics } = JSON.parse(readFileSync('/var/backups/opendiscord/capacity.json', 'utf8'));
  assert.deepEqual(Object.keys(metrics).sort(), ['database', 'dm_ciphertext', 'media', 'repository']);
  assert.equal(metrics.media.bytes, attachmentBytes); assert.equal(metrics.dm_ciphertext.bytes, 0);
  assert.equal(metrics.repository.bytes, secondBytes);
  phase = 'restoration';
  restore(targetDB, readFileSync(join(staged, 'database.dump')));
  assert.deepEqual(await snapshot(5433), sourceSnapshot);
  rclone('copy', mirrored, `fixture:${targetBucket}`, '--quiet');
  for (const { key } of refs) assert.equal(hash(rclone('cat', `fixture:${targetBucket}/${key}`)), sourceHashes[key]);
  // Missing referenced bytes must fail before the snapshot and must preserve last-success.
  phase = 'missing-reference';
  const beforeSnapshots = snapshots();
  const beforeLastSuccess = readFileSync('/var/backups/opendiscord/last-success');
  rclone('deletefile', `fixture:${sourceBucket}/${proof.key}`);
  let failure;
  try { backup(); } catch (error) { failure = error; }
  phase = 'missing-reference-exit';
  assert(failure, 'Missing referenced object was accepted');
  phase = 'missing-reference-reason';
  const rejection = failure.stderr?.toString().includes('Referenced attachment missing from backup')
    ? 'missing-reference' : 'other-backup-rejection';
  console.log(`Negative backup rejection category: ${rejection}; status: ${Number.isInteger(failure.status) ? failure.status : 'unknown'}`);
  assert(failure.stderr.toString().includes('Referenced attachment missing from backup'));
  phase = 'missing-reference-last-success';
  assert.deepEqual(readFileSync('/var/backups/opendiscord/last-success'), beforeLastSuccess);
  phase = 'missing-reference-snapshots';
  assert.deepEqual(snapshots(), beforeSnapshots);
  // Tampered ciphertext must be detected by the integrity check, then the original bytes are put back.
  phase = 'tamper-detection';
  const pack = JSON.parse(rclone('lsjson', `fixture:${backupBucket}/restic/data`, '--recursive', '--files-only').toString())
    .sort((a, b) => b.Size - a.Size)[0];
  const packPath = `fixture:${backupBucket}/restic/data/${pack.Path}`;
  const original = rclone('cat', packPath);
  const damaged = Buffer.from(original); damaged[Math.floor(damaged.length / 2)] ^= 1;
  const damagedFile = join(work, 'damaged-pack'); writeFileSync(damagedFile, damaged, { mode: 0o600 });
  rclone('copyto', damagedFile, packPath, '--quiet');
  assert.throws(() => restic('check', '--read-data'));
  writeFileSync(damagedFile, original, { mode: 0o600 });
  rclone('copyto', damagedFile, packPath, '--quiet');
  restic('check', '--read-data');
  phase = 'restored-browser';
  const targetEnv = join(work, 'target.env');
  writeFileSync(targetEnv, webEnv(5433, targetBucket), { mode: 0o600 });
  start(targetWeb, ['--network', 'host', '--memory', '768m', '--cpus', '1', '--env-file', targetEnv, '-e', 'PORT=3201', image]);
  await waitFor(`${targetBase}/sign-in`);
  browser = await chromium.launch();
  const recovered = await newPage(targetBase);
  await signin(recovered, account);
  const download = await recovered.request.get(attachmentURL);
  assert.equal(download.status(), 200);
  assert.equal(hash(await download.body()), hash(fixture));
  // The large incompressible files are readable through the restored app, too.
  phase = 'restored-browser-large-files';
  const bulkURLs = await (async () => {
    await recovered.goto('/app');
    await recovered.getByRole('link', { name: 'Private Recovery Fixture' }).first().click();
    const links = recovered.getByRole('log').getByRole('link', { name: /ciphertext-\d\.bin/ });
    await links.first().waitFor();
    return links.evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
  })();
  assert.equal(bulkURLs.length, 3);
  const bulkHashes = new Set(bulk.map(hash));
  for (const url of bulkURLs) {
    const response = await recovered.request.get(url);
    assert.equal(response.status(), 200);
    assert(bulkHashes.delete(hash(await response.body())), 'Restored large attachment differs');
  }
  assert.match(download.headers()['content-disposition'], /^attachment;/);
  assert.match(download.headers()['cache-control'], /^private/);
  phase = 'restored-browser-authorization';
  const denied = await newPage(targetBase);
  await signin(denied, outsider);
  assert.equal((await denied.request.get(attachmentURL)).status(), 404);
  const anonymous = await newPage(targetBase);
  assert.equal((await anonymous.request.get(attachmentURL)).status(), 401);
  assert.equal((await fetch(`${s3}/${targetBucket}/${proof.key}`)).status, 403);
  report = { format: 'opendiscord-recovery-v1', fixtureOnly: true, productionDataRestore: false,
    sourceFrozen: true, attachmentReferences: refs.length, attachmentBytes, incompressibleBytes: attachmentBytes - fixture.length,
    fixtureSha256: hash(fixture), tablesCompared: sourceSnapshot.length, resticSnapshot: snapshotId,
    repositoryBytesAfterFirst: Number(firstBytes), repositoryBytesAfterUnchangedSecond: secondBytes,
    exactOperationalScript: true, separateDatabaseAndBucket: true, memberDownload: 200, largeDownloadsVerified: 3, outsiderDownload: 404,
    anonymousDownload: 401, anonymousObject: 403, tamperedPackRejected: true, missingReferenceRejected: true,
    failurePreservedSnapshotsAndLastSuccess: true, readOnlyRestore: true, readOnlyWriteDenied: true, s3Image };
} catch (error) {
  failed = true;
  // Child errors can include env arguments, response bodies or config. Never print them.
  const category = error.name === 'AssertionError' ? 'assertion' : 'runtime';
  console.error(`Media recovery acceptance failed in ${phase} (${category}); sensitive diagnostics suppressed.`);
} finally {
  // Finish every independent owned cleanup; cleanup errors cannot hide the original failure.
  const clean = async (category, action) => {
    try { await action(); } catch {
      cleanupFailed = true;
      console.error(`Owned cleanup failed (${category}); sensitive diagnostics suppressed.`);
    }
  };
  await clean('browser', async () => { await browser?.close(); });
  for (const name of containers.reverse()) await clean('container', () => docker('rm', '-f', '-v', container(name)));
  for (const path of createdPaths.reverse()) await clean('operator-fixture', () => {
    assert.equal(readFileSync(join(path, '.recovery-owner'), 'utf8'), prefix);
    for (const [file, digest] of fixtureFiles) {
      if (file.startsWith(`${path}/`)) {
        assert.equal(hash(readFileSync(file)), digest);
        rmSync(file);
      }
    }
    // These mutable outputs are generated only by our unchanged backup invocation.
    if (path === '/var/backups/opendiscord') {
      for (const name of ['backup.lock', 'last-success', 'capacity.json', 'capacity.tmp']) {
        const file = join(path, name);
        if (existsSync(file)) rmSync(file);
      }
    }
    // The mirror and restic cache are generated only by our backup invocations.
    if (path === '/var/lib/opendiscord-backup' || path === '/var/cache/opendiscord-restic') {
      for (const name of readdirSync(path)) if (name !== '.recovery-owner') rmSync(join(path, name), { recursive: true, force: true });
    }
    // Only unlink our now-empty, preflight-absent directory; foreign contents fail closed.
    run('sudo', ['rmdir', '--', path]);
  });
  await clean('temporary-files', () => rmSync(work, { recursive: true, force: true }));
}
if (failed || cleanupFailed) throw new Error('Media recovery acceptance or owned cleanup failed; see safe phase/category diagnostics');
assert(report);
report.cleanupCompleted = true;
writeFileSync('media-recovery-summary.json', JSON.stringify(report, null, 2) + '\n');
console.log('Exact operational restic snapshots restored; incremental dedup, incompressible bytes, table digests, authorization, tamper and failure rejection verified; owned resources removed.');
