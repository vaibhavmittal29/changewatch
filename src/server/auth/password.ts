import crypto from 'node:crypto';
import { env } from '../config.js';

export interface HashResult {
  hash: string;
  salt: string;
  iterations: number;
}

/**
 * Hashes a plaintext password using PBKDF2 with SHA-512.
 */
export function hashPassword(password: string, customIterations?: number): Promise<HashResult> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = customIterations || env.PBKDF2_ITERATIONS;

    crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, derivedKey) => {
      if (err) return reject(err);
      resolve({
        hash: derivedKey.toString('hex'),
        salt,
        iterations,
      });
    });
  });
}

/**
 * Verifies a plaintext password against a stored hash and salt in constant time.
 */
export function verifyPassword(password: string, storedHash: string, salt: string, iterations: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 64, 'sha512', (err, derivedKey) => {
      if (err) return reject(err);
      const hashBuffer = Buffer.from(storedHash, 'hex');
      if (hashBuffer.length !== derivedKey.length) {
        return resolve(false);
      }
      resolve(crypto.timingSafeEqual(hashBuffer, derivedKey));
    });
  });
}
