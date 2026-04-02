/**
 * Generate a local encryption master key for CSFLE development/testing.
 *
 * Usage:
 *   node config/generate-encryption-key.js
 *   npm run generate-encryption-key
 *
 * Output:
 *   Prints the ENCRYPTION_LOCAL_KEY value (base64-encoded 96-byte key)
 *   ready to paste into your .env file.
 *
 * This key is used with ENCRYPTION_PROVIDER=local to enable Client-Side Field Level
 * Encryption without requiring AWS KMS. It provides functionally identical CSFLE
 * behavior: real DEKs in __keyVault, real BinData subtype 6 ciphertext, real driver-level
 * auto-decrypt. The only difference is the CMK is a local buffer instead of a remote KMS key.
 *
 * IMPORTANT: This key is NOT suitable for production. Use AWS KMS (ENCRYPTION_PROVIDER=aws)
 * in production environments.
 */

const crypto = require('crypto');
require('./helpers');

const key = crypto.randomBytes(96);
const encoded = key.toString('base64');

console.purple('-------------------------------------------');
console.purple('  CSFLE Local Encryption Key Generator');
console.purple('-------------------------------------------');
console.log('');
console.green('Add the following to your .env file:');
console.log('');
console.log(`ENCRYPTION_PROVIDER=local`);
console.log(`ENCRYPTION_LOCAL_KEY=${encoded}`);
console.log('');
console.orange('NOTE: This key is for local development only.');
console.orange('Use ENCRYPTION_PROVIDER=aws with AWS KMS in production.');
console.purple('-------------------------------------------');
