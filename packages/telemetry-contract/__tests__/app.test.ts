import { describe, expect, it } from "vitest";
import {
  AgentMonitorRuntimeStatusKind,
  AppTelemetrySchema,
  AuditActorKind,
  AuditDecision,
  AuditEvent,
  AuthOutcome,
  AuthReason,
  DEAD_END_RETRY_ATTEMPT_MAX,
  DeadEndPhase,
  DeadEndReason,
  DeadEndRetryOutcome,
  DeadEndState,
  DeadEndTreatment,
  ImportHealthEvent,
  ImportIngestFailure,
  ImportOutcome,
  ROUTINE_STEP_INDEX_MAX,
  RoutineEvent,
  RoutineFailureReason,
  RoutineOutcome,
  RoutineTrigger,
} from "../app";
import { AppExceptionOrigin } from "../app-exception-origin";
import { TelemetryAttribute } from "../src/attributes";
import {
  TelemetryDurationMsMax,
  TelemetryTextMaxLength,
} from "../src/schema-primitives";
import { appPayload } from "../src/test-fixtures";

const NON_BMP_CHARACTER = String.fromCodePoint(0x1_f9_ea);

describe("AppTelemetrySchema", () => {
  it("accepts valid app identity, deployment, lifecycle, and exception attributes", () => {
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
        [TelemetryAttribute.DeploymentEnvironmentName]: "desktop-prod",
        [TelemetryAttribute.ExceptionType]: "Error",
        [TelemetryAttribute.ExceptionMessage]: "Unexpected shutdown",
        [TelemetryAttribute.ExceptionStacktrace]: "Error: Unexpected shutdown",
        [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,
        [TelemetryAttribute.AppOperatingMode]: "multiplayer",
        [TelemetryAttribute.AppLifecycleEvent]: "shutdown",
      })
    ).toMatchObject({
      [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
      [TelemetryAttribute.AppLifecycleEvent]: "shutdown",
    });
  });

  it("accepts an empty payload because every app attribute is optional", () => {
    expect(AppTelemetrySchema.parse({})).toEqual({});
  });

  it("accepts only the closed import outcome values (ISS-6335)", () => {
    for (const outcome of Object.values(ImportOutcome)) {
      expect(
        AppTelemetrySchema.parse({
          [TelemetryAttribute.ImportEvent]: ImportHealthEvent.Pass,
          [TelemetryAttribute.ImportOutcome]: outcome,
        })
      ).toEqual({
        [TelemetryAttribute.ImportEvent]: ImportHealthEvent.Pass,
        [TelemetryAttribute.ImportOutcome]: outcome,
      });
    }

    // Absent is legal: a version-skewed desktop that predates the outcome ships
    // the pass record without it, and that must still validate.
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.ImportEvent]: ImportHealthEvent.Pass,
      })
    ).toEqual({ [TelemetryAttribute.ImportEvent]: ImportHealthEvent.Pass });

    for (const invalid of ["ok", "", "IMPORTED", 0, null]) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.ImportOutcome]: invalid,
        }).success,
        String(invalid)
      ).toBe(false);
    }
  });

  it("accepts only the closed ingest-failure reasons (ISS-6336)", () => {
    for (const reason of Object.values(ImportIngestFailure)) {
      expect(
        AppTelemetrySchema.parse({
          [TelemetryAttribute.ImportEvent]: ImportHealthEvent.IngestFailed,
          [TelemetryAttribute.ImportIngestFailure]: reason,
          [TelemetryAttribute.ImportIngestFailedCount]: 2,
        })
      ).toEqual({
        [TelemetryAttribute.ImportEvent]: ImportHealthEvent.IngestFailed,
        [TelemetryAttribute.ImportIngestFailure]: reason,
        [TelemetryAttribute.ImportIngestFailedCount]: 2,
      });
    }

    // Absent is legal: a desktop that predates these counters ships neither, and
    // its pass and group records must still validate.
    expect(AppTelemetrySchema.parse({})).toEqual({});

    for (const invalid of ["threw", "", "SOURCE_PARSE_THREW", 0, null]) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.ImportIngestFailure]: invalid,
        }).success,
        String(invalid)
      ).toBe(false);
    }
    // The count is a nonnegative integer, so a negative or fractional tally
    // cannot ship and be read as a real number of failures.
    for (const invalid of [-1, 1.5, "2", null]) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.ImportIngestFailedCount]: invalid,
        }).success,
        String(invalid)
      ).toBe(false);
    }
  });

  it("pins the import.event value set exactly (ISS-8600)", () => {
    // An EXACT set, not a superset check: `import.event` is the discriminator
    // every import-health consumer switches on, so a value added without a
    // producer (or removed while one still emits it) has to fail here rather
    // than reach a Datadog query that silently matches nothing.
    expect([...Object.values(ImportHealthEvent)].sort()).toEqual([
      "group_failed",
      "harness_not_advancing",
      "ingest_failed",
      "materialize_failed",
      "materialize_timed_out",
      "pass",
      "sources_remaining",
      "watch_lost",
    ]);
  });

  it("accepts an explicit zero on the quarantine gauge (ISS-6336)", () => {
    // Zero is the value the gauge exists to carry: it is what separates "no
    // poison transcripts" from "this install stopped reporting". A schema that
    // rejected or stripped it would put that ambiguity straight back.
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.ImportSourcesQuarantinedParse]: 0,
        [TelemetryAttribute.ImportSourcesQuarantinedImport]: 0,
      })
    ).toEqual({
      [TelemetryAttribute.ImportSourcesQuarantinedParse]: 0,
      [TelemetryAttribute.ImportSourcesQuarantinedImport]: 0,
    });

    for (const invalid of [-1, 2.5, "0", null]) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.ImportSourcesQuarantinedParse]: invalid,
        }).success,
        String(invalid)
      ).toBe(false);
    }
  });

  it("accepts the multiplayer organization id and bounds its length (FEA-1996)", () => {
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AppOrganizationId]:
          "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
      })
    ).toEqual({
      [TelemetryAttribute.AppOrganizationId]:
        "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
    });

    // Absent in single-player: a payload without the org key parses unchanged.
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AppOperatingMode]: "single_player",
      })
    ).toEqual({
      [TelemetryAttribute.AppOperatingMode]: "single_player",
    });

    for (const invalid of [
      "", // empty
      "a".repeat(TelemetryTextMaxLength.AppOrganizationId + 1), // too long
      "org\nid", // control character
      123, // wrong primitive
    ]) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.AppOrganizationId]: invalid,
        }).success
      ).toBe(false);
    }
  });

  it("accepts only the closed desktop exception origin values", () => {
    for (const origin of Object.values(AppExceptionOrigin)) {
      expect(
        AppTelemetrySchema.parse({
          [TelemetryAttribute.AppExceptionOrigin]: origin,
        })
      ).toEqual({
        [TelemetryAttribute.AppExceptionOrigin]: origin,
      });
    }
  });

  it("counts bounded app text length with Unicode code point semantics", () => {
    expect(
      AppTelemetrySchema.safeParse(
        appPayload({
          [TelemetryAttribute.ExceptionMessage]: NON_BMP_CHARACTER.repeat(
            TelemetryTextMaxLength.ExceptionMessage
          ),
        })
      ).success
    ).toBe(true);
    expect(
      AppTelemetrySchema.safeParse(
        appPayload({
          [TelemetryAttribute.ExceptionMessage]: NON_BMP_CHARACTER.repeat(
            TelemetryTextMaxLength.ExceptionMessage + 1
          ),
        })
      ).success
    ).toBe(false);
  });

  it("rejects invalid enums, wrong primitive types, control characters, excessive text, and unknown attributes", () => {
    for (const payload of [
      appPayload({ [TelemetryAttribute.AppOperatingMode]: "co_op" }),
      appPayload({ [TelemetryAttribute.AppLifecycleEvent]: "restart" }),
      appPayload({ [TelemetryAttribute.AppExceptionOrigin]: "worker" }),
      appPayload({ [TelemetryAttribute.AppExceptionOrigin]: null }),
      appPayload({ "app.exception_origin": "main" }),
      appPayload({ [TelemetryAttribute.AppInstallationId]: 123 }),
      appPayload({ [TelemetryAttribute.DeploymentEnvironmentName]: false }),
      appPayload({ [TelemetryAttribute.ExceptionType]: "Error\nType" }),
      appPayload({
        [TelemetryAttribute.ExceptionStacktrace]: "a".repeat(
          TelemetryTextMaxLength.ExceptionStacktrace + 1
        ),
      }),
      appPayload({ "app.unknown": "value" }),
    ]) {
      expect(AppTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});

describe("AppTelemetrySchema auth attributes (ISS-6334)", () => {
  it("accepts every closed auth.outcome / auth.reason pair", () => {
    for (const outcome of Object.values(AuthOutcome)) {
      for (const reason of Object.values(AuthReason)) {
        const payload = {
          [TelemetryAttribute.AuthOutcome]: outcome,
          [TelemetryAttribute.AuthReason]: reason,
        };
        expect(AppTelemetrySchema.parse(payload)).toEqual(payload);
      }
    }
  });

  it("keeps the auth attributes optional so an older desktop still parses", () => {
    expect(AppTelemetrySchema.parse({})).toEqual({});
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AuthOutcome]: AuthOutcome.PairingRejected,
      })
    ).toEqual({
      [TelemetryAttribute.AuthOutcome]: AuthOutcome.PairingRejected,
    });
  });

  it("carries both auth keys in the strict shape", () => {
    // The `.strict()` boundary only rejects an unknown key if the known ones are
    // actually declared here — a rename would otherwise make the whole payload
    // unparseable at runtime with nothing failing at build time.
    const shapeKeys = Object.keys(AppTelemetrySchema.shape);
    expect(shapeKeys).toContain(TelemetryAttribute.AuthOutcome);
    expect(shapeKeys).toContain(TelemetryAttribute.AuthReason);
  });

  it("refuses free text, a raw error, and any adjacent auth attribute", () => {
    // The pipe these ride is unauthenticated, so the closed set is the security
    // control: anything that is not an enum member must be rejected outright.
    for (const payload of [
      { [TelemetryAttribute.AuthReason]: "Error: ECONNREFUSED 10.0.0.1:443" },
      { [TelemetryAttribute.AuthReason]: "pairing_rejected" },
      { [TelemetryAttribute.AuthOutcome]: "unknown" },
      { [TelemetryAttribute.AuthOutcome]: 401 },
      {
        [TelemetryAttribute.AuthOutcome]: AuthOutcome.TokenRejected,
        "auth.token": "sk_live_leak",
      },
      {
        [TelemetryAttribute.AuthOutcome]: AuthOutcome.TokenRejected,
        "auth.user_email": "someone@example.com",
      },
    ]) {
      expect(AppTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});

/**
 * ISS-7249. The point of these attributes is that five no-data states stay five
 * things, so the tests are about DISTINCTNESS and about what cannot travel, not
 * about round-tripping a happy payload.
 */
describe("AppTelemetrySchema dead-end treatment attributes", () => {
  it("keeps the five no-data states five distinct accepted values", () => {
    const parsed = Object.values(DeadEndState).map(
      (state) =>
        AppTelemetrySchema.parse({ [TelemetryAttribute.DeadEndState]: state })[
          TelemetryAttribute.DeadEndState
        ]
    );

    // Five inputs must survive as five different outputs. A schema that folded
    // any two of them — `loading` onto `unknown`, `true_zero` onto
    // `not_applicable` — would shrink this set and fail here, which is the
    // whole distinction ISS-7249 exists to protect.
    expect(new Set(parsed).size).toBe(5);
    expect(parsed).toEqual([
      "loading",
      "unavailable",
      "not_applicable",
      "unknown",
      "true_zero",
    ]);
  });

  it("keeps every documented cause a distinct accepted reason", () => {
    const parsed = Object.values(DeadEndReason).map(
      (reason) =>
        AppTelemetrySchema.parse({
          [TelemetryAttribute.DeadEndReason]: reason,
        })[TelemetryAttribute.DeadEndReason]
    );

    expect(new Set(parsed).size).toBe(Object.values(DeadEndReason).length);
    // The five the ticket names explicitly, plus the two this producer can
    // genuinely establish on its own surfaces.
    expect(parsed).toEqual(
      expect.arrayContaining([
        "not_yet_synced",
        "absent",
        "fetch_failed",
        "permission_denied",
        "loading_threshold_exceeded",
      ])
    );
  });

  it("accepts every treatment, phase, and retry outcome in the closed sets", () => {
    for (const treatment of Object.values(DeadEndTreatment)) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.DeadEndTreatment]: treatment,
        }).success
      ).toBe(true);
    }
    for (const phase of Object.values(DeadEndPhase)) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.DeadEndPhase]: phase,
        }).success
      ).toBe(true);
    }
    for (const outcome of Object.values(DeadEndRetryOutcome)) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.DeadEndRetryOutcome]: outcome,
        }).success
      ).toBe(true);
    }
  });

  it("refuses free text, identifiers, and paths on every dead-end attribute", () => {
    // The record is a privacy boundary by CONSTRUCTION: there is no arm of any
    // of these enums that a session id, a session name, a transcript excerpt, or
    // a home-directory path could be routed through. Each of these is a value a
    // careless producer might reach for.
    const smuggled = [
      "ses_01H8XABCDEF",
      "Refactor the billing service",
      "/Users/example/Library/Application Support/closedloop",
      "https://app.closedloop.ai/acme/sessions/ses_01H8XABCDEF",
      "ada.lovelace@example.com",
    ];
    for (const value of smuggled) {
      for (const attribute of [
        TelemetryAttribute.DeadEndTreatment,
        TelemetryAttribute.DeadEndPhase,
        TelemetryAttribute.DeadEndState,
        TelemetryAttribute.DeadEndReason,
        TelemetryAttribute.DeadEndRetryOutcome,
      ]) {
        expect(
          AppTelemetrySchema.safeParse({ [attribute]: value }).success,
          `${attribute}=${value}`
        ).toBe(false);
      }
    }
  });

  it("bounds the retry count and the reported status at both ends", () => {
    for (const payload of [
      { [TelemetryAttribute.DeadEndRetryAttempt]: -1 },
      { [TelemetryAttribute.DeadEndRetryAttempt]: 1.5 },
      {
        [TelemetryAttribute.DeadEndRetryAttempt]:
          DEAD_END_RETRY_ATTEMPT_MAX + 1,
      },
      { [TelemetryAttribute.HttpResponseStatusCode]: 0 },
      { [TelemetryAttribute.HttpResponseStatusCode]: 600 },
      { [TelemetryAttribute.DeadEndRetryOffered]: "true" },
    ]) {
      expect(AppTelemetrySchema.safeParse(payload).success).toBe(false);
    }
    expect(
      AppTelemetrySchema.safeParse({
        [TelemetryAttribute.DeadEndRetryAttempt]: DEAD_END_RETRY_ATTEMPT_MAX,
        [TelemetryAttribute.HttpResponseStatusCode]: 404,
        [TelemetryAttribute.DeadEndRetryOffered]: false,
      }).success
    ).toBe(true);
  });
});

const ROUTINE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("AppTelemetrySchema routine/audit attributes (ISS-6313)", () => {
  it("round-trips a complete routine execution record unchanged", () => {
    const record = {
      [TelemetryAttribute.RoutineId]: ROUTINE_ID,
      [TelemetryAttribute.RoutineEvent]: RoutineEvent.Settled,
      [TelemetryAttribute.RoutineTrigger]: RoutineTrigger.Schedule,
      [TelemetryAttribute.RoutineOutcome]: RoutineOutcome.Skipped,
      [TelemetryAttribute.RoutineFailureReason]: RoutineFailureReason.StepError,
      [TelemetryAttribute.RoutineStepIndex]: 4,
      [TelemetryAttribute.DurationMs]: 12_345,
      [TelemetryAttribute.AuditEvent]: AuditEvent.EntryRecorded,
      [TelemetryAttribute.AuditActorKind]: AuditActorKind.Agent,
      [TelemetryAttribute.AuditDecision]: AuditDecision.AutoApproved,
    };

    // deepEqual rather than toMatchObject: a schema that silently DROPPED one of
    // these keys would satisfy a subset match, and a dropped attribute is the
    // exact failure this group must not have.
    expect(AppTelemetrySchema.parse(record)).toEqual(record);
  });

  it("accepts every published member of each routine/audit enum", () => {
    const enumsByAttribute = [
      [TelemetryAttribute.RoutineEvent, RoutineEvent],
      [TelemetryAttribute.RoutineTrigger, RoutineTrigger],
      [TelemetryAttribute.RoutineOutcome, RoutineOutcome],
      [TelemetryAttribute.RoutineFailureReason, RoutineFailureReason],
      [TelemetryAttribute.AuditEvent, AuditEvent],
      [TelemetryAttribute.AuditActorKind, AuditActorKind],
      [TelemetryAttribute.AuditDecision, AuditDecision],
    ] as const;

    for (const [attribute, members] of enumsByAttribute) {
      const values = Object.values(members);
      const parsed = values.map(
        (value) =>
          AppTelemetrySchema.parse({ [attribute]: value })[
            attribute as keyof ReturnType<typeof AppTelemetrySchema.parse>
          ]
      );

      expect(parsed, attribute).toEqual(values);
    }
  });

  it("carries the version-skew safe defaults as real members, not omissions", () => {
    // A producer on a newer vocabulary must have somewhere to land. If these
    // stop being accepted values, an unlearned trigger or decision does not
    // degrade to a dropped ATTRIBUTE — `AppTelemetrySchema` is `.strict()`, so
    // the parse fails and the WHOLE record is dropped, and re-dropped on every
    // retry. `audit.decision` shipped without a landing spot and is the
    // costliest of the set, because the record it loses is a governance record.
    //
    // The wire values are spelled as LITERALS, not `Enum.Unknown`, and that is
    // load-bearing: deleting a member makes `Enum.Unknown` evaluate to
    // `undefined`, an `.optional()` field accepts `undefined`, and a
    // reference-built payload therefore stays green through the exact
    // regression this case exists to catch. Verified — the reference version of
    // this test passed with `AuditDecision.Unknown` deleted. Same reasoning as
    // the string literals pinned in `collector-allowlist.test.ts`.
    const skewed = {
      [TelemetryAttribute.RoutineTrigger]: "unknown",
      [TelemetryAttribute.RoutineOutcome]: "unknown",
      [TelemetryAttribute.RoutineFailureReason]: "unknown",
      [TelemetryAttribute.AuditActorKind]: "unknown",
      [TelemetryAttribute.AuditDecision]: "unknown",
    };

    expect(AppTelemetrySchema.parse(skewed)).toEqual(skewed);
  });

  it("publishes the safe default on every non-discriminator routine/audit enum", () => {
    // The companion to the case above: that one proves the SCHEMA accepts the
    // value, this proves the exported const still PUBLISHES it, so a producer
    // reaching for `AuditDecision.Unknown` finds something to reach for.
    const nonDiscriminators = [
      ["RoutineTrigger", RoutineTrigger],
      ["RoutineOutcome", RoutineOutcome],
      ["RoutineFailureReason", RoutineFailureReason],
      ["AuditActorKind", AuditActorKind],
      ["AuditDecision", AuditDecision],
    ] as const;

    for (const [name, members] of nonDiscriminators) {
      expect(Object.values(members), name).toContain("unknown");
    }

    // Discriminators deliberately have none: a record that cannot say which
    // record it is has nothing to contribute, so there is no record to save.
    expect(Object.values(RoutineEvent)).not.toContain("unknown");
    expect(Object.values(AuditEvent)).not.toContain("unknown");
  });

  it("refuses identity, prose, and paths on every closed routine/audit field", () => {
    const smuggled = [
      "Nightly dependency upgrade",
      "rt_01H8XABCDEF",
      "/Users/example/Library/Application Support/closedloop",
      "ada.lovelace@example.com",
      "https://app.closedloop.ai/acme/routines/rt_01H8XABCDEF",
    ];
    const closedFields = [
      TelemetryAttribute.RoutineEvent,
      TelemetryAttribute.RoutineTrigger,
      TelemetryAttribute.RoutineOutcome,
      TelemetryAttribute.RoutineFailureReason,
      TelemetryAttribute.AuditEvent,
      TelemetryAttribute.AuditActorKind,
      TelemetryAttribute.AuditDecision,
      TelemetryAttribute.RoutineId,
    ];

    for (const value of smuggled) {
      for (const attribute of closedFields) {
        expect(
          AppTelemetrySchema.safeParse({ [attribute]: value }).success,
          `${attribute}=${value}`
        ).toBe(false);
      }
    }

    // Positive sibling: the same call shape accepts the legitimate value, so the
    // rejections above are the enum working and not a typo in the attribute key.
    for (const attribute of closedFields) {
      expect(
        AppTelemetrySchema.safeParse({
          [attribute]:
            attribute === TelemetryAttribute.RoutineId
              ? ROUTINE_ID
              : legalValueFor(attribute),
        }).success,
        attribute
      ).toBe(true);
    }
  });

  it("constrains routine.id to a UUID shape rather than bounded free text", () => {
    expect(
      AppTelemetrySchema.safeParse({
        [TelemetryAttribute.RoutineId]: ROUTINE_ID,
      }).success
    ).toBe(true);

    for (const invalid of [
      "3f2504e0-4f89-41d3-9a0c-0305e82c330",
      "not-a-uuid",
      `${ROUTINE_ID} nightly upgrade`,
      "",
    ]) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.RoutineId]: invalid,
        }).success,
        invalid
      ).toBe(false);
    }
  });

  it("bounds the step position and the duration at both ends", () => {
    for (const payload of [
      { [TelemetryAttribute.RoutineStepIndex]: -1 },
      { [TelemetryAttribute.RoutineStepIndex]: 1.5 },
      { [TelemetryAttribute.RoutineStepIndex]: ROUTINE_STEP_INDEX_MAX + 1 },
      { [TelemetryAttribute.DurationMs]: -1 },
      { [TelemetryAttribute.DurationMs]: TelemetryDurationMsMax + 1 },
    ]) {
      expect(AppTelemetrySchema.safeParse(payload).success).toBe(false);
    }

    expect(
      AppTelemetrySchema.safeParse({
        [TelemetryAttribute.RoutineStepIndex]: ROUTINE_STEP_INDEX_MAX,
        [TelemetryAttribute.DurationMs]: TelemetryDurationMsMax,
      }).success
    ).toBe(true);
  });

  it("rejects an unpublished routine attribute because the schema is strict", () => {
    expect(
      AppTelemetrySchema.safeParse({ "routine.name": "Nightly upgrade" })
        .success
    ).toBe(false);
  });
});

describe("AppTelemetrySchema agent-monitor runtime status (ISS-9082)", () => {
  it("carries every status value through a full heartbeat payload", () => {
    for (const status of Object.values(AgentMonitorRuntimeStatusKind)) {
      expect(
        AppTelemetrySchema.parse({
          [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
          [TelemetryAttribute.AppOperatingMode]: "multiplayer",
          [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
          [TelemetryAttribute.AppAgentMonitorRuntimeStatus]: status,
        })
      ).toMatchObject({
        [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
        [TelemetryAttribute.AppAgentMonitorRuntimeStatus]: status,
      });
    }
  });

  it("rejects a status outside the closed set, and the rejection costs the whole heartbeat", () => {
    const parsed = AppTelemetrySchema.safeParse({
      [TelemetryAttribute.AppOperatingMode]: "multiplayer",
      [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
      [TelemetryAttribute.AppAgentMonitorRuntimeStatus]: "degraded",
    });
    expect(parsed.success).toBe(false);
    // The point of the compile-time coupling on the producer side: a member the
    // contract has not learned does not drop this ATTRIBUTE, it drops the
    // liveness record that was the only reason to add it.
    expect(parsed.data).toBeUndefined();
  });

  it("stays omitted rather than defaulted when a producer sends no status", () => {
    const parsed = AppTelemetrySchema.parse({
      [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
    });
    expect(TelemetryAttribute.AppAgentMonitorRuntimeStatus in parsed).toBe(
      false
    );
  });
});

describe("AppTelemetrySchema telemetry-export counts (ISS-11866)", () => {
  const exportCountAttributes = [
    TelemetryAttribute.AppTelemetryExportDroppedOversizeCount,
    TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount,
    TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount,
    TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount,
    TelemetryAttribute.AppTelemetryExportDroppedInvalidCount,
    TelemetryAttribute.AppTelemetryExportSentCount,
  ];

  it("carries every export count on a heartbeat, distinct per counter and zero included", () => {
    const payload = Object.fromEntries(
      exportCountAttributes.map((attribute, index) => [attribute, index])
    );
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
        ...payload,
      })
    ).toEqual({
      [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
      ...payload,
    });
  });

  it.each(exportCountAttributes)(
    "rejects a negative, fractional, or string %s",
    (attribute) => {
      for (const value of [-1, 1.5, "3"]) {
        expect(
          AppTelemetrySchema.safeParse({ [attribute]: value }).success
        ).toBe(false);
      }
    }
  );

  it("stays omitted rather than defaulted when a producer sends no counts", () => {
    const parsed = AppTelemetrySchema.parse({
      [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
    });
    for (const attribute of exportCountAttributes) {
      expect(attribute in parsed).toBe(false);
    }
  });
});

function legalValueFor(attribute: string): string {
  const legalByAttribute: Record<string, string> = {
    [TelemetryAttribute.RoutineEvent]: RoutineEvent.Settled,
    [TelemetryAttribute.RoutineTrigger]: RoutineTrigger.Schedule,
    [TelemetryAttribute.RoutineOutcome]: RoutineOutcome.Success,
    [TelemetryAttribute.RoutineFailureReason]: RoutineFailureReason.Timeout,
    [TelemetryAttribute.AuditEvent]: AuditEvent.EntryRecorded,
    [TelemetryAttribute.AuditActorKind]: AuditActorKind.User,
    [TelemetryAttribute.AuditDecision]: AuditDecision.Approved,
  };
  return legalByAttribute[attribute] ?? "";
}
