import { loadConfig } from '../config/env.js';
import { createAdminAuthRepository } from '../modules/identity/platform/auth.repository.js';
import { createAdminAuthService } from '../modules/identity/platform/auth.service.js';
import type { AdminRole } from '../modules/identity/platform/auth.types.js';
import { MongoDatabaseConnection } from '../shared/database/database-connection.js';

const config = loadConfig();
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME;
const role = process.env.BOOTSTRAP_ADMIN_ROLE as AdminRole | undefined;

if (
  !email ||
  !password ||
  !displayName ||
  !role ||
  !['ADMIN', 'OPS', 'SUPPORT'].includes(role)
) {
  throw new Error(
    'BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD, ' +
      'BOOTSTRAP_ADMIN_DISPLAY_NAME and a valid BOOTSTRAP_ADMIN_ROLE are required',
  );
}

const database = new MongoDatabaseConnection(config.mongodb);

try {
  await database.connect();
  const service = createAdminAuthService({
    repository: createAdminAuthRepository(database),
    authConfig: config.auth,
  });
  const result = await service.bootstrapAdmin({
    email,
    password,
    displayName,
    role,
  });
  process.stdout.write(`Admin created: ${result.adminId}\n`);
} finally {
  await database.close();
}
