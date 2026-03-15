import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { getConfigFilePath } from "./paths.js";
import { parseProviderId, type ProviderId } from "../llm/provider.js";

type PersistedProviderSecretFile = {
  format?: unknown;
  keys?: unknown;
};

type PersistedProviderSecretEntry = {
  iv: string;
  tag: string;
  ciphertext: string;
};

const SECRET_FILE_FORMAT = "local-obfuscated-v1";
const SECRET_DERIVATION_SALT = "superrun.provider-secrets.v1";

export async function loadPersistedProviderApiKeys(options?: {
  filePath?: string;
  installSecretFilePath?: string;
  installSecret?: string;
}): Promise<Partial<Record<ProviderId, string>>> {
  const filePath = options?.filePath ?? getProviderSecretsFilePath();
  const persisted = await readPersistedProviderSecretFile(filePath);
  if (!persisted) {
    return {};
  }

  if (persisted.format !== SECRET_FILE_FORMAT) {
    return {};
  }

  try {
    const encryptionKey = await loadOrCreateInstallSecretKey({
      ...(options?.installSecretFilePath
        ? { installSecretFilePath: options.installSecretFilePath }
        : {}),
      ...(options?.installSecret ? { installSecret: options.installSecret } : {}),
    });

    const decryptedEntries = await Promise.all(
      Object.entries(persisted.keys).map(async ([providerId, entry]) => [
        providerId,
        decryptProviderApiKey(entry, encryptionKey),
      ] as const),
    );

    return Object.fromEntries(decryptedEntries);
  } catch {
    // Corrupted or mismatched local secret material should not block the app.
    return {};
  }
}

export async function savePersistedProviderApiKey(
  providerId: ProviderId,
  apiKey: string,
  options?: {
    filePath?: string;
    installSecretFilePath?: string;
    installSecret?: string;
  },
): Promise<void> {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    throw new Error("Provider API key must not be empty.");
  }

  const filePath = options?.filePath ?? getProviderSecretsFilePath();
  const currentFile = await readPersistedProviderSecretFile(filePath);
  const encryptionKey = await loadOrCreateInstallSecretKey({
    ...(options?.installSecretFilePath
      ? { installSecretFilePath: options.installSecretFilePath }
      : {}),
    ...(options?.installSecret ? { installSecret: options.installSecret } : {}),
  });

  const nextKeys = {
    ...(currentFile?.format === SECRET_FILE_FORMAT ? currentFile.keys : {}),
    [providerId]: encryptProviderApiKey(trimmedApiKey, encryptionKey),
  };

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ format: SECRET_FILE_FORMAT, keys: nextKeys }, null, 2)}\n`,
    "utf8",
  );
}

export async function clearPersistedProviderApiKey(
  providerId: ProviderId,
  options?: {
    filePath?: string;
  },
): Promise<void> {
  const filePath = options?.filePath ?? getProviderSecretsFilePath();
  const currentFile = await readPersistedProviderSecretFile(filePath);
  if (!currentFile) {
    return;
  }

  if (currentFile.format !== SECRET_FILE_FORMAT) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    return;
  }

  const nextKeys = Object.fromEntries(
    Object.entries(currentFile.keys).filter(([key]) => key !== providerId),
  );

  if (Object.keys(nextKeys).length === 0) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ format: SECRET_FILE_FORMAT, keys: nextKeys }, null, 2)}\n`,
    "utf8",
  );
}

function getProviderSecretsFilePath(): string {
  return getConfigFilePath("provider-secrets.json");
}

function getProviderSecretSeedFilePath(): string {
  return getConfigFilePath("provider-secrets.seed");
}

async function readPersistedProviderSecretFile(
  filePath: string,
): Promise<
  | {
      format: string;
      keys: Partial<Record<ProviderId, PersistedProviderSecretEntry>>;
    }
  | null
> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as PersistedProviderSecretFile;
    return parsePersistedProviderSecretFile(parsed, filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Provider secret file is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

function parsePersistedProviderSecretFile(
  value: PersistedProviderSecretFile,
  filePath: string,
): {
  format: string;
  keys: Partial<Record<ProviderId, PersistedProviderSecretEntry>>;
} {
  const format = typeof value.format === "string" ? value.format.trim() : "";
  if (!format) {
    throw new Error(`Provider secret file has an invalid format value: ${filePath}`);
  }

  if (!value.keys || typeof value.keys !== "object") {
    throw new Error(`Provider secret file has an invalid keys value: ${filePath}`);
  }

  if (format !== SECRET_FILE_FORMAT) {
    return {
      format,
      keys: {},
    };
  }

  const parsedKeys: Partial<Record<ProviderId, PersistedProviderSecretEntry>> = {};
  for (const [key, entry] of Object.entries(value.keys)) {
    const providerId = parseProviderId(key);
    if (!entry || typeof entry !== "object") {
      throw new Error(`Provider secret file has an invalid ${key} entry: ${filePath}`);
    }

    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.iv !== "string" ||
      typeof candidate.tag !== "string" ||
      typeof candidate.ciphertext !== "string" ||
      !candidate.iv.trim() ||
      !candidate.tag.trim() ||
      !candidate.ciphertext.trim()
    ) {
      throw new Error(`Provider secret file has an invalid ${key} entry: ${filePath}`);
    }

    parsedKeys[providerId] = {
      iv: candidate.iv.trim(),
      tag: candidate.tag.trim(),
      ciphertext: candidate.ciphertext.trim(),
    };
  }

  return {
    format,
    keys: parsedKeys,
  };
}

async function loadOrCreateInstallSecretKey(options?: {
  installSecretFilePath?: string;
  installSecret?: string;
}): Promise<Buffer> {
  const seed = options?.installSecret?.trim() || await loadOrCreateInstallSecretSeed(
    options?.installSecretFilePath ?? getProviderSecretSeedFilePath(),
  );
  return scryptSync(seed, SECRET_DERIVATION_SALT, 32);
}

async function loadOrCreateInstallSecretSeed(
  filePath: string,
): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    const trimmed = content.trim();
    if (trimmed) {
      return trimmed;
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const generatedSeed = randomBytes(32).toString("base64url");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${generatedSeed}\n`, "utf8");
  return generatedSeed;
}

function encryptProviderApiKey(
  apiKey: string,
  encryptionKey: Buffer,
): PersistedProviderSecretEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);

  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptProviderApiKey(
  entry: PersistedProviderSecretEntry,
  encryptionKey: Buffer,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(entry.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(entry.tag, "base64url"));
  const plainText = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8").trim();

  if (!plainText) {
    throw new Error("Stored provider API key decrypted to an empty value.");
  }

  return plainText;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
