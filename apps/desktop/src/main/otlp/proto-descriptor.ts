import protobuf from "protobufjs";

export const OtlpExportKind = {
  Metrics: "metrics",
  Logs: "logs",
  Traces: "traces",
} as const;

export type OtlpExportKind =
  (typeof OtlpExportKind)[keyof typeof OtlpExportKind];

const otlpDescriptor: protobuf.INamespace = {
  nested: {
    opentelemetry: {
      nested: {
        proto: {
          nested: {
            common: {
              nested: {
                v1: {
                  nested: {
                    AnyValue: {
                      oneofs: {
                        value: {
                          oneof: [
                            "stringValue",
                            "boolValue",
                            "intValue",
                            "doubleValue",
                            "arrayValue",
                            "kvlistValue",
                            "bytesValue",
                          ],
                        },
                      },
                      fields: {
                        stringValue: { type: "string", id: 1 },
                        boolValue: { type: "bool", id: 2 },
                        intValue: { type: "int64", id: 3 },
                        doubleValue: { type: "double", id: 4 },
                        arrayValue: {
                          type: "opentelemetry.proto.common.v1.ArrayValue",
                          id: 5,
                        },
                        kvlistValue: {
                          type: "opentelemetry.proto.common.v1.KeyValueList",
                          id: 6,
                        },
                        bytesValue: { type: "bytes", id: 7 },
                      },
                    },
                    ArrayValue: {
                      fields: {
                        values: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.AnyValue",
                          id: 1,
                        },
                      },
                    },
                    KeyValueList: {
                      fields: {
                        values: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 1,
                        },
                      },
                    },
                    KeyValue: {
                      fields: {
                        key: { type: "string", id: 1 },
                        value: {
                          type: "opentelemetry.proto.common.v1.AnyValue",
                          id: 2,
                        },
                      },
                    },
                    InstrumentationScope: {
                      fields: {
                        name: { type: "string", id: 1 },
                        version: { type: "string", id: 2 },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 3,
                        },
                      },
                    },
                  },
                },
              },
            },
            resource: {
              nested: {
                v1: {
                  nested: {
                    Resource: {
                      fields: {
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
            metrics: {
              nested: {
                v1: {
                  nested: {
                    Gauge: { fields: {} },
                    Sum: { fields: {} },
                    Histogram: { fields: {} },
                    ExponentialHistogram: { fields: {} },
                    Summary: { fields: {} },
                    Metric: {
                      fields: {
                        name: { type: "string", id: 1 },
                        description: { type: "string", id: 2 },
                        unit: { type: "string", id: 3 },
                        gauge: {
                          type: "opentelemetry.proto.metrics.v1.Gauge",
                          id: 5,
                        },
                        sum: {
                          type: "opentelemetry.proto.metrics.v1.Sum",
                          id: 7,
                        },
                        histogram: {
                          type: "opentelemetry.proto.metrics.v1.Histogram",
                          id: 9,
                        },
                        exponentialHistogram: {
                          type: "opentelemetry.proto.metrics.v1.ExponentialHistogram",
                          id: 10,
                        },
                        summary: {
                          type: "opentelemetry.proto.metrics.v1.Summary",
                          id: 11,
                        },
                      },
                    },
                    ScopeMetrics: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1,
                        },
                        metrics: {
                          rule: "repeated",
                          type: "opentelemetry.proto.metrics.v1.Metric",
                          id: 2,
                        },
                      },
                    },
                    ResourceMetrics: {
                      fields: {
                        resource: {
                          type: "opentelemetry.proto.resource.v1.Resource",
                          id: 1,
                        },
                        scopeMetrics: {
                          rule: "repeated",
                          type: "opentelemetry.proto.metrics.v1.ScopeMetrics",
                          id: 2,
                        },
                      },
                    },
                  },
                },
              },
            },
            logs: {
              nested: {
                v1: {
                  nested: {
                    LogRecord: {
                      fields: {
                        timeUnixNano: { type: "fixed64", id: 1 },
                        observedTimeUnixNano: { type: "fixed64", id: 11 },
                        severityNumber: { type: "int32", id: 2 },
                        severityText: { type: "string", id: 3 },
                        body: {
                          type: "opentelemetry.proto.common.v1.AnyValue",
                          id: 5,
                        },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 6,
                        },
                        traceId: { type: "bytes", id: 9 },
                        spanId: { type: "bytes", id: 10 },
                      },
                    },
                    ScopeLogs: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1,
                        },
                        logRecords: {
                          rule: "repeated",
                          type: "opentelemetry.proto.logs.v1.LogRecord",
                          id: 2,
                        },
                      },
                    },
                    ResourceLogs: {
                      fields: {
                        resource: {
                          type: "opentelemetry.proto.resource.v1.Resource",
                          id: 1,
                        },
                        scopeLogs: {
                          rule: "repeated",
                          type: "opentelemetry.proto.logs.v1.ScopeLogs",
                          id: 2,
                        },
                      },
                    },
                  },
                },
              },
            },
            trace: {
              nested: {
                v1: {
                  nested: {
                    Span: {
                      fields: {
                        traceId: { type: "bytes", id: 1 },
                        spanId: { type: "bytes", id: 2 },
                        parentSpanId: { type: "bytes", id: 4 },
                        name: { type: "string", id: 5 },
                        kind: { type: "int32", id: 6 },
                        startTimeUnixNano: { type: "fixed64", id: 7 },
                        endTimeUnixNano: { type: "fixed64", id: 8 },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 9,
                        },
                      },
                    },
                    ScopeSpans: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1,
                        },
                        spans: {
                          rule: "repeated",
                          type: "opentelemetry.proto.trace.v1.Span",
                          id: 2,
                        },
                      },
                    },
                    ResourceSpans: {
                      fields: {
                        resource: {
                          type: "opentelemetry.proto.resource.v1.Resource",
                          id: 1,
                        },
                        scopeSpans: {
                          rule: "repeated",
                          type: "opentelemetry.proto.trace.v1.ScopeSpans",
                          id: 2,
                        },
                      },
                    },
                  },
                },
              },
            },
            collector: {
              nested: {
                metrics: {
                  nested: {
                    v1: {
                      nested: {
                        ExportMetricsServiceRequest: {
                          fields: {
                            resourceMetrics: {
                              rule: "repeated",
                              type: "opentelemetry.proto.metrics.v1.ResourceMetrics",
                              id: 1,
                            },
                          },
                        },
                        ExportMetricsServiceResponse: { fields: {} },
                      },
                    },
                  },
                },
                logs: {
                  nested: {
                    v1: {
                      nested: {
                        ExportLogsServiceRequest: {
                          fields: {
                            resourceLogs: {
                              rule: "repeated",
                              type: "opentelemetry.proto.logs.v1.ResourceLogs",
                              id: 1,
                            },
                          },
                        },
                        ExportLogsServiceResponse: { fields: {} },
                      },
                    },
                  },
                },
                trace: {
                  nested: {
                    v1: {
                      nested: {
                        ExportTraceServiceRequest: {
                          fields: {
                            resourceSpans: {
                              rule: "repeated",
                              type: "opentelemetry.proto.trace.v1.ResourceSpans",
                              id: 1,
                            },
                          },
                        },
                        ExportTraceServiceResponse: { fields: {} },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

let root: protobuf.Root | null = null;

export class OtlpProtoDescriptorError extends Error {
  constructor(cause: unknown) {
    super("Failed to initialize OTLP protobuf descriptor.", { cause });
    this.name = "OtlpProtoDescriptorError";
  }
}

export function getOtlpType(name: string): protobuf.Type {
  return getOtlpRoot().lookupType(name);
}

export function getOtlpRequestType(kind: OtlpExportKind): protobuf.Type {
  switch (kind) {
    case OtlpExportKind.Metrics:
      return getOtlpType(
        "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest"
      );
    case OtlpExportKind.Logs:
      return getOtlpType(
        "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"
      );
    case OtlpExportKind.Traces:
      return getOtlpType(
        "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest"
      );
    default:
      return assertNever(kind);
  }
}

export function getOtlpResponseType(kind: OtlpExportKind): protobuf.Type {
  switch (kind) {
    case OtlpExportKind.Metrics:
      return getOtlpType(
        "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse"
      );
    case OtlpExportKind.Logs:
      return getOtlpType(
        "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse"
      );
    case OtlpExportKind.Traces:
      return getOtlpType(
        "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse"
      );
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled OTLP export kind: ${String(value)}`);
}

function getOtlpRoot(): protobuf.Root {
  if (root) {
    return root;
  }
  try {
    root = protobuf.Root.fromJSON(otlpDescriptor);
    return root;
  } catch (error) {
    throw new OtlpProtoDescriptorError(error);
  }
}
