/**
 * Sanity-checks this repo against the real Union Station convention used by this org's other
 * Node/Rails services (confirmed by inspecting sibling repos — see the `reference_union_station`
 * project note and docs/UNION_STATION_DEPLOYMENT.md): Union Station builds and deploys directly
 * from the repo's Dockerfile (no separate in-repo manifest), injects secrets and config as plain
 * runtime env vars, and polls `GET /health` for liveness.
 *
 * Run with: npm run union-station:validate
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');

function fail(message: string): never {
  console.error(`union-station:validate FAILED: ${message}`);
  process.exit(1);
}

function readFile(relativePath: string): string {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) fail(`${relativePath} does not exist.`);
  return fs.readFileSync(fullPath, 'utf-8');
}

function main(): void {
  const dockerfile = readFile('Dockerfile');
  if (!/union station/i.test(dockerfile)) {
    fail("Dockerfile must document that Union Station builds/deploys from it (see sibling repos' convention).");
  }
  if (!/^EXPOSE\s+\d+/m.test(dockerfile)) {
    fail('Dockerfile must EXPOSE a port for Union Station to route traffic to.');
  }
  if (!/CMD\s*\[/.test(dockerfile)) {
    fail('Dockerfile must define a CMD entrypoint.');
  }

  const healthSource = readFile('src/web/health.ts');
  if (!/router\.get\(\s*['"]\/health['"]/.test(healthSource)) {
    fail("src/web/health.ts must expose GET /health — that's the endpoint Union Station polls for liveness.");
  }

  const envExample = readFile('.env.example');
  if (!/APP_DYNAMODB_TABLE_NAME/.test(envExample) || !/AWS_REGION/.test(envExample)) {
    fail(
      '.env.example must document APP_DYNAMODB_TABLE_NAME and AWS_REGION — Union Station auto-injects both in production.'
    );
  }
  if (!/auto[- ]?inject/i.test(envExample)) {
    fail(
      '.env.example should note that Union Station auto-injects AWS_REGION/APP_DYNAMODB_TABLE_NAME in production, so a developer does not go hunting for where to set them.'
    );
  }

  console.log('union-station:validate OK');
  console.log('  Dockerfile: documents Union Station build/deploy, exposes a port, defines CMD');
  console.log('  src/web/health.ts: GET /health present (Union Station liveness target)');
  console.log('  .env.example: documents AWS_REGION / APP_DYNAMODB_TABLE_NAME as Union-Station-injected');
}

main();
