import {
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 32 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: COST,
        r: BLOCK_SIZE,
        p: PARALLELIZATION,
        maxmem: MAX_MEMORY,
      },
      (error, key) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(Buffer.from(key));
      },
    );
  });
}

function formatHash(salt: Buffer, key: Buffer): string {
  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

const dummySalt = Buffer.from(
  '13bc145e20ad2af852b1165e79c242e8',
  'hex',
);
const dummyKey = scryptSync('invalid-password', dummySalt, KEY_LENGTH, {
  N: COST,
  r: BLOCK_SIZE,
  p: PARALLELIZATION,
  maxmem: MAX_MEMORY,
});

export const DUMMY_PASSWORD_HASH = formatHash(dummySalt, dummyKey);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return formatHash(salt, key);
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelization, saltValue, hashValue] =
    storedHash.split('$');

  if (
    algorithm !== 'scrypt' ||
    Number(cost) !== COST ||
    Number(blockSize) !== BLOCK_SIZE ||
    Number(parallelization) !== PARALLELIZATION ||
    !saltValue ||
    !hashValue
  ) {
    return false;
  }

  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(hashValue, 'base64url');

  if (expected.length !== KEY_LENGTH) {
    return false;
  }

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}
