/**
 * Seed a small fictional organization for local development.
 * Run with: npm run db:seed
 * Safe to re-run: employees are looked up by email first and skipped if already present.
 */
import { createEmployee, getEmployeeByEmail } from '../src/db/employees';
import { createCycle, listCycles } from '../src/db/cycles';

interface SeedEmployee {
  name: string;
  email: string;
  department: string;
  managerEmail?: string;
  isPeopleAdmin?: boolean;
}

// Manager hierarchy: Riley (People Ops lead, People Admin + suggested Primary Approver)
// -> Morgan (Engineering manager, 3 direct reports) -> Casey/Devon/Priya
// -> Jordan (Design manager, 2 direct reports, skip-level under Riley) -> Sam/Alex
const SEED_EMPLOYEES: SeedEmployee[] = [
  { name: 'Riley Chen', email: 'riley.chen@example-corp.test', department: 'People Ops', isPeopleAdmin: true },
  {
    name: 'Morgan Blake',
    email: 'morgan.blake@example-corp.test',
    department: 'Engineering',
    managerEmail: 'riley.chen@example-corp.test',
  },
  {
    name: 'Jordan Reyes',
    email: 'jordan.reyes@example-corp.test',
    department: 'Design',
    managerEmail: 'riley.chen@example-corp.test',
  },
  {
    name: 'Casey Nakamura',
    email: 'casey.nakamura@example-corp.test',
    department: 'Engineering',
    managerEmail: 'morgan.blake@example-corp.test',
  },
  {
    name: 'Devon Patel',
    email: 'devon.patel@example-corp.test',
    department: 'Engineering',
    managerEmail: 'morgan.blake@example-corp.test',
  },
  {
    name: 'Priya Sharma',
    email: 'priya.sharma@example-corp.test',
    department: 'Engineering',
    managerEmail: 'morgan.blake@example-corp.test',
  },
  {
    name: 'Sam Okafor',
    email: 'sam.okafor@example-corp.test',
    department: 'Design',
    managerEmail: 'jordan.reyes@example-corp.test',
  },
  {
    name: 'Alex Novak',
    email: 'alex.novak@example-corp.test',
    department: 'Design',
    managerEmail: 'jordan.reyes@example-corp.test',
  },
  {
    name: 'Taylor Brooks',
    email: 'taylor.brooks@example-corp.test',
    department: 'Sales',
    managerEmail: 'riley.chen@example-corp.test',
  },
  {
    name: 'Harper Lee',
    email: 'harper.lee@example-corp.test',
    department: 'Sales',
    managerEmail: 'taylor.brooks@example-corp.test',
  },
];

const PRIMARY_APPROVER_SUGGESTION = 'riley.chen@example-corp.test';

async function seedEmployees(): Promise<void> {
  const idByEmail = new Map<string, string>();

  // Topological pass: an employee's manager must already exist (in this file's order, every
  // managerEmail appears earlier in SEED_EMPLOYEES than the report referencing it).
  for (const seed of SEED_EMPLOYEES) {
    const existing = await getEmployeeByEmail(seed.email);
    if (existing) {
      idByEmail.set(seed.email, existing.id);
      console.log(`- ${seed.email} already exists, skipping.`);
      continue;
    }

    const managerId = seed.managerEmail ? (idByEmail.get(seed.managerEmail) ?? null) : null;
    const employee = await createEmployee({
      name: seed.name,
      email: seed.email,
      department: seed.department,
      manager_id: managerId,
      status: 'active',
      is_people_admin: seed.isPeopleAdmin ?? false,
    });
    idByEmail.set(seed.email, employee.id);
    console.log(`+ created ${employee.name} <${employee.email}> (manager: ${seed.managerEmail ?? 'none'})`);
  }
}

async function seedCycle(): Promise<void> {
  const cycles = await listCycles();
  const existing = cycles.find((c) => c.name === '2026 H1 Pilot');
  if (existing) {
    console.log(`Cycle "2026 H1 Pilot" already exists (${existing.id}), skipping.`);
    return;
  }
  const riley = await getEmployeeByEmail(PRIMARY_APPROVER_SUGGESTION);
  const cycle = await createCycle(
    {
      name: '2026 H1 Pilot',
      timezone: 'America/Los_Angeles',
      deadlines: {},
      max_peers: 3,
    },
    riley?.id ?? 'seed-script'
  );
  console.log(`+ created draft cycle "${cycle.name}" (${cycle.id})`);
}

async function main(): Promise<void> {
  console.log('Seeding fictional organization...');
  await seedEmployees();
  await seedCycle();
  console.log('');
  console.log('Done. For local dev, set:');
  console.log(`  PRIMARY_APPROVER_EMAIL=${PRIMARY_APPROVER_SUGGESTION}`);
  console.log('(Riley Chen was seeded with is_people_admin=true, matching the People Admin +');
  console.log(' Primary Approver requirement — Primary Approver must also be a People admin.)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
