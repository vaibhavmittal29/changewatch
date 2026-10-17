import { spawnSync } from 'node:child_process';

interface Step {
  name: string;
  command: string;
  args: string[];
}

process.env.ALLOW_LOCAL_DEMO = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.APP_SECRET = process.env.APP_SECRET || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const steps: Step[] = [
  { name: 'TypeScript Typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'ESLint Code Quality', command: 'npm', args: ['run', 'lint'] },
  { name: 'Test Suite (Vitest)', command: 'npm', args: ['test'] },
  { name: 'Production Build', command: 'npm', args: ['run', 'build'] },
];

console.log('='.repeat(70));
console.log('  ChangeWatch Comprehensive Quality & Compliance Verification');
console.log('='.repeat(70));

const results: { name: string; status: 'PASS' | 'FAIL'; durationMs: number }[] = [];
let allPassed = true;

for (const step of steps) {
  console.log(`\n>>> Running [${step.name}]...`);
  const start = Date.now();
  const child = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    shell: true,
  });
  const durationMs = Date.now() - start;

  if (child.status === 0) {
    console.log(`✓ [${step.name}] PASSED in ${(durationMs / 1000).toFixed(2)}s`);
    results.push({ name: step.name, status: 'PASS', durationMs });
  } else {
    console.error(`✗ [${step.name}] FAILED with exit code ${child.status} after ${(durationMs / 1000).toFixed(2)}s`);
    results.push({ name: step.name, status: 'FAIL', durationMs });
    allPassed = false;
    break;
  }
}

console.log('\n' + '='.repeat(70));
console.log('  Verification Summary');
console.log('='.repeat(70));
for (const r of results) {
  const badge = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
  console.log(`  ${badge.padEnd(10)} | ${r.name.padEnd(28)} | ${(r.durationMs / 1000).toFixed(2)}s`);
}
console.log('='.repeat(70));

if (!allPassed) {
  console.error('\nVerification failed! Fix the errors above before continuing.');
  process.exit(1);
}

console.log('\nAll checks passed successfully! All verification stages passed.');
process.exit(0);
