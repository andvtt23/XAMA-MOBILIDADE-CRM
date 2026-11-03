import {
  createHash,
  randomBytes,
  scrypt as deriveScrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(deriveScrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, hashHex] = String(encoded ?? "").split("$");
  if (
    algorithm !== "scrypt"
    || !/^[a-f0-9]{32}$/i.test(saltHex ?? "")
    || !/^[a-f0-9]{128}$/i.test(hashHex ?? "")
  ) {
    return false;
  }
  const derived = Buffer.from(await scrypt(String(password), Buffer.from(saltHex, "hex"), 64));
  const expected = Buffer.from(hashHex, "hex");
  return timingSafeEqual(derived, expected);
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}
