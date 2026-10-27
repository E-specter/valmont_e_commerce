// Genera deploy/.env desde deploy/.env.example con secretos aleatorios, sin imprimirlos (T-100).
// Mismas claves que utils/generate-keys.sh y utils/add-new-auth-keys.sh de Supabase autohospedado
// (tag self-hosted/v0.8.3): JWT_SECRET con ANON_KEY y SERVICE_ROLE_KEY (HS256), y un par EC P-256
// para que Auth firme los access tokens con ES256 y publique su JWKS (D-018).
//   node generate-env.mjs <plantilla> <destino>     (el destino no debe existir)
import assert from 'node:assert/strict';
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [template, target] = process.argv.slice(2);
assert(template && target, 'Uso: node generate-env.mjs <plantilla> <destino>');

// Hexadecimal: van sin escapar en las URL de conexión y en SQL (scripts/migrate.sh).
const hex = (bytes) => randomBytes(bytes).toString('hex');
const b64url = (value) => Buffer.from(value).toString('base64url');

const jwtSecret = hex(32);
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 5 * 365 * 24 * 3600; // 5 años, como los scripts oficiales
const hs256 = (payload) => {
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  return `${data}.${createHmac('sha256', jwtSecret).update(data).digest('base64url')}`;
};

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const { crv, x, y, d } = privateKey.export({ format: 'jwk' });
const ec = { kty: 'EC', kid: randomUUID(), use: 'sig', alg: 'ES256', ext: true, crv, x, y };
// Auth firma con la única JWK cuyo key_ops incluye "sign"; la simétrica sigue validando las
// claves de API HS256 y Auth no la publica en su JWKS.
const signingKey = { ...ec, key_ops: ['sign', 'verify'], d };
const publicKey = { ...ec, key_ops: ['verify'] };
const oct = { kty: 'oct', k: b64url(jwtSecret), alg: 'HS256' };

// Autocomprobación antes de escribir nada: el par exportado firma y verifica.
const probe = Buffer.from('valmont');
const signature = sign('sha256', probe, createPrivateKey({ key: signingKey, format: 'jwk' }));
assert(verify('sha256', probe, createPublicKey({ key: publicKey, format: 'jwk' }), signature));

const values = {
  POSTGRES_PASSWORD: hex(32),
  VALMONT_APP_DB_PASSWORD: hex(32),
  JWT_SECRET: jwtSecret,
  ANON_KEY: hs256({ role: 'anon', iss: 'supabase', iat, exp }),
  SERVICE_ROLE_KEY: hs256({ role: 'service_role', iss: 'supabase', iat, exp }),
  JWT_KEYS: JSON.stringify([signingKey, oct]),
  JWT_JWKS: JSON.stringify({ keys: [publicKey, oct] }),
};

const pending = new Set(Object.keys(values));
const lines = readFileSync(template, 'utf8')
  .split(/\r?\n/)
  .map((line) => {
    const name = line.split('=', 1)[0];
    return pending.delete(name) ? `${name}=${values[name]}` : line;
  });
assert.equal(pending.size, 0, `Faltan en la plantilla: ${[...pending].join(', ')}`);
// 'wx' nunca sobrescribe: cambiar POSTGRES_PASSWORD tras el primer arranque deja a Auth y Storage
// sin acceso a la BD (roles.sql solo corre al crearla).
writeFileSync(target, lines.join('\n'), { mode: 0o600, flag: 'wx' });
