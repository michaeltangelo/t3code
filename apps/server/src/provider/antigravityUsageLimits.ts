import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
} from "./antigravityAuthSupport.ts";

export function antigravityUserAgent(platform: NodeJS.Platform, architecture: NodeJS.Architecture) {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`;
}

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
// The ACP runtime meters consumer tiers on the daily host and GCP-terms tiers on prod.
// The sign-in method stands in for the tier.
const ENDPOINTS = {
  "oauth-personal": [DAILY_ENDPOINT, PROD_ENDPOINT],
  "oauth-business": [PROD_ENDPOINT, DAILY_ENDPOINT],
};
const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const TokenFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  project_id: Schema.optional(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const UserInfo = Schema.Struct({ id: Schema.NonEmptyString });
const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
const Models = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});
const CliBucket = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const CliSummary = Schema.Struct({
  description: Schema.optional(Schema.String),
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(CliBucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(CliBucket)),
});
const CliUsageEnvelope = Schema.Struct({
  status: Schema.Literal("SUCCESS"),
  command: Schema.Struct({
    name: Schema.Literal("usage"),
    data: CliSummary,
  }),
});
const CliTurnEnvelope = Schema.Struct({
  conversation_id: Schema.optional(Schema.String),
  num_turns: Schema.optional(Schema.Number),
});

// Before agy 1.1.11, `/usage` in print mode spent a model turn instead of running the command.
const ANTIGRAVITY_MIN_USAGE_CLI_VERSION = "1.1.11";
const CLI_USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"];
const CLI_MAX_OUTPUT_BYTES = 512 * 1024;
const CLI_SIGNED_OUT_PHRASES = [
  "authentication required. please visit the url",
  "not logged into antigravity",
  "not logged in",
  "not signed in",
  "not authenticated",
  "not-authenticated",
  "unauthenticated",
  "run agy login",
  "please sign in",
  "please log in",
  "sign in to antigravity",
  "no credentials",
  "authentication required",
] as const;

const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeSummary = Schema.decodeUnknownEffect(Summary);
const decodeModels = Schema.decodeUnknownEffect(Models);
const decodeCliUsageEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(CliUsageEnvelope));
const decodeCliTurnEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(CliTurnEnvelope));

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryResetTime(
  bucket: typeof Bucket.Type,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  // Untouched summary buckets report a rolling full-window reset.
  const untouched =
    bucket.remainingFraction === 1 &&
    bucket.description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(Date.parse(bucket.resetTime ?? "") - requestedAt - windowDurationMins * 60_000) <=
      60_000;
  return untouched ? undefined : bucket.resetTime;
}

const sha256 = Effect.fnUntraced(function* (text: string) {
  const digest = yield* (yield* Digest.Digest).digest(
    Digest.sha256,
    new TextEncoder().encode(text),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** Keys an account by its Google ID, which matches across machines and hubs; refresh tokens do not. */
export const antigravityAccountFingerprint = (userInfo: unknown) =>
  decodeUserInfo(userInfo).pipe(Effect.flatMap((info) => sha256(`google-account\0${info.id}`)));

/** Windows from a `retrieveUserQuotaSummary` answer requested at `requestedAt`. */
export const antigravitySummaryWindows = (response: unknown, requestedAt: number) =>
  decodeSummary(response).pipe(Effect.map((summary) => summaryWindows(summary, requestedAt)));

function summaryWindows(summary: typeof Summary.Type, requestedAt: number) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      // Argon and Carbon are metered separately from the default Gemini buckets.
      const family = bucket.bucketId.startsWith("gemini-argon-")
        ? group.displayName?.trim() || "Gemini Argon"
        : bucket.bucketId.startsWith("gemini-carbon-")
          ? group.displayName?.trim() || "Gemini Carbon"
          : bucket.bucketId.startsWith("gemini-")
            ? "Gemini"
            : bucket.bucketId.startsWith("3p-")
              ? "Claude & GPT (shared)"
              : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        { ...bucket, resetTime: summaryResetTime(bucket, windowDurationMins, requestedAt) },
        weekly ? "weekly" : session ? "session" : "other",
        windowDurationMins,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** Older accounts expose model quotas without a window length. Do not invent a reset cadence. */
function modelWindows(models: typeof Models.Type) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [modelId, model] of Object.entries(models.models)) {
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
            ? "GPT"
            : undefined;
    if (!family) continue;
    for (const [suffix, quota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (!quota) continue;
      const window = quotaWindow(
        `${family.toLowerCase()}-${suffix}`,
        `${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`,
        quota,
        suffix === "weekly" ? "weekly" : "other",
        suffix === "weekly" ? 7 * 24 * 60 : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

function toSummaryBucket(bucket: typeof CliBucket.Type): typeof Bucket.Type {
  return {
    bucketId: bucket.id,
    ...(bucket.name !== undefined ? { displayName: bucket.name } : {}),
    ...(bucket.description !== undefined ? { description: bucket.description } : {}),
    ...(bucket.window !== undefined ? { window: bucket.window } : {}),
    ...(bucket.remaining_fraction !== undefined
      ? { remainingFraction: bucket.remaining_fraction }
      : {}),
    ...(bucket.reset_time !== undefined ? { resetTime: bucket.reset_time } : {}),
    ...(bucket.disabled !== undefined ? { disabled: bucket.disabled } : {}),
  };
}

function toSummary(cli: typeof CliSummary.Type): typeof Summary.Type {
  return {
    ...(cli.groups !== undefined
      ? {
          groups: cli.groups.map((group) => ({
            ...(group.name !== undefined ? { displayName: group.name } : {}),
            ...(group.buckets !== undefined ? { buckets: group.buckets.map(toSummaryBucket) } : {}),
          })),
        }
      : {}),
    ...(cli.buckets !== undefined ? { buckets: cli.buckets.map(toSummaryBucket) } : {}),
  };
}

/** Windows from an `agy -p /usage --output-format json` print envelope requested at `requestedAt`. */
export function antigravityCliUsageWindows(
  stdout: string,
  requestedAt: number,
): ReadonlyArray<ServerProviderUsageWindow> | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const decoded = decodeCliUsageEnvelope(trimmed);
    if (Option.isSome(decoded)) {
      return summaryWindows(toSummary(decoded.value.command.data), requestedAt);
    }
  }
  return null;
}

function cliOutputShowsModelTurn(stdout: string): boolean {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const decoded = decodeCliTurnEnvelope(trimmed);
    if (
      Option.isSome(decoded) &&
      ((decoded.value.num_turns !== undefined && decoded.value.num_turns > 0) ||
        Boolean(decoded.value.conversation_id?.trim()))
    ) {
      return true;
    }
  }
  return false;
}

function isCliSignedOutOutput(output: string): boolean {
  if (
    output.includes(ANTIGRAVITY_AUTH_BROWSER_MARKER) ||
    output.includes(ANTIGRAVITY_AUTH_STDOUT_PREFIX)
  ) {
    return true;
  }
  for (const line of output.split("\n")) {
    const index = line.indexOf("AGY_ERROR:");
    if (index === -1) continue;
    const payload = line.slice(index + "AGY_ERROR:".length).trim();
    if (/^\{.*"status"\s*:\s*"UNAUTHENTICATED"|"error_code"\s*:\s*401/i.test(payload)) {
      return true;
    }
  }
  const lowered = output.toLowerCase();
  return CLI_SIGNED_OUT_PHRASES.some((phrase) => lowered.includes(phrase));
}

function parseCliSemver(text: string): string | null {
  return text.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

export interface AntigravityUsageCli {
  readonly executablePath: string;
  readonly version: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly resolveCli?: Effect.Effect<AntigravityUsageCli | null>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const crypto = yield* Digest.Digest;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const spawnerOption = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");
  let cached:
    | { fingerprint: string; account: string; accessToken: string; expiresAt: number }
    | undefined;
  let cliSignedOut = false;
  let unsupportedCliExecutable: string | null = null;
  let generation = 0;

  const runCliCommand = Effect.fn("AntigravityUsageProbe.runCliCommand")(function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    executablePath: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv | undefined,
    timeout: "5 seconds" | "25 seconds",
  ) {
    return yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(executablePath, [...args], {
          env: {
            ...(env ?? process.env),
            AGY_CLI_DISABLE_AUTO_UPDATE: "true",
          },
          extendEnv: false,
          shell: false,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: CLI_MAX_OUTPUT_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: CLI_MAX_OUTPUT_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout.text, stderr: stderr.text, exitCode: Number(exitCode) };
    }).pipe(Effect.scoped, Effect.timeout(timeout));
  });

  const readFromCli = Effect.fn("AntigravityUsageProbe.readFromCli")(function* (
    startedGeneration: number,
    checkedAt: string,
  ) {
    if (cliSignedOut || !input.resolveCli || Option.isNone(spawnerOption)) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with Google to see Antigravity limits.",
      });
    }
    const cli = yield* input.resolveCli;
    if (!cli) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with Google to see Antigravity limits.",
      });
    }
    if (unsupportedCliExecutable === cli.executablePath) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: `Update Antigravity to ${ANTIGRAVITY_MIN_USAGE_CLI_VERSION} or newer to see limits.`,
      });
    }
    const spawner = spawnerOption.value;
    let version = cli.version ? parseCliSemver(cli.version) : null;
    if (!version) {
      const versionRun = yield* runCliCommand(
        spawner,
        cli.executablePath,
        ["--version"],
        cli.env,
        "5 seconds",
      ).pipe(Effect.orElseSucceed(() => null));
      version = versionRun
        ? parseCliSemver(versionRun.stdout.trim() ? versionRun.stdout : versionRun.stderr)
        : null;
    }
    if (!version || (compareSemverVersions(version, ANTIGRAVITY_MIN_USAGE_CLI_VERSION) ?? -1) < 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: `Update Antigravity to ${ANTIGRAVITY_MIN_USAGE_CLI_VERSION} or newer to see limits.`,
      });
    }
    const result = yield* runCliCommand(
      spawner,
      cli.executablePath,
      CLI_USAGE_ARGS,
      cli.env,
      "25 seconds",
    );
    const requestedAt = yield* Clock.currentTimeMillis;
    const windows = antigravityCliUsageWindows(result.stdout, requestedAt);
    if (windows !== null) {
      if (windows.length === 0) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity did not return usable quota information.",
        });
      }
      return makeUsageLimits({ checkedAt, windows: [...windows] });
    }
    if (cliOutputShowsModelTurn(result.stdout)) {
      unsupportedCliExecutable = cli.executablePath;
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: `Update Antigravity to ${ANTIGRAVITY_MIN_USAGE_CLI_VERSION} or newer to see limits.`,
      });
    }
    if (isCliSignedOutOutput(`${result.stdout}\n${result.stderr}`)) {
      if (generation === startedGeneration) cliSignedOut = true;
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with Google to see Antigravity limits.",
      });
    }
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Antigravity did not return usable quota information.",
    });
  });

  const request = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
    );
  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    if (!(yield* fs.exists(tokenPath))) {
      cached = undefined;
      return yield* readFromCli(startedGeneration, checkedAt);
    }
    const token = yield* fs.readFileString(tokenPath).pipe(Effect.flatMap(decodeTokenFile));
    const fingerprint = yield* sha256(
      `${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ""}`,
    );
    const now = yield* Clock.currentTimeMillis;
    let accessToken: string;
    let account: string;
    if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now + 60_000) {
      cached = undefined;
      const refreshed = yield* request(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: token.client_id,
            client_secret: token.client_secret,
            refresh_token: token.refresh_token,
            grant_type: "refresh_token",
          }),
        ),
      ).pipe(Effect.flatMap(decodeTokenResponse));
      accessToken = refreshed.access_token;
      // Use Google account IDs to merge accounts across environments; refresh tokens differ per machine.
      account = yield* request(
        HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
          HttpClientRequest.setHeaders({ Authorization: `Bearer ${accessToken}` }),
        ),
      ).pipe(
        Effect.flatMap(antigravityAccountFingerprint),
        Effect.orElseSucceed(() => fingerprint),
      );
      if (generation === startedGeneration) {
        cached = {
          fingerprint,
          account,
          accessToken,
          expiresAt: now + refreshed.expires_in * 1000,
        };
      }
    } else {
      accessToken = cached.accessToken;
      account = cached.account;
    }
    const endpoints = ENDPOINTS[input.authMethod];
    // Merge endpoints because quota groups differ; the metered host's reading of a bucket wins.
    const fetchWindows = Effect.fn("AntigravityUsageProbe.fetchWindows")(function* <E>(
      operation: string,
      parse: (
        response: unknown,
        requestedAt: number,
      ) => Effect.Effect<ServerProviderUsageWindow[], E>,
    ) {
      const responses = yield* Effect.forEach(
        endpoints,
        (endpoint) =>
          Effect.gen(function* () {
            // Capture each request after auth, so refresh latency does not widen the tolerance.
            const requestedAt = yield* Clock.currentTimeMillis;
            return yield* request(
              HttpClientRequest.post(`${endpoint}/v1internal:${operation}`).pipe(
                HttpClientRequest.setHeaders({
                  Authorization: `Bearer ${accessToken}`,
                  "User-Agent": antigravityUserAgent(platform, architecture),
                }),
                HttpClientRequest.bodyJsonUnsafe(
                  token.project_id ? { project: token.project_id } : {},
                ),
              ),
            ).pipe(
              Effect.flatMap((response) => parse(response, requestedAt)),
              Effect.orElseSucceed(() => []),
            );
          }),
        { concurrency: "unbounded" },
      );
      const windows = new Map<string, ServerProviderUsageWindow>();
      for (const window of responses.flat()) {
        if (!windows.has(window.id)) windows.set(window.id, window);
      }
      return [...windows.values()];
    });
    const summary = yield* fetchWindows("retrieveUserQuotaSummary", antigravitySummaryWindows);
    const windows = summary.length
      ? summary
      : yield* fetchWindows("fetchAvailableModels", (response) =>
          decodeModels(response).pipe(Effect.map(modelWindows)),
        );
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not return usable quota information.",
      });
    }
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint: account };
  });
  const probe = read.pipe(
    Effect.provideService(Digest.Digest, crypto),
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits. Refresh provider status to retry.",
        });
      }),
    ),
  );
  return {
    probe,
    clear: Effect.sync(() => {
      cached = undefined;
      cliSignedOut = false;
      generation++;
    }),
  };
});
